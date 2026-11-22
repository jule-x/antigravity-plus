import type { AcpContext, AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";
import type { ProviderCommand, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const shellInput = z.object({ CommandLine: z.string() });
const shellOutput = z.object({
  output: z.string().optional(),
  exit_code: z.number().nullable().optional(),
});
const fileRead = z.object({
  Path: z.string().optional(),
  StartLine: z.number().int().positive().optional(),
  EndLine: z.number().int().positive().optional(),
});
const fileWrite = z.object({ Path: z.string(), Content: z.string().optional() });
const webSearch = z.object({ query: z.string() });

/** agy advertises built-in slash commands and invocable skills together in one ACP list. */
const BUILT_IN_COMMANDS = new Set([
  "goal",
  "compact",
  "schedule",
  "browser",
  "plan",
  "grill-me",
  "teamwork",
  "learn",
  "boost",
]);

export type ClassifiedCommand = ProviderCommand & { kind?: "command" | "skill" };

export function classifyCommand(command: ProviderCommand): ClassifiedCommand {
  return { ...command, kind: BUILT_IN_COMMANDS.has(command.name) ? "command" : "skill" };
}

/** Non-daemon background tools (e.g. `run_command` with `IsDaemon !== true`) keep the turn open on Paseo 0.17.1+. */
export function keepsTurnOpen(toolCall: AcpToolCallSnapshot): boolean {
  const input = toolCall.input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return (input as Record<string, unknown>).IsDaemon !== true;
  }
  return true;
}

export type DetailedToolCallSnapshot = AcpToolCallSnapshot & { detail?: ProviderToolCallDetail };
export type ToolCallContext = AcpContext & { mcpServerNames?: readonly string[] };

export function mapToolCall(
  call: DetailedToolCallSnapshot,
  context: ToolCallContext,
): DetailedToolCallSnapshot {
  if (call.name?.startsWith("mcp_")) {
    return mapMcpCall(call, call.name, context.mcpServerNames ?? []);
  }
  const detail = mapNativeDetail(call);
  return detail ? { ...call, detail } : call;
}

function mapNativeDetail(call: AcpToolCallSnapshot): ProviderToolCallDetail | undefined {
  switch (call.name) {
    case "run_command": {
      const input = shellInput.safeParse(call.input).data;
      if (!input) break;
      const parsed = shellOutput.safeParse(call.output).data;
      const output = parsed?.output ?? (typeof call.output === "string" ? call.output : undefined);
      return {
        type: "shell",
        command: input.CommandLine,
        output,
        exitCode: parsed?.exit_code,
      };
    }
    case "write_file": {
      const input = fileWrite.safeParse(call.input).data;
      if (input) return { type: "write", filePath: input.Path, content: input.Content };
      break;
    }
    case "search_web": {
      const input = webSearch.safeParse(call.input).data;
      if (input) return { type: "search", toolName: "web_search", query: input.query };
      break;
    }
  }
  if (call.kind !== "read") return undefined;
  const input = fileRead.safeParse(call.input).data;
  const filePath = call.locations[0] ?? input?.Path;
  if (!filePath) return undefined;
  const { StartLine: offset, EndLine: end } = input ?? {};
  return {
    type: "read",
    filePath,
    ...(typeof call.output === "string" ? { content: call.output } : {}),
    offset,
    limit:
      offset !== undefined && end !== undefined && end >= offset ? end - offset + 1 : undefined,
  };
}

function mapMcpCall(
  call: DetailedToolCallSnapshot,
  wireName: string,
  serverNames: readonly string[],
): DetailedToolCallSnapshot {
  const qualifiedName = wireName.slice("mcp_".length);
  // The wire uses the same separator inside names and between the server and tool.
  // Paseo's own server can also appear when replaying with MCP disabled.
  const matchingServers = [...new Set([...serverNames, "paseo"])].filter((name) =>
    qualifiedName.startsWith(`${name}_`),
  );
  const server = matchingServers.length === 1 ? matchingServers[0] : undefined;
  let input = call.input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const { toolSummary: _summary, ...args } = input as Record<string, unknown>;
    input = args as AcpToolCallSnapshot["input"];
  }
  return {
    ...call,
    name: server ? `${server}.${qualifiedName.slice(server.length + 1)}` : wireName,
    detail: { type: "unknown", input, output: call.output },
  };
}
