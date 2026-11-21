import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

export function installedWindowsAgy(): string | undefined {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return;
  const command = join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe");
  try {
    if (statSync(command, { throwIfNoEntry: false })?.isFile()) return command;
  } catch {
    return undefined;
  }
}

export function resolveAgyLaunch(launch?: ProviderLaunch): ProviderLaunch | undefined {
  if (launch) return launch;
  const command = installedWindowsAgy();
  if (!command) return undefined;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { command, args: ["acp"], env };
}

export function agyCliArgs(launch: ProviderLaunch, args: string[]): string[] {
  const acp = launch.args.indexOf("acp");
  return [...(acp < 0 ? [] : launch.args.slice(0, acp)), ...args];
}

export async function execAgy(args: string[], timeout: number, launch?: ProviderLaunch) {
  const resolved = resolveAgyLaunch(launch);
  if (resolved) {
    return execCommand(resolved.command, agyCliArgs(resolved, args), { env: resolved.env, timeout });
  }
  const candidates = process.platform === "darwin"
    ? ["agy", "/opt/homebrew/bin/agy", "/usr/local/bin/agy", join(homedir(), ".local", "bin", "agy")]
    : [process.platform === "win32" ? "agy.exe" : "agy"];
  for (const command of candidates) {
    try {
      return await execCommand(command, args, { env: process.env, timeout });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("agy executable was not found");
}
