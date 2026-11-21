import assert from "node:assert/strict";
import { test } from "node:test";
import { SteeringRelay, approve, withAntigravityMeta, withToolResults, workingDirectory } from "./agy-stream.ts";
import { homedir, tmpdir } from "node:os";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderModel,
} from "@getpaseo/plugin/server/provider";
import { withModelThinking } from "./catalog.ts";
import {
  SessionListRelay,
  arrangeSessions,
  cliLoadable,
  cliStoredCwds,
  decodeCwd,
  resetSessionListCache,
} from "./session-list.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { wrapConnection } from "./session-wrapper.ts";
import {
  availableModelsSchema,
  googlePoolWindows,
  quotaSummarySchema,
  summaryWindows,
} from "./quota-windows.ts";
import {
  createTitleSyncer,
  extractAgySessionId,
  provisionalTitle,
  readAgyTitle,
} from "./title-sync.ts";
import type { PaseoApi } from "@getpaseo/client";

test("copies the Paseo system prompt into agy's append meta", () => {
  const message = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "session/new",
    params: { cwd: "/tmp", mcpServers: [], _meta: { _paseo: { systemPrompt: "Be brief." } } },
  };
  const result = withAntigravityMeta(message) as typeof message & {
    params: { _meta: { antigravity: { systemPrompt: { append: string } } } };
  };
  assert.equal(result.params._meta.antigravity.systemPrompt.append, "Be brief.");
  assert.deepEqual(result.params._meta._paseo, { systemPrompt: "Be brief." });
  assert.equal((message.params._meta as Record<string, unknown>).antigravity, undefined);
});

test("appends the plugin's own guidance after Paseo's prompt", () => {
  const message = {
    jsonrpc: "2.0" as const,
    id: 4,
    method: "session/load",
    params: { _meta: { _paseo: {} } },
  };
  const result = withAntigravityMeta(message, "Use Paseo agents.") as typeof message & {
    params: { _meta: { antigravity: { systemPrompt: { append: string } } } };
  };
  assert.equal(result.params._meta.antigravity.systemPrompt.append, "Use Paseo agents.");
});

test("leaves prompts and sessions without a system prompt untouched", () => {
  const prompt = { jsonrpc: "2.0" as const, id: 2, method: "session/prompt", params: { _meta: {} } };
  assert.equal(withAntigravityMeta(prompt), prompt);
  const load = { jsonrpc: "2.0" as const, id: 3, method: "session/load", params: { _meta: { _paseo: {} } } };
  assert.equal(withAntigravityMeta(load), load);
});

function fakeInner() {
  const sent: ProviderInput[] = [];
  let listener: (event: ProviderEvent) => void = () => {};
  const connection: ProviderConnection = {
    version: 1,
    capabilities: ["prompt.message", "session.configure"],
    async send(input) {
      sent.push(input);
    },
    onEvent(next) {
      listener = next;
      return () => {};
    },
    async close() {},
  };
  return { connection, sent, fire: (event: ProviderEvent) => listener(event) };
}

function wrapped(extra: { defaultMode?: () => string } = {}) {
  const inner = fakeInner();
  const events: ProviderEvent[] = [];
  const connection = wrapConnection(inner.connection, ["prompt.steer"], {
    modelIds: () => ["gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh", "gpt-oss-120b-medium"],
    env: { ANTIGRAVITY_PLUS: "1" },
    ...extra,
  });
  connection.onEvent((event) => events.push(event));
  return { inner, events, connection };
}

const openInput = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    type: "session.open",
    requestId: "o1",
    sessionId: "s1",
    history: "skip",
    config: { cwd: "/tmp", env: { PASEO_AGENT_ID: "a1" }, mcpServers: {}, settings: {}, persist: true, ...config },
    ...extra,
  }) as unknown as ProviderInput;

const innerConfig = (mode: string) => ({
  type: "session.config" as const,
  sessionId: "s1",
  config: {
    model: "gemini-4-hydrogen",
    mode,
    models: [{ id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" }],
    modes: [{ id: "default", label: "Default" }],
    thinkingOptions: [],
  },
});

test("a new session starts in Default (asks for permission) and keeps Bypass available", async () => {
  const { inner, events, connection } = wrapped();
  await connection.send(openInput({}));
  const sent = inner.sent[0] as Extract<ProviderInput, { type: "session.open" }>;
  assert.equal(sent.config.mode, "default");
  inner.fire(innerConfig("default"));
  const config = events.find((event) => event.type === "session.config") as ReturnType<typeof innerConfig>;
  assert.equal(config.config.mode, "default");
  assert.ok(config.config.modes.some((mode) => mode.id === "bypass"));
  const hydrogen = config.config.models[0] as { thinkingOptions?: Array<{ id: string }> };
  assert.deepEqual(hydrogen.thinkingOptions?.map((option) => option.id), ["high", "xhigh"]);
});

test("explicit Bypass or a user-configured default mode enters Bypass: agy gets Default, Paseo sees Bypass", async () => {
  const explicit = wrapped();
  await explicit.connection.send(openInput({ mode: "bypass" }));
  assert.equal((explicit.inner.sent[0] as Extract<ProviderInput, { type: "session.open" }>).config.mode, "default");
  explicit.inner.fire(innerConfig("default"));
  const explicitConfig = explicit.events.find((event) => event.type === "session.config") as ReturnType<typeof innerConfig>;
  assert.equal(explicitConfig.config.mode, "bypass");

  const configured = wrapped({ defaultMode: () => "bypass" });
  await configured.connection.send(openInput({}));
  assert.equal((configured.inner.sent[0] as Extract<ProviderInput, { type: "session.open" }>).config.mode, "default");
  configured.inner.fire(innerConfig("default"));
  const configuredConfig = configured.events.find((event) => event.type === "session.config") as ReturnType<typeof innerConfig>;
  assert.equal(configuredConfig.config.mode, "bypass");
});

test("a resumed session keeps agy's mode, and agy leaving Default ends Bypass", async () => {
  const { inner, events, connection } = wrapped();
  await connection.send(openInput({}, { persistence: { version: 1, data: { sessionId: "c1" } } }));
  assert.equal((inner.sent[0] as Extract<ProviderInput, { type: "session.open" }>).config.mode, undefined);
  inner.fire(innerConfig("plan"));
  const config = events.at(-1) as ReturnType<typeof innerConfig>;
  assert.equal(config.config.mode, "plan");
});

test("the retired agy subagents option is dropped and no switch is offered", async () => {
  const { inner, events, connection } = wrapped();
  await connection.send(openInput({ providerOptions: { agySubagents: false }, settings: { agySubagents: false } }));
  const sent = inner.sent[0] as Extract<ProviderInput, { type: "session.open" }>;
  assert.deepEqual(sent.config.providerOptions, {});
  assert.deepEqual(sent.config.settings, {});
  inner.fire({ type: "session.ready", requestId: "o1", sessionId: "s1" } as ProviderEvent);
  inner.fire(innerConfig("default"));
  const config = events.at(-1) as ReturnType<typeof innerConfig> & { config: { controls?: unknown[] } };
  assert.equal(config.config.controls, undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // A configure carrying only the retired option is answered here, nothing forwarded.
  await connection.send({
    type: "session.configure",
    requestId: "c1",
    sessionId: "s1",
    changes: { providerOptions: { agySubagents: true } },
  } as ProviderInput);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(inner.sent.length, 1);
  assert.equal(events.at(-1)?.type, "request.completed");
});

test("switching to Bypass sends Default to agy and rolls back if the adapter fails", async () => {
  const { inner, events, connection } = wrapped();
  await connection.send(openInput({ mode: "plan" }));
  inner.fire({ type: "session.ready", requestId: "o1", sessionId: "s1" } as ProviderEvent);
  inner.fire(innerConfig("plan"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await connection.send({
    type: "session.configure",
    requestId: "c2",
    sessionId: "s1",
    changes: { mode: "bypass" },
  } as ProviderInput);
  const forwarded = inner.sent.at(-1) as Extract<ProviderInput, { type: "session.configure" }>;
  assert.equal(forwarded.changes.mode, "default");
  inner.fire({ type: "request.failed", requestId: "c2", error: { message: "nope" } } as ProviderEvent);
  const config = events.at(-2) as ReturnType<typeof innerConfig>;
  assert.equal(config.config.mode, "plan");
});

test("Bypass answers permission requests with allow once", () => {
  const answer = approve({
    jsonrpc: "2.0",
    id: 9,
    method: "session/request_permission",
    params: {
      options: [
        { optionId: "always", kind: "allow_always" },
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    },
  });
  assert.deepEqual(answer, { jsonrpc: "2.0", id: 9, result: { outcome: { outcome: "selected", optionId: "allow" } } });
});

test("models without effort variants get no thinking levels", () => {
  const input: ProviderModel[] = [
    { id: "gemini-4-hydrogen", label: "H" },
    { id: "gpt-oss-120b-medium", label: "G" },
  ];
  const models = withModelThinking(
    input,
    ["gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-xhigh", "gpt-oss-120b-medium"],
  );
  assert.deepEqual(models[0].thinkingOptions?.map((option) => option.id), ["low", "medium", "xhigh"]);
  assert.equal(models[0].defaultThinkingOptionId, "medium");
  assert.deepEqual(models[1].thinkingOptions, []);
});

const summary = quotaSummarySchema.parse({
  groups: [
    {
      displayName: "Claude and GPT models",
      buckets: [
        {
          bucketId: "3p-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          resetTime: "2026-11-18T06:25:56Z",
          remainingFraction: 0.835116,
        },
        {
          bucketId: "3p-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          resetTime: "2026-11-17T12:44:53Z",
          remainingFraction: 1,
        },
      ],
    },
  ],
});

test("maps the quota summary to weekly and five-hour windows", () => {
  const windows = summaryWindows(summary);
  assert.deepEqual(
    windows.map((window) => [window.id, window.label, window.shortLabel]),
    [
      ["group-3p:weekly", "Claude and GPT · Weekly", "Claude and GPT wk"],
      ["group-3p:five_hour", "Claude and GPT · 5-hour", "Claude and GPT 5h"],
    ],
  );
  assert.equal(windows[0].usedPct, 16.5);
  assert.equal(windows[1].usedPct, 0);
  assert.equal(windows[0].resetsAt, "2026-11-18T06:25:56Z");
});

test("publishes one neutral window for the shared Google model pool", () => {
  const models = availableModelsSchema.parse({
    models: {
      "gemini-4-hydrogen-sonar": {
        modelProvider: "MODEL_PROVIDER_GOOGLE",
        quotaInfo: { remainingFraction: 0.93359333, resetTime: "2026-11-17T11:05:18Z" },
      },
      "gemini-3.8-flash-tiered": {
        modelProvider: "MODEL_PROVIDER_GOOGLE",
        quotaInfo: { remainingFraction: 0.93359333, resetTime: "2026-11-17T11:05:18Z" },
      },
      chat_20706: { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 1 } },
      "claude-opus-5-5-high": {
        modelProvider: "MODEL_PROVIDER_ANTHROPIC",
        quotaInfo: { remainingFraction: 1, resetTime: "2026-11-17T12:45:46Z" },
      },
    },
  });
  const windows = googlePoolWindows(models, summary);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, "google-models");
  assert.equal(windows[0].label, "Gemini");
  assert.equal(windows[0].usedPct, 6.6);
});

test("maps Gemini, Claude/GPT, and Gemini 4 Argon groups when all are in the quota summary", () => {
  const fullSummary = quotaSummarySchema.parse({
    groups: [
      {
        displayName: "Gemini Models",
        description: "Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon), Gemini 3.8 Flash",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            resetTime: "2026-11-25T00:21:52Z",
            remainingFraction: 0.893,
          },
          {
            bucketId: "gemini-5h",
            displayName: "Five Hour Limit Remaining",
            window: "5h",
            resetTime: "2026-11-19T04:42:41Z",
            remainingFraction: 0.933,
          },
        ],
      },
      ...summary.groups,
      {
        displayName: "Gemini 4 Argon",
        description: "For paid Pro plans, Argon quota is separate.",
        buckets: [
          {
            bucketId: "gemini-argon-wtu-weekly",
            displayName: "Gemini 4 Argon Weekly Limit",
            window: "weekly",
            resetTime: "2026-11-24T23:34:14Z",
            remainingFraction: 0.336,
          },
        ],
      },
    ],
  });
  const windows = summaryWindows(fullSummary);
  assert.deepEqual(
    windows.map((window) => [window.id, window.label, window.shortLabel, window.usedPct]),
    [
      ["group-gemini:weekly", "Gemini · Weekly", "Gemini wk", 10.7],
      ["group-gemini:five_hour", "Gemini · 5-hour", "Gemini 5h", 6.7],
      ["group-3p:weekly", "Claude and GPT · Weekly", "Claude and GPT wk", 16.5],
      ["group-3p:five_hour", "Claude and GPT · 5-hour", "Claude and GPT 5h", 0],
      ["group-gemini-argon-wtu:weekly", "Gemini 4 Argon · Weekly", "Gemini 4 Argon wk", 66.4],
    ],
  );
  const models = availableModelsSchema.parse({
    models: {
      "gemini-4-neon-high": {
        modelProvider: "MODEL_PROVIDER_GOOGLE",
        quotaInfo: { remainingFraction: 0.933, resetTime: "2026-11-19T04:42:41Z" },
      },
    },
  });
  assert.deepEqual(googlePoolWindows(models, fullSummary), []);
});

const promptA = {
  jsonrpc: "2.0" as const,
  id: 7,
  method: "session/prompt",
  params: { sessionId: "native-1", prompt: [{ type: "text", text: "count" }] },
};
const answer = (id: string | number, stopReason: string) => ({
  jsonrpc: "2.0" as const,
  id,
  result: { stopReason },
});

test("a steer holds agy's early answer and releases it with the steered outcome", () => {
  const relay = new SteeringRelay();
  relay.outgoing(promptA);
  const injected = relay.steer([{ type: "text", text: "also say BANANA" }]);
  assert.ok(injected && "id" in injected && "params" in injected);
  assert.deepEqual((injected.params as { sessionId: string }).sessionId, "native-1");
  // agy answers the original prompt as soon as the steer arrives: withheld.
  assert.deepEqual(relay.incoming(answer(7, "end_turn")), []);
  // Notifications keep flowing.
  const update = { jsonrpc: "2.0" as const, method: "session/update", params: {} };
  assert.deepEqual(relay.incoming(update), [update]);
  // The steered prompt finishes: the adapter sees its own prompt end with that outcome.
  assert.deepEqual(relay.incoming(answer(injected.id as string, "end_turn")), [answer(7, "end_turn")]);
  assert.equal(relay.steer([{ type: "text", text: "late" }]), null);
});

test("a second steer supersedes the first, and a cancel ends the turn as canceled", () => {
  const relay = new SteeringRelay();
  relay.outgoing(promptA);
  const first = relay.steer([{ type: "text", text: "one" }])!;
  assert.deepEqual(relay.incoming(answer(7, "end_turn")), []);
  const second = relay.steer([{ type: "text", text: "two" }])!;
  assert.deepEqual(relay.incoming(answer(first.id as string, "end_turn")), []);
  assert.deepEqual(relay.incoming(answer(second.id as string, "cancelled")), [answer(7, "cancelled")]);
});

test("if the steered prompt finishes before agy answers the original, the late answer is dropped", () => {
  const relay = new SteeringRelay();
  relay.outgoing(promptA);
  const injected = relay.steer([{ type: "text", text: "x" }])!;
  assert.deepEqual(relay.incoming(answer(injected.id as string, "end_turn")), [answer(7, "end_turn")]);
  assert.deepEqual(relay.incoming(answer(7, "end_turn")), []);
});

test("a rejected steer lets the original prompt finish on its own", () => {
  const relay = new SteeringRelay();
  relay.outgoing(promptA);
  const injected = relay.steer([{ type: "text", text: "x" }])!;
  const rejected = { jsonrpc: "2.0" as const, id: injected.id, error: { code: -32000, message: "busy" } };
  assert.deepEqual(relay.incoming(rejected), []);
  assert.deepEqual(relay.incoming(answer(7, "end_turn")), [answer(7, "end_turn")]);
});

test("copies agy tool content into rawOutput and edit diffs into the adapter's edit fields", () => {
  const command = withToolResults({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        kind: "execute",
        rawInput: { CommandLine: "echo hi" },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Created At: 2026-11-17T16:04:24+08:00\nCompleted At: 2026-11-17T16:04:24+08:00\nCommand exited with code 0.\n\nCommand output:\nhi\r\n",
            },
          },
        ],
      },
    },
  }) as { params: { update: { rawOutput: string } } };
  assert.equal(command.params.update.rawOutput, "Command exited with code 0.\n\nCommand output:\nhi\r\n");
  const edit = withToolResults({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        kind: "edit",
        rawInput: { Path: "/tmp/notes.txt", Target: "beta world", Replacement: "beta updated" },
        content: [
          { type: "diff", path: "/tmp/notes.txt", oldText: "a\nbeta world\n", newText: "a\nbeta updated\n" },
        ],
      },
    },
  }) as { params: { update: { rawInput: Record<string, string> } } };
  assert.equal(edit.params.update.rawInput.filePath, "/tmp/notes.txt");
  assert.equal(edit.params.update.rawInput.oldString, "a\nbeta world\n");
  assert.equal(edit.params.update.rawInput.newString, "a\nbeta updated\n");
  assert.equal(edit.params.update.rawInput.Target, "beta world");
});

test("before agy listed its models, an open with a thinking level asks for the list first", async () => {
  const inner = fakeInner();
  let ids: string[] = [];
  const seen: ProviderEvent[] = [];
  const connection = wrapConnection(inner.connection, [], {
    modelIds: () => ids,
  });
  connection.onEvent((event) => seen.push(event));
  const opened = connection.send(openInput({ model: "gpt-oss-120b-medium", thinkingOption: "medium" }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const catalog = inner.sent[0] as Extract<ProviderInput, { type: "catalog" }>;
  assert.equal(catalog.type, "catalog");
  ids = ["gpt-oss-120b-medium", "gemini-4-hydrogen-high"];
  inner.fire({ type: "catalog", requestId: catalog.requestId, catalog: { models: [], modes: [] } } as ProviderEvent);
  await opened;
  const open = inner.sent[1] as Extract<ProviderInput, { type: "session.open" }>;
  assert.equal(open.config.thinkingOption, undefined);
  assert.equal(seen.length, 0, "the private catalog answer is not forwarded");
});

test("Bypass never picks an always option and leaves such requests to Paseo", () => {
  const request = {
    jsonrpc: "2.0" as const,
    id: 3,
    method: "session/request_permission",
    params: { options: [{ optionId: "always", kind: "allow_always" }, { optionId: "deny", kind: "reject_once" }] },
  };
  assert.equal(approve(request), null);
});

test("a model list without effort variants keeps levels unknown instead of empty", () => {
  const input: ProviderModel[] = [{ id: "gemini-4-hydrogen", label: "H" }];
  assert.deepEqual(withModelThinking(input, ["gemini-4-hydrogen", "gemini-4-argon"]), input);
});

test("a failed open drops its session state", async () => {
  const { inner, events, connection } = wrapped();
  await connection.send(openInput({}));
  inner.fire({ type: "request.failed", requestId: "o1", error: { message: "boom" } } as ProviderEvent);
  inner.fire(innerConfig("default"));
  const config = events.at(-1) as ReturnType<typeof innerConfig>;
  // No state left: the config passes through without the Bypass presentation.
  assert.equal(config.config.mode, "default");
});

const kb = "/Users/dev/kb";
const noRealpath = () => [];
/** No real filesystem: every session loadable, no realpaths, no stored cwds. */
const plain = { resolve: noRealpath, loadable: () => true, storedCwds: () => [], windowsPaths: false };
const listed = [
  { sessionId: "old", cwd: kb, updatedAt: "2026-11-01T00:00:00Z" },
  { sessionId: "sub", cwd: `${kb}/notes`, updatedAt: "2026-11-17T12:00:00Z" },
  { sessionId: "elsewhere", cwd: "/Users/dev/games", updatedAt: "2026-11-17T13:00:00Z" },
  { sessionId: "undated", cwd: `${kb}/` },
  { sessionId: "acp-new", cwd: kb, updatedAt: "2026-11-17T11:10:24Z" },
  { sessionId: "encoded", cwd: "/Users/dev/%E5%AD%A6%E4%B9%A0", updatedAt: "2026-11-16T00:00:00Z" },
];

test("session list keeps the requested directory only, newest first, undated last", () => {
  const sessions = arrangeSessions(listed, kb, plain);
  assert.deepEqual(sessions.map((session) => session.sessionId), ["acp-new", "old", "undated"]);
  assert.ok(sessions.every((session) => session.cwd === kb), "kept sessions report the requested cwd");
});

test("percent-encoded and file: cwds are decoded so non-ASCII directories match", () => {
  assert.equal(decodeCwd("/Users/dev/%E5%AD%A6%E4%B9%A0/%E7%AC%94%E8%AE%B0"), "/Users/dev/学习/笔记");
  assert.equal(decodeCwd("file:///Users/dev/a%20b", false), "/Users/dev/a b");
  assert.equal(decodeCwd("/Users/dev/100%"), "/Users/dev/100%");
  const sessions = arrangeSessions(listed, "/Users/dev/学习", plain);
  assert.deepEqual(sessions.map((session) => session.sessionId), ["encoded"]);
});

test("Windows session paths normalize drive URIs, slashes and case", () => {
  const requested = "C:\\DEV\\学习 资料";
  const sessions = [
    { sessionId: "drive", cwd: "file:///c:/dev/%E5%AD%A6%E4%B9%A0%20%E8%B5%84%E6%96%99" },
    { sessionId: "escaped-drive", cwd: "file:///C%3A/dev/%E5%AD%A6%E4%B9%A0%20%E8%B5%84%E6%96%99" },
    { sessionId: "drive-path", cwd: "c:/dev/学习 资料/" },
    { sessionId: "drive-uri-path", cwd: "/c%3A/dev/学习%20资料" },
    { sessionId: "child", cwd: "C:\\Dev\\学习 资料\\child" },
    { sessionId: "other-drive", cwd: "D:\\Dev\\学习 资料" },
  ];
  const matched = arrangeSessions(sessions, requested, { ...plain, windowsPaths: true });
  assert.deepEqual(matched.map(session => session.sessionId), ["drive", "escaped-drive", "drive-path", "drive-uri-path"]);
  assert.ok(matched.every(session => session.cwd === requested));
  const unscoped = arrangeSessions(sessions, null, { ...plain, windowsPaths: true });
  assert.equal(unscoped.find(session => session.sessionId === "drive-uri-path")?.cwd, "c:\\dev\\学习 资料");
});

test("Windows session paths match UNC shares and stored secondary roots", () => {
  const requested = "\\\\Server\\Share\\Project";
  const sessions = [
    { sessionId: "network", cwd: "file://server/share/project/" },
    { sessionId: "multi-root", cwd: "C:\\" },
    { sessionId: "placeholder", cwd: "C:/CACHE/" },
  ];
  const options = {
    ...plain, windowsPaths: true, placeholderCwd: "c:\\cache",
    storedCwds: () => ["C:\\", "\\\\SERVER\\SHARE\\project"],
  };
  const matched = arrangeSessions(sessions, requested, options);
  assert.deepEqual(matched.map(session => session.sessionId), ["network", "multi-root"]);
  const all = arrangeSessions(sessions, null, options);
  assert.equal(all.find(session => session.sessionId === "multi-root")?.cwd, "\\\\SERVER\\SHARE\\project");
});

test("realpath variants match like the daemon's matcher", () => {
  const resolve = (value: string) => (value === "/link/kb" ? ["/Users/dev/kb"] : []);
  const sessions = arrangeSessions(listed, "/link/kb", { resolve, loadable: () => true });
  assert.deepEqual(sessions.map((session) => session.sessionId), ["acp-new", "old", "undated"]);
  assert.equal(sessions[0].cwd, "/link/kb");
});

test("without a requested cwd every session comes back decoded and sorted", () => {
  const sessions = arrangeSessions(listed, null, plain);
  assert.equal(sessions.length, listed.length);
  assert.equal(sessions[0].sessionId, "elsewhere");
  assert.equal(sessions.at(-1)?.sessionId, "undated");
  assert.equal(sessions.find((session) => session.sessionId === "encoded")?.cwd, "/Users/dev/学习");
});

test("the list relay follows cursors and answers the adapter once with every page", () => {
  resetSessionListCache();
  const relay = new SessionListRelay(plain);
  relay.outgoing({ jsonrpc: "2.0", id: 5, method: "session/list", params: { cwd: kb } });
  const first = relay.incoming({
    jsonrpc: "2.0",
    id: 5,
    result: { sessions: [listed[0]], nextCursor: "page-2" },
  });
  assert.equal(first?.deliver.length, 0);
  const follow = first?.send[0] as { id: string; params: { cwd: string; cursor: string } };
  assert.deepEqual(follow.params, { cwd: kb, cursor: "page-2" });
  const second = relay.incoming({ jsonrpc: "2.0", id: follow.id, result: { sessions: [listed[4]], nextCursor: null } });
  const answer = second?.deliver[0] as { id: number; result: { sessions: Array<{ sessionId: string }>; nextCursor: null } };
  assert.equal(answer.id, 5);
  assert.deepEqual(answer.result.sessions.map((session) => session.sessionId), ["acp-new", "old"]);
  assert.equal(answer.result.nextCursor, null);
  assert.equal(relay.incoming({ jsonrpc: "2.0", id: 99, result: {} }), null, "untracked answers pass through");
});

test("a failed first page reaches the adapter unchanged", () => {
  resetSessionListCache();
  const relay = new SessionListRelay(plain);
  relay.outgoing({ jsonrpc: "2.0", id: 6, method: "session/list", params: {} });
  const error = { jsonrpc: "2.0" as const, id: 6, error: { code: -32000, message: "nope" } };
  assert.deepEqual(relay.incoming(error)?.deliver, [error]);
});

test("agy runs in the session's directory, or home when it is missing, never in /", () => {
  assert.equal(workingDirectory(tmpdir()), tmpdir());
  assert.equal(workingDirectory("/definitely/not/here"), homedir());
  assert.equal(workingDirectory(undefined), homedir());
});

test("sessions agy reports in the listing directory have no known directory", () => {
  const placeholder = "/tmp/agp-list";
  const sessions = [
    { sessionId: "real", cwd: kb, updatedAt: "2026-11-17T10:00:00Z" },
    { sessionId: "unknown", cwd: placeholder, updatedAt: "2026-11-17T11:00:00Z" },
  ];
  assert.deepEqual(
    arrangeSessions(sessions, kb, { ...plain, placeholderCwd: placeholder }).map((session) => session.sessionId),
    ["real"],
  );
  assert.deepEqual(arrangeSessions(sessions, placeholder, { ...plain, placeholderCwd: placeholder }), []);
  const all = arrangeSessions(sessions, null, { ...plain, placeholderCwd: placeholder });
  assert.equal(all.find((session) => session.sessionId === "unknown")?.cwd, homedir());
});

test("only conversations agy CLI can load are listed; desktop app ones are hidden", () => {
  const store = mkdtempSync(join(tmpdir(), "agp-store-"));
  writeFileSync(join(store, "cli-1.db"), "");
  const loadable = cliLoadable(store);
  assert.equal(loadable("cli-1"), true);
  assert.equal(loadable("app-1"), false);
  assert.equal(cliLoadable(join(store, "missing"))("app-1"), true, "unknown store layout keeps everything");
  const sessions = [
    { sessionId: "cli-1", cwd: kb, updatedAt: "2026-11-17T10:00:00Z" },
    { sessionId: "app-1", cwd: kb, updatedAt: "2026-11-17T11:00:00Z" },
  ];
  assert.deepEqual(arrangeSessions(sessions, kb, { resolve: noRealpath, loadable }).map((session) => session.sessionId), ["cli-1"]);
});

test("the shared list snapshot answers later requests, refreshing in the background when stale", () => {
  resetSessionListCache();
  let now = 1_000_000;
  let refreshes = 0;
  const options = { ...plain, now: () => now, refresh: () => void (refreshes += 1) };
  const first = new SessionListRelay(options);
  assert.equal(first.outgoing({ jsonrpc: "2.0", id: 1, method: "session/list", params: { cwd: kb } }), null, "nothing cached: ask agy");
  first.incoming({ jsonrpc: "2.0", id: 1, result: { sessions: listed } });
  const fresh = new SessionListRelay(options).outgoing({ jsonrpc: "2.0", id: 2, method: "session/list", params: { cwd: kb } }) as {
    id: number;
    result: { sessions: Array<{ sessionId: string }> };
  };
  assert.equal(fresh.id, 2);
  assert.deepEqual(fresh.result.sessions.map((session) => session.sessionId), ["acp-new", "old", "undated"]);
  assert.equal(refreshes, 0);
  now += 5 * 60_000;
  assert.ok(new SessionListRelay(options).outgoing({ jsonrpc: "2.0", id: 3, method: "session/list", params: {} }));
  assert.equal(refreshes, 1, "stale: answered from memory and refreshed");
  now += 30 * 60_000;
  assert.equal(new SessionListRelay(options).outgoing({ jsonrpc: "2.0", id: 4, method: "session/list", params: {} }), null, "too old: ask agy");
  resetSessionListCache();
});

test("multi-root and legacy '/' conversations match their stored workspace_uris", () => {
  const dir = mkdtempSync(join(tmpdir(), "agp-summaries-"));
  const dbPath = join(dir, "conversation_summaries.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)");
    insert.run("legacy-root", JSON.stringify(["file:///", "file:///Users/dev/kb"]));
    insert.run("legacy-encoded", JSON.stringify(["file:///", "file:///Users/dev/%E5%AD%A6%E4%B9%A0"]));
    insert.run("multi-root", JSON.stringify(["file:///Users/dev/other", "file:///Users/dev/kb"]));
    insert.run("single-root", JSON.stringify(["file:///"]));
    insert.run("broken-json", "not,json");
    db.close();

    const storedCwds = cliStoredCwds(dbPath, false);
    assert.deepEqual(storedCwds("legacy-root"), ["/", "/Users/dev/kb"]);
    assert.deepEqual(storedCwds("legacy-encoded"), ["/", "/Users/dev/学习"]);
    assert.deepEqual(storedCwds("single-root"), []);
    assert.deepEqual(storedCwds("broken-json"), []);
    assert.deepEqual(cliStoredCwds(join(dir, "missing.db"))("legacy-root"), []);

    const sessions = [
      { sessionId: "legacy-root", cwd: "/", updatedAt: "2026-11-19T00:01:00Z" },
      { sessionId: "legacy-encoded", cwd: "/", updatedAt: "2026-11-18T12:00:00Z" },
      { sessionId: "multi-root", cwd: "/Users/dev/other", updatedAt: "2026-11-18T10:00:00Z" },
      { sessionId: "single-root", cwd: "/", updatedAt: "2026-11-18T08:00:00Z" },
    ];
    const options = { ...plain, storedCwds };
    const forKb = arrangeSessions(sessions, kb, options);
    assert.deepEqual(forKb.map((session) => session.sessionId), ["legacy-root", "multi-root"]);
    assert.ok(forKb.every((session) => session.cwd === kb));

    const forEncoded = arrangeSessions(sessions, "/Users/dev/学习", options);
    assert.deepEqual(forEncoded.map((session) => session.sessionId), ["legacy-encoded"]);

    const all = arrangeSessions(sessions, null, options);
    assert.equal(all.find((session) => session.sessionId === "legacy-root")?.cwd, kb);
    assert.equal(all.find((session) => session.sessionId === "legacy-encoded")?.cwd, "/Users/dev/学习");
    assert.equal(all.find((session) => session.sessionId === "single-root")?.cwd, "/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extractAgySessionId, provisionalTitle and readAgyTitle parse agy metadata", () => {
  assert.equal(
    extractAgySessionId('plugin:{"version":1,"data":{"sessionId":"980b56eb-cfb1-4bbb-b37a-e8b0210fcb89"}}'),
    "980b56eb-cfb1-4bbb-b37a-e8b0210fcb89",
  );
  assert.equal(extractAgySessionId("abc-123"), "abc-123");
  assert.equal(extractAgySessionId("plugin:not-json"), null);
  assert.equal(extractAgySessionId(""), null);

  assert.equal(
    provisionalTitle("\n  Hello   world\nsecond line"),
    "Hello world",
  );
  assert.equal(
    provisionalTitle("a".repeat(80)),
    "a".repeat(60),
  );

  const dir = mkdtempSync(join(tmpdir(), "agp-title-"));
  const dbPath = join(dir, "conversation_summaries.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)");
    insert.run("s-titled", "  Antigravity Plus\n  插件验收评审  ");
    insert.run("s-empty", "   ");
    db.close();

    assert.equal(readAgyTitle("s-titled", dbPath), "Antigravity Plus 插件验收评审");
    assert.equal(readAgyTitle("s-empty", dbPath), null);
    assert.equal(readAgyTitle("s-missing", dbPath), null);
    assert.equal(readAgyTitle("s-titled", join(dir, "missing.db")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakePaseoForTitle(state: {
  title: string | null;
  firstPrompt: string;
  sessionId?: string | null;
  workspaceName?: string | null;
}) {
  const workspaceTitles: string[] = [];
  const api = {
    agents: {
      ref() {
        return {
          async refresh() {
            return {
              agent: {
                title: state.title,
                workspaceId: state.workspaceName === undefined ? null : "wks_1",
                runtimeInfo:
                  state.sessionId === undefined
                    ? { sessionId: 'plugin:{"version":1,"data":{"sessionId":"agy-uuid-1"}}' }
                    : state.sessionId
                      ? { sessionId: state.sessionId }
                      : null,
              },
            };
          },
          timeline: {
            async refetch() {
              return {
                entries: [{ item: { type: "user_message", text: state.firstPrompt } }],
                hasNewer: false,
                endCursor: null,
              };
            },
          },
        };
      },
    },
    workspaces: {
      ref() {
        return {
          async refresh() {
            return { name: state.workspaceName ?? null };
          },
          async setTitle(next: string) {
            workspaceTitles.push(next);
            state.workspaceName = next;
            return { title: next };
          },
        };
      },
    },
  } as unknown as PaseoApi;
  return { api, workspaceTitles };
}

test("title sync replaces Paseo's provisional title with agy's generated title once ready", async () => {
  const firstPrompt = "帮我查一下这个历史会话为什么在导入列表里面找不到，顺便检查一下是不是目录过滤引起的";
  const provisional = provisionalTitle(firstPrompt)!;
  const state = { title: provisional, firstPrompt, workspaceName: provisional };
  const { api, workspaceTitles } = fakePaseoForTitle(state);
  const renames: Array<{ agentId: string; title: string }> = [];
  let reads = 0;
  const syncer = createTitleSyncer({
    retryDelaysMs: [0, 1, 1],
    delay: async () => true,
    readTitle(sessionId) {
      assert.equal(sessionId, "agy-uuid-1");
      reads += 1;
      return reads < 2 ? null : "历史会话导入排查";
    },
    async rename(agentId, title) {
      renames.push({ agentId, title });
      state.title = title;
      return true;
    },
  });

  const agent = { id: "a1", provider: "antigravity-plus", background: false };
  assert.equal(await syncer.sync(agent, api), true);
  assert.deepEqual(renames, [{ agentId: "a1", title: "历史会话导入排查" }]);
  assert.deepEqual(workspaceTitles, ["历史会话导入排查"]);
  assert.equal(await syncer.sync(agent, api), false, "already synced once");
});

test("title sync never overwrites explicit, user-edited, or mid-wait renamed titles", async () => {
  const custom = fakePaseoForTitle({
    title: "[Advisor] Antigravity+ 项目验收",
    firstPrompt: "请验收一下当前插件",
  });
  let renameCalls = 0;
  const syncer = createTitleSyncer({
    retryDelaysMs: [0],
    delay: async () => true,
    readTitle: () => "Antigravity Plus 插件验收评审",
    async rename() {
      renameCalls += 1;
      return true;
    },
  });
  assert.equal(
    await syncer.sync({ id: "a-custom", provider: "antigravity-plus", background: false }, custom.api),
    false,
  );
  assert.equal(
    await syncer.sync({ id: "a-other", provider: "claude", background: false }, custom.api),
    false,
  );
  assert.equal(
    await syncer.sync({ id: "a-bg", provider: "antigravity-plus", background: true }, custom.api),
    false,
  );

  // User renames the agent while we are waiting for agy to finish summarizing.
  const prompt = "检查一下配置文件";
  const racingState = { title: provisionalTitle(prompt), firstPrompt: prompt };
  const racing = fakePaseoForTitle(racingState);
  let racingReads = 0;
  const racingSyncer = createTitleSyncer({
    retryDelaysMs: [0, 1],
    delay: async (ms) => {
      if (ms > 0) racingState.title = "用户手动改的标题";
      return true;
    },
    readTitle: () => (++racingReads < 2 ? null : "配置文件检查"),
    async rename() {
      renameCalls += 1;
      return true;
    },
  });
  assert.equal(
    await racingSyncer.sync({ id: "a-race", provider: "antigravity-plus", background: false }, racing.api),
    false,
  );
  assert.equal(renameCalls, 0);
});
