# Antigravity+ for Paseo

English | [简体中文](./README.zh-CN.md)

Antigravity+ adds a full-featured Antigravity provider (`antigravity-plus`) to [Paseo](https://paseo.sh) powered by `agy acp` (the Agent Client Protocol server built into the Antigravity CLI), plus an Antigravity quota source in Paseo's Usage panel.

## Features

- **Persistent history across restarts**: Reopens conversations via ACP `session/load` and replays the timeline.
- **Fast session import**: Lists local `agy` CLI conversations for the current workspace directory (newest first, with in-memory caching and background refresh), filtering out unimportable Antigravity desktop app records.
- **Slash commands & skills**: Surfaces `/goal`, `/plan`, `/compact`, `/grill-me`, and your custom skills in the Paseo composer.
- **Permission modes**: Supports `agy`'s native **Default** (default for new agents, asking for permission), **Accept edits**, **Auto**, and **Plan** modes, plus an optional **Bypass** mode (running outside the terminal sandbox and auto-approving with `allow_once` without polluting global grants). You can switch modes per session or configure your own default mode in **Settings → Antigravity+**.
- **Per-model thinking levels**: Derives each model's supported thinking levels from `agy`'s variant catalog (including `XHigh` for Gemini 4 Neon and Gemini 4 Hydrogen, and no thinking selector for level-less models like GPT-OSS and Orchestrator).
- **Mid-turn steering**: Messages sent during an active turn join the running turn instead of interrupting it.
- **Paseo MCP & subagent orchestration**: Forwards Paseo's MCP servers and agent system instructions to `agy`, and redirects subagent creation from `agy`'s hidden `invoke_subagent` to Paseo's visible, controllable `create_agent`.
- **Context window & Usage panel quota**: Reports live context window usage in the composer and displays Gemini (Weekly & 5-hour shared pool for Neon/Hydrogen/Flash), Claude/GPT (Weekly & 5-hour), and Gemini 4 Argon (Weekly) quota windows on macOS and Windows.

## Manual account switching

Open **Antigravity+ accounts** in the sidebar to add your Google consumer accounts. The plugin stores complete logins in macOS Keychain or Windows Credential Manager. A switch changes agy's shared login, including for standalone agy and Paseo's built-in Antigravity provider. Close those sessions and wait for Antigravity+ turns to finish before switching. Accounts share agy's local conversation history. The accounts page shows remaining quota as progress bars and timestamps standby snapshots. When quota runs out, **Manage accounts** can suggest a standby account for confirmation. The plugin follows Paseo's language setting, with Simplified Chinese and English strings.

Select an **Antigravity+** model to see **Quota** alongside the model and mode controls, even before sending your first prompt. When space is limited, look for **Quota** in the agent features panel opened by the settings icon. The panel shows the current account's remaining quota and reset times. Existing agents also have a **Quota** shortcut above the composer.

## Requirements

- **Paseo** `>= 0.16.0`
- **Antigravity CLI (`agy`)** `>= 1.5.8`, signed in. Use `PATH` or the default Windows location `%LOCALAPPDATA%\agy\bin\agy.exe`.
- **macOS and Windows**. Windows uses Windows Credential Manager and the system Windows PowerShell. Linux is untested.

## Installation

On Windows, follow the local checkout instructions. On macOS, install from the official Paseo plugin registry:

```bash
paseo plugin add jule-x/antigravity-plus
```

Or install directly from GitHub:

```bash
paseo plugin add git:jule-x/antigravity-plus
```

### Windows local checkout

Run these commands from this Windows-compatible checkout in PowerShell. Installing from the registry or GitHub above fetches the macOS upstream. With the default Paseo Desktop installation, the launcher is bundled with the app.

```powershell
$paseoCli = Join-Path $env:LOCALAPPDATA 'Programs\Paseo\resources\bin\paseo.cmd'
$agyCli = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
if (!(Test-Path -LiteralPath $agyCli -PathType Leaf)) { $agyCli = 'agy' }
npm ci
& $paseoCli plugin install (Get-Location).Path
& $agyCli plugin install (Join-Path (Get-Location).Path 'agy-plugin\windows')
& $paseoCli plugin ls antigravity-plus
```

The local Paseo daemon needs plugins enabled in **Settings → Plugins**. Select **Antigravity+** as the provider when creating or importing an agent. After editing the local checkout, use `plugin reload antigravity-plus`. Reinstall the Windows companion if its hook changes.

Use **Import session** in Paseo Desktop to import history. For scripted imports, run the packaged CLI directly in **PowerShell 7**. This preserves the JSON quotes that Paseo 0.16.2's `paseo.cmd` can drop. Set `$sessionId` to the native agy conversation ID and `$cwd` to its workspace directory.

```powershell
$sessionId = '<agy-session-id>'
$cwd = 'C:\path\to\workspace'
$paseoDir = Join-Path $env:LOCALAPPDATA 'Programs\Paseo'
$handle = 'plugin:' + (@{version = 1; data = @{sessionId = $sessionId}} | ConvertTo-Json -Compress)
$launch = [Diagnostics.ProcessStartInfo]::new()
$launch.FileName = Join-Path $paseoDir 'Paseo.exe'
$launch.UseShellExecute = $false
$launch.CreateNoWindow = $true
$launch.Environment['ELECTRON_RUN_AS_NODE'] = '1'
$launch.Environment['PASEO_NODE_ENV'] = 'production'
$launch.RedirectStandardOutput = $true
$launch.RedirectStandardError = $true
$arguments = @(
  (Join-Path $paseoDir 'resources\app.asar.unpacked\dist\daemon\node-entrypoint-runner.js'),
  'node-script',
  (Join-Path $paseoDir 'resources\app.asar\node_modules\@getpaseo\cli\dist\index.js'),
  'agent', 'import', '--provider', 'antigravity-plus', '--cwd', $cwd, '--json', $handle
)
foreach ($argument in $arguments) { $launch.ArgumentList.Add($argument) }
$process = [Diagnostics.Process]::Start($launch)
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw ($stderr.Result + $stdout.Result) }
$stdout.Result
```

### Companion `agy` plugin (recommended)

The companion blocks agy's internal `invoke_subagent` tool inside Antigravity+ sessions so the model uses Paseo's `create_agent`. On Windows, use the companion install command in the local checkout instructions. On macOS, symlink the bundled `agy-plugin` directory into the global agy plugins folder:

```bash
mkdir -p ~/.gemini/config/plugins
ln -sfn "$(ls -dt ~/.paseo/plugins/antigravity-plus/*/checkout/agy-plugin | head -n 1)" ~/.gemini/config/plugins/antigravity-plus-guard
```

If you installed the plugin from a local clone instead:

```bash
mkdir -p ~/.gemini/config/plugins
ln -sfn /absolute/path/to/antigravity-plus/agy-plugin ~/.gemini/config/plugins/antigravity-plus-guard
```

The installed checkout directory changes after `paseo plugin update`, so re-run the first command after each update.

The `PreToolUse` hook only denies `invoke_subagent` when `ANTIGRAVITY_PLUS=1` is present in the environment (set automatically by Antigravity+). Outside Paseo, it returns `{"decision":"allow"}` and leaves your terminal/IDE `agy` sessions untouched.

### Tip: Disable the built-in Antigravity provider

Because Antigravity+ registers as `antigravity-plus` alongside Paseo's built-in `antigravity` provider, you can disable the built-in **Antigravity** provider in **Settings → Providers** and import any existing sessions into **Antigravity+**.

## Development

```bash
npm install
npm run typecheck
npm test
```

## Community

This project recognizes and appreciates the open-source sharing spirit of the [LINUX DO](https://linux.do/) community. Feel free to share feedback, ideas, and usage tips there.

## License

[MIT](./LICENSE)
