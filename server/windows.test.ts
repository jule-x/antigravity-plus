import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { agyCliArgs, resolveAgyLaunch } from "./agy-launch.ts";
import { createAntigravityPlusProvider } from "./provider.ts";

const windowsOnly = { skip: process.platform !== "win32" };

test("agy probes preserve the daemon's launcher and argument prefix", () => {
  const launch = { command: "custom-launcher", args: ["run", "agy", "acp"], env: { MARKER: "fixture" } };
  assert.equal(resolveAgyLaunch(launch), launch);
  assert.deepEqual(agyCliArgs(launch, ["--version"]), ["run", "agy", "--version"]);
});

test("the Windows provider registers the default installation even with an empty PATH", windowsOnly, () => {
  const parent = resolve(tmpdir());
  const local = resolve(mkdtempSync(join(parent, "agy-launch-")));
  assert(local.startsWith(parent.endsWith(sep) ? parent : parent + sep));
  const originalLocal = process.env.LOCALAPPDATA;
  const originalPath = process.env.PATH;
  try {
    process.env.LOCALAPPDATA = local;
    process.env.PATH = "";
    assert.deepEqual(createAntigravityPlusProvider().command, ["agy", "acp"]);
    const bin = join(local, "agy", "bin");
    mkdirSync(bin, { recursive: true });
    const command = join(bin, "agy.exe");
    writeFileSync(command, "");
    assert.deepEqual(createAntigravityPlusProvider().command, [command, "acp"]);
  } finally {
    if (originalLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocal;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(local, { recursive: true, force: true });
  }
});

test("Windows companion hook denies only plugin-managed subagents", windowsOnly, () => {
  const config = JSON.parse(readFileSync(new URL("../agy-plugin/windows/hooks.json", import.meta.url), "utf8"));
  const guard = config["antigravity-plus-subagents"].PreToolUse[0];
  assert.equal(guard.matcher, "invoke_subagent");
  for (const [flag, expected] of [["", "allow"], ["1", "deny"]]) {
    const result = spawnSync(guard.hooks[0].command, {
      shell: true, input: "{}\n", encoding: "utf8", timeout: 5000, windowsHide: true,
      env: { ...process.env, ANTIGRAVITY_PLUS: flag },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision, expected);
  }
});
