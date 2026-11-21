import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { terminateProcess } from "@getpaseo/plugin/server";
import type { LoginStatus } from "../shared/accounts-rpc.ts";

const failed = "Antigravity sign-in failed. Start again to get a new login link.";
const missingLink = "agy did not provide a supported Google login link.";
const cancelled = "Antigravity sign-in was cancelled.";

function googleLoginLink(line: string): string | undefined {
  const candidate = line.trim();
  if (!candidate.startsWith("https://accounts.google.com/") || /\s/.test(candidate)) return;
  try {
    const url = new URL(candidate);
    if (/^\/o\/oauth2\/(v2\/)?auth$/.test(url.pathname) && url.search) return candidate;
  } catch { /* Invalid URL. Never include agy's output in an error. */ }
}

class LoginAttempt {
  status: LoginStatus = { phase: "starting" };
  private abort?: (reason: string) => void;
  private child?: ChildProcessWithoutNullStreams;
  private cancelled = false;

  cancel() {
    if (this.status.phase === "finishing") return;
    this.cancelled = true;
    this.abort?.(cancelled);
  }

  submit(input: string) {
    if (this.status.phase !== "input" || !this.child) throw new Error("This login is not waiting for a code.");
    const value = input.trim();
    if (!value || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error("Paste one authorization code or callback URL.");
    }
    this.status = { phase: "submitted" };
    try {
      this.child.stdin.write(value + "\n", error => { if (error) this.abort?.(failed); });
    } catch { this.abort?.(failed); }
  }

  async run(spawn: () => ChildProcessWithoutNullStreams, linkTimeout: number, loginTimeout: number, stop: typeof terminateProcess) {
    if (this.cancelled) throw new Error(cancelled);
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(); } catch { throw new Error(failed); }
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      let failure: string | undefined;
      let loggedIn = false;
      const abort = (reason: string) => {
        if (failure) return;
        failure = reason;
        this.status = { phase: "finishing" };
        // The journal may restore the slot only after this credential writer has exited.
        void stop(child).catch(() => child.kill("SIGKILL"));
      };
      this.abort = abort;
      const promptTimer = setTimeout(() => abort(missingLink), linkTimeout);
      const deadline = setTimeout(() => abort("Antigravity sign-in timed out."), loginTimeout);
      const parse = (line: string) => {
        line = stripVTControlCharacters(line).trim();
        if (this.status.phase === "starting") {
          const url = googleLoginLink(line);
          if (url) {
            clearTimeout(promptTimer);
            this.status = { phase: "input", url };
          }
        } else if (this.status.phase === "submitted" && /\bLogged in as \S+\.$/i.test(line)) {
          loggedIn = true;
        }
      };
      for (const stream of [child.stdout, child.stderr]) {
        let tail = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          if (failure) return;
          const lines = (tail + chunk).split("\n");
          tail = lines.pop()!;
          for (const line of lines) parse(line);
          if (tail.length > 32768) abort(failed);
        });
        stream.on("end", () => { parse(tail); tail = ""; });
        stream.on("error", () => abort(failed));
      }
      child.stdin.on("error", () => abort(failed));
      child.on("error", () => abort(failed));
      child.once("close", code => {
        clearTimeout(promptTimer);
        clearTimeout(deadline);
        this.child = undefined;
        this.abort = undefined;
        const reason = failure ?? (this.status.phase === "starting" ? missingLink : failed);
        this.status = { phase: "finishing" };
        if (!failure && code === 0 && loggedIn) resolve();
        else reject(new Error(reason));
      });
    });
  }
}

/** Each dialog receives its own opaque handle. Only that dialog polls for the OAuth URL. */
export class AccountLogins {
  private attempts = new Map<string, LoginAttempt>();
  private active?: LoginAttempt;
  private completion?: Promise<void>;
  private spawn: () => ChildProcessWithoutNullStreams;
  private linkTimeout: number;
  private loginTimeout: number;
  private stop: typeof terminateProcess;

  constructor(spawn: () => ChildProcessWithoutNullStreams, linkTimeout = 30_000, loginTimeout = 300_000, stop = terminateProcess) {
    this.spawn = spawn;
    this.linkTimeout = linkTimeout;
    this.loginTimeout = loginTimeout;
    this.stop = stop;
  }

  begin(add: () => Promise<void>) {
    if (this.active) throw new Error("Another account login is in progress.");
    const id = randomUUID();
    const attempt = new LoginAttempt();
    this.attempts.set(id, attempt);
    this.active = attempt;
    this.completion = Promise.resolve().then(add).then(
      () => { attempt.status = { phase: "done" }; },
      error => { attempt.status = { phase: "failed", message: error instanceof Error ? error.message : failed }; },
    ).finally(() => {
      this.active = undefined;
      setTimeout(() => this.attempts.delete(id), 300_000).unref();
    });
    return { id };
  }

  run() {
    if (!this.active) throw new Error("Open the Add account dialog to sign in.");
    return this.active.run(this.spawn, this.linkTimeout, this.loginTimeout, this.stop);
  }

  status(id: string): LoginStatus {
    return this.attempts.get(id)?.status ?? { phase: "failed", message: "The sign-in session expired. Check the accounts page." };
  }

  attempt(id: string) {
    const attempt = this.attempts.get(id);
    if (!attempt) throw new Error("This login has expired.");
    return attempt;
  }

  async dispose() {
    this.active?.cancel();
    await this.completion;
  }
}
