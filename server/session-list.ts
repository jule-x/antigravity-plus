import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

/**
 * Paseo's Import session dialog reads agy's `session/list` through the ACP adapter, which keeps
 * the first `limit` entries in agy's order. The daemon then keeps sessions whose cwd equals the
 * dialog's directory and sorts what is left. agy 1.5.10 breaks that in three ways (measured on
 * 466 sessions):
 * - it ignores `params.cwd` and returns every conversation;
 * - its order is not by recency: sessions created over ACP come after hundreds of older ones,
 *   so the adapter's cut drops every Antigravity+ conversation;
 * - it percent-encodes non-ASCII paths (`.../%E5%AD%A6%E4%B9%A0`), so they never equal the
 *   directory the daemon compares against.
 * - conversations stored without a directory are reported in the listing process's own working
 *   directory, so a listing run in the requested directory would claim them all;
 * - it also lists conversations of the Antigravity desktop app, which only the app can load:
 *   `session/load` waits two seconds and opens an empty session.
 * A listing also costs 3 to 4 seconds, because a new agy process signs in and fetches its
 * configuration from Google before it answers. agy returns the same full list for any directory,
 * so the plugin keeps one snapshot for every request and refreshes it in the background.
 * This layer answers the adapter with the requested directory's sessions only, decoded and
 * newest first, after collecting every page agy offers. Listings run in LIST_CWD, an empty
 * directory of this plugin, and a session reported there has no known directory.
 */

export const LIST_CWD = path.join(tmpdir(), "antigravity-plus", "session-list");

/** Creates LIST_CWD on demand and returns it. */
export function listWorkingDirectory(): string {
  try {
    mkdirSync(LIST_CWD, { recursive: true });
    return LIST_CWD;
  } catch {
    return homedir();
  }
}

type JsonObject = Record<string, unknown>;
type MessageId = string | number;

/** JSON-RPC ids of follow-up page requests; the adapter never sees their responses. */
const PAGE_ID_PREFIX = "antigravity-plus-list-page-";
/** Stop following cursors after this many pages; agy 1.5.10 sends everything in one. */
const MAX_PAGES = 50;
const WINDOWS_PATHS = process.platform === "win32";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** agy reports `file:` URIs as percent-encoded paths; turn either form into a plain path. */
export function decodeCwd(value: string, windows = WINDOWS_PATHS): string {
  if (value.startsWith("file:")) {
    if (windows && value === "file:///") return "/";
    try {
      return fileURLToPath(value, { windows });
    } catch {
      return value;
    }
  }
  let decoded = value;
  if (value.includes("%")) {
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  if (windows) {
    const absolute = decoded.replace(/^[\\/](?=[a-z]:[\\/])/i, "");
    if (/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(absolute)) return path.win32.normalize(absolute);
  }
  return decoded;
}

function normalize(value: string, windows: boolean): string {
  if (windows) {
    const normalized = path.win32.normalize(value).toLowerCase();
    return normalized === path.win32.parse(normalized).root ? normalized : normalized.replace(/\\+$/, "");
  }
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export type RealpathResolver = (value: string) => string[];

function realpaths(value: string): string[] {
  const found: string[] = [];
  for (const resolve of [realpathSync.native, realpathSync]) {
    try {
      found.push(resolve(value));
    } catch {
      // Missing paths compare as strings, as in the daemon.
    }
  }
  return found;
}

/** Same equivalence as the daemon's createRealpathAwarePathMatcher, without subdirectories. */
function variantsOf(value: string, resolve: RealpathResolver, cache: Map<string, Set<string>>, windows: boolean): Set<string> {
  const cached = cache.get(value);
  if (cached) return cached;
  const variants = new Set([value, ...resolve(value)].map(candidate => normalize(candidate, windows)));
  cache.set(value, variants);
  return variants;
}

function updatedAt(session: JsonObject): number {
  const parsed = typeof session.updatedAt === "string" ? Date.parse(session.updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** Where agy CLI keeps the conversations it can load; the desktop app keeps its own elsewhere. */
const CLI_CONVERSATIONS = path.join(homedir(), ".gemini", "antigravity-cli", "conversations");
/** agy CLI's summary index, which stores conversation titles and every workspace URI. */
export const CLI_SUMMARIES_DB = path.join(homedir(), ".gemini", "antigravity-cli", "conversation_summaries.db");

/** A loadability check for one listing: a conversation agy CLI can load has a database here. */
export function cliLoadable(directory = CLI_CONVERSATIONS): (sessionId: string) => boolean {
  let present = false;
  try {
    present = statSync(directory).isDirectory();
  } catch {
    // An unknown store layout: keep every session rather than hide them all.
  }
  if (!present) return () => true;
  return (sessionId) => !/^[0-9A-Za-z-]+$/.test(sessionId) || existsSync(path.join(directory, `${sessionId}.db`));
}

interface SqliteDatabase {
  prepare(sql: string): { all(): Array<{ conversation_id?: unknown; workspace_uris?: unknown }> };
  close(): void;
}

/**
 * Extra workspace directories recorded for multi-root sessions. agy's `session/list` reports only
 * the first `workspace_uris` entry, hiding sessions with multiple roots — including older
 * Antigravity+ conversations where agy ran in `/` and recorded `["file:///", "<cwd>"]`.
 */
export function cliStoredCwds(databasePath = CLI_SUMMARIES_DB, windows = WINDOWS_PATHS): (sessionId: string) => readonly string[] {
  let loaded: Map<string, string[]> | null = null;
  const load = (): Map<string, string[]> => {
    if (loaded) return loaded;
    loaded = new Map();
    if (!existsSync(databasePath)) return loaded;
    let db: SqliteDatabase | null = null;
    try {
      // Paseo loads plugins without import.meta.url, so no createRequire; getBuiltinModule needs no base path.
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as {
        DatabaseSync: new (location: string, options?: { readOnly?: boolean; timeout?: number }) => SqliteDatabase;
      };
      db = new DatabaseSync(databasePath, { readOnly: true, timeout: 200 });
      const rows = db
        .prepare("SELECT conversation_id, workspace_uris FROM conversation_summaries WHERE workspace_uris LIKE '%,%'")
        .all();
      for (const row of rows) {
        if (typeof row.conversation_id !== "string" || typeof row.workspace_uris !== "string") continue;
        let uris: unknown;
        try {
          uris = JSON.parse(row.workspace_uris);
        } catch {
          continue;
        }
        if (!Array.isArray(uris)) continue;
        const dirs = uris.filter((uri): uri is string => typeof uri === "string" && uri.length > 0).map(uri => decodeCwd(uri, windows));
        if (dirs.length > 0) loaded.set(row.conversation_id, dirs);
      }
    } catch {
      // Missing node:sqlite, locked database, or changed schema: fall back to agy's own cwd only.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
    return loaded;
  };
  return (sessionId) => load().get(sessionId) ?? [];
}

export interface ArrangeOptions {
  windowsPaths?: boolean;
  resolve?: RealpathResolver;
  /** The listing process's directory: agy's stand-in for "no directory recorded". */
  placeholderCwd?: string | null;
  /** False for conversations agy cannot load, which would import as empty sessions. */
  loadable?: (sessionId: string) => boolean;
  /** Additional workspace directories from agy's index, for sessions whose first URI is `/` or another root. */
  storedCwds?: (sessionId: string) => readonly string[];
}

/**
 * Decodes every cwd, keeps only loadable sessions in `requestedCwd` (when given) and returns them
 * newest first. A kept session reports `requestedCwd` itself, the exact string the daemon matches.
 */
export function arrangeSessions(
  sessions: readonly unknown[],
  requestedCwd: string | null,
  options: ArrangeOptions = {},
): JsonObject[] {
  const windows = options.windowsPaths ?? WINDOWS_PATHS;
  const resolve = options.resolve ?? realpaths;
  const placeholderCwd = options.placeholderCwd ?? null;
  const loadable = options.loadable ?? cliLoadable();
  const storedCwds = options.storedCwds ?? cliStoredCwds(CLI_SUMMARIES_DB, windows);
  const cache = new Map<string, Set<string>>();
  const variants = (value: string) => variantsOf(value, resolve, cache, windows);
  const target = requestedCwd ? variants(requestedCwd) : null;
  const placeholder = placeholderCwd ? variants(placeholderCwd) : null;
  const isPlaceholder = (value: string) =>
    placeholder !== null && [...variants(value)].some((variant) => placeholder.has(variant));
  const isRoot = (value: string) => {
    const normalized = normalize(value, windows);
    return normalized === (windows ? path.win32 : path.posix).parse(normalized).root;
  };
  const arranged: JsonObject[] = [];
  for (const session of sessions) {
    if (!isObject(session)) continue;
    const sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
    if (sessionId && !loadable(sessionId)) continue;
    let cwd = typeof session.cwd === "string" ? decodeCwd(session.cwd, windows) : undefined;
    if (cwd && isPlaceholder(cwd)) {
      // No directory recorded: never part of a directory's list; listed under home otherwise.
      if (target) continue;
      cwd = homedir();
    }
    if (target && requestedCwd) {
      const matchesTarget = (value: string) =>
        [...variants(value)].some((variant) => target.has(variant));
      const matched =
        (cwd !== undefined && matchesTarget(cwd)) ||
        (sessionId !== null &&
          storedCwds(sessionId).some((stored) => !isPlaceholder(stored) && matchesTarget(stored)));
      if (!matched) continue;
      arranged.push({ ...session, cwd: requestedCwd });
    } else {
      if (cwd && isRoot(cwd) && sessionId !== null) {
        const better = storedCwds(sessionId).find((stored) => !isRoot(stored) && !isPlaceholder(stored));
        if (better) cwd = better;
      }
      arranged.push(cwd === undefined ? { ...session } : { ...session, cwd });
    }
  }
  // Array.prototype.sort is stable, so equal timestamps keep agy's order.
  return arranged.sort((left, right) => updatedAt(right) - updatedAt(left));
}

/** Fresh enough to answer without asking agy. */
const FRESH_MS = 60_000;
/** Still answered from memory, while a background refresh fetches a newer list. */
const STALE_MS = 15 * 60_000;

interface ListSnapshot {
  sessions: unknown[];
  placeholderCwd: string | null;
  fetchedAt: number;
}

let snapshot: ListSnapshot | null = null;

/** For tests: forget the shared snapshot. */
export function resetSessionListCache(): void {
  snapshot = null;
}

interface PendingList {
  originalId: MessageId;
  cwd: string | null;
  sessions: unknown[];
  pages: number;
  firstResult: JsonObject | null;
}

export interface ListRelayResult {
  /** Messages for the adapter. */
  deliver: AcpStreamMessage[];
  /** Requests to write to agy. */
  send: AcpStreamMessage[];
}

export interface ListRelayOptions extends ArrangeOptions {
  /** Starts a background refresh of the shared snapshot. */
  refresh?: () => void;
  now?: () => number;
}

export class SessionListRelay {
  private readonly pending = new Map<MessageId, PendingList>();
  private readonly options: ListRelayOptions;
  private sequence = 0;

  constructor(options: ListRelayOptions = {}) {
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Call for every message the adapter writes. Returns the answer to deliver right away when the
   * shared snapshot can answer it; the request must then not reach agy.
   */
  outgoing(message: AcpStreamMessage): AcpStreamMessage | null {
    if (!("method" in message) || message.method !== "session/list" || !("id" in message)) return null;
    if (message.id === null) return null;
    const params = isObject(message.params) ? message.params : {};
    const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : null;
    const age = snapshot ? this.now() - snapshot.fetchedAt : Number.POSITIVE_INFINITY;
    if (snapshot && age < STALE_MS && params.cursor === undefined) {
      if (age >= FRESH_MS) this.options.refresh?.();
      return this.answer({ originalId: message.id, cwd, sessions: snapshot.sessions, pages: 1, firstResult: null }, snapshot.placeholderCwd);
    }
    this.pending.set(message.id, { originalId: message.id, cwd, sessions: [], pages: 0, firstResult: null });
    return null;
  }

  /** Returns null when the message is not an answer to a session/list this relay tracks. */
  incoming(message: AcpStreamMessage): ListRelayResult | null {
    if ("method" in message || !("id" in message) || message.id === null) return null;
    const entry = this.pending.get(message.id);
    if (!entry) return null;
    this.pending.delete(message.id);
    if (!("result" in message) || !isObject(message.result) || !Array.isArray(message.result.sessions)) {
      // An error on the first page goes to the adapter as is; on a later page, keep what arrived.
      if (entry.pages === 0) return { deliver: [{ ...message, id: entry.originalId } as AcpStreamMessage], send: [] };
      return { deliver: [this.answer(entry)], send: [] };
    }
    entry.pages += 1;
    entry.firstResult ??= message.result;
    entry.sessions.push(...message.result.sessions);
    const cursor = message.result.nextCursor;
    if (typeof cursor === "string" && cursor.length > 0 && entry.pages < MAX_PAGES) {
      const id = `${PAGE_ID_PREFIX}${++this.sequence}`;
      this.pending.set(id, entry);
      const params = entry.cwd ? { cwd: entry.cwd, cursor } : { cursor };
      return { deliver: [], send: [{ jsonrpc: "2.0", id, method: "session/list", params }] };
    }
    snapshot = { sessions: entry.sessions, placeholderCwd: this.options.placeholderCwd ?? null, fetchedAt: this.now() };
    return { deliver: [this.answer(entry)], send: [] };
  }

  private answer(entry: PendingList, placeholderCwd = this.options.placeholderCwd ?? null): AcpStreamMessage {
    return {
      jsonrpc: "2.0",
      id: entry.originalId,
      result: {
        ...(entry.firstResult ?? {}),
        sessions: arrangeSessions(entry.sessions, entry.cwd, { ...this.options, placeholderCwd }),
        nextCursor: null,
      },
    };
  }
}

let refreshing: Promise<void> | null = null;

export async function drainSessionListProbe(): Promise<void> {
  await refreshing;
}

/**
 * Fetches agy's full session list in the background into the shared snapshot. At most one runs
 * at a time; failures only log, since the next Import dialog request fetches again.
 */
export function refreshSessionList(launch: ProviderLaunch, env: Readonly<Record<string, string>>): Promise<void> {
  refreshing ??= fetchSessionList(launch, env).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function fetchSessionList(launch: ProviderLaunch, env: Readonly<Record<string, string>>): Promise<void> {
  const cwd = listWorkingDirectory();
  const child = spawnProcess(launch.command, launch.args, { env: { ...launch.env, ...env }, cwd, stdio: "pipe" });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.stdin.on("error", () => undefined);
  child.stderr.on("data", () => undefined);
  child.on("error", () => undefined);
  const waiters = new Map<number, (message: JsonObject) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (isObject(message) && typeof message.id === "number") waiters.get(message.id)?.(message);
    } catch {
      // Not a JSON-RPC line.
    }
  });
  let lastId = 0;
  const call = (method: string, params: JsonObject) =>
    new Promise<JsonObject>((resolve, reject) => {
      const id = ++lastId;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
      timer.unref();
      waiters.set(id, (message) => {
        clearTimeout(timer);
        waiters.delete(id);
        if (isObject(message.result)) resolve(message.result);
        else reject(new Error(`${method} failed`));
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const sessions: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await call("session/list", cursor ? { cursor } : {});
      if (!Array.isArray(result.sessions)) throw new Error("session/list returned no sessions");
      sessions.push(...result.sessions);
      cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      pages += 1;
    } while (cursor && pages < MAX_PAGES);
    snapshot = { sessions, placeholderCwd: cwd, fetchedAt: Date.now() };
  } catch (error) {
    console.error(`[antigravity-plus] background session list failed: ${String(error)}`);
  } finally {
    child.stdin.end();
    const kill = setTimeout(() => void terminateProcess(child), 3000);
    kill.unref();
    await closed;
    clearTimeout(kill);
  }
}
