Antigravity+ adds a second Antigravity provider to Paseo that runs `agy acp`, the Agent Client Protocol server built into the Antigravity CLI, instead of the stream-json print mode the built-in provider uses. Prompts, attachments, MCP tool calls and tool outputs go to `agy acp` in the session's working directory and through `agy` to Google's Antigravity service. The plugin also adds an Antigravity quota source to the Usage panel.

## What you get

- Conversation history after a daemon restart or agent reload. Paseo reopens the agy conversation with `session/load`, and agy replays it into the timeline.
- Import session lists your local agy CLI conversations for the selected directory, newest first, including ones started by the built-in Antigravity provider or in the agy terminal UI. To avoid listing Antigravity desktop app conversations that `agy acp` cannot load, the plugin checks `~/.gemini/antigravity-cli/conversations/` for a local conversation database and runs `session/list` in an empty temporary folder (`$TMPDIR/antigravity-plus/session-list`).
- Slash commands and skills such as `/goal`, `/plan`, `/compact` and your own skills appear in the composer.
- Modes: agy's own Default, Accept edits, Auto and Plan, plus an optional Bypass mode. New agents start in Default, asking for permission through Paseo permission cards before edits and commands. You can switch to Bypass per session or change the default permission mode in **Settings → Antigravity+**. In Bypass, agy runs in its Default mode outside the terminal sandbox and the plugin approves requests with `allow_once`; deny rules in your agy settings still apply in every mode.
- Paseo's MCP servers and the agent's Paseo instructions reach agy, so Antigravity agents can use Paseo's orchestration tools.
- Subagents through Paseo. agy's own `invoke_subagent` starts subagents that Paseo cannot show or control, so it is blocked in Antigravity+ sessions and agy is told to use Paseo's `create_agent` instead. agy commands that rely on native subagents, such as `/teamwork` and `/boost`, do not work here; use the agy terminal UI for them.
- The context window meter in the composer, from agy's usage updates.
- Steering: a message sent during a running turn joins that turn instead of interrupting it.
- Model and thinking level as separate choices, with each model's own levels, such as XHigh for Gemini 4 Neon and Gemini 4 Hydrogen.

## Setup

The companion agy plugin enforces the `invoke_subagent` restriction. It uses a PowerShell hook on Windows and a `/bin/sh` hook on macOS. The hook denies `invoke_subagent` in agy processes started by Antigravity+, which carry `ANTIGRAVITY_PLUS=1`. It allows the call in other agy sessions. See the repository README for platform setup.

## Quota

The quota source reads agy's Google login from macOS Keychain (service `gemini`) or Windows Credential Manager (`gemini:antigravity`) and asks Google's Antigravity backend (`daily-cloudcode-pa.googleapis.com`) for quota using the installed `agy` CLI version header (`antigravity/cli/<version>`). It reports the plan name along with the quota groups returned by the backend: weekly and 5-hour limits for the shared Gemini pool (Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon) and Gemini 3.8 Flash), weekly and 5-hour limits for Claude and GPT models, and the separate weekly limit for Gemini 4 Argon (Pro plans). If the summary omits Google models, it falls back to `fetchAvailableModels`. The access token is used only for these requests. When it expires, the source runs `agy models` so agy can refresh the active login.

## Manual account switching

Open **Antigravity+ accounts** in the sidebar to add Google consumer accounts. The plugin stores complete logins in macOS Keychain or Windows Credential Manager. Switching changes the shared agy login, so close standalone agy sessions and sessions using Paseo's built-in Antigravity provider first. Once all Antigravity+ turns are idle, you can switch accounts and continue a conversation. The accounts page shows the active account's latest reading and a dated snapshot for each standby account. When quota runs out, open **Quota → Manage accounts** in the composer to confirm a switch.

## Requirements

- Paseo 0.16.0 or later and agy 1.5.8 or later, signed in.
- macOS and Windows. On Windows, credential storage (quota and account switching) and the companion hook require Windows PowerShell. Linux is untested.

## Limits

- Antigravity+ is a separate provider. Agents created with the built-in Antigravity provider stay on it; import their conversations to move them.
- Background commands: when agy moves a long-running command to the background, its turn can end before the command finishes, so Paseo shows the agent idle while that command still runs.
- Shell, read and search tools show as generic tool rows with their input and output; file edits show as diffs.
