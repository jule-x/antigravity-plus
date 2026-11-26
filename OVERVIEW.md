Antigravity+ adds an enhanced Antigravity provider (`antigravity-plus`) to Paseo powered by `agy acp` (the Agent Client Protocol server built into the Antigravity CLI), extending Paseo's Antigravity workflow with multi-account management and manual switching, composer quota quick-view, cached multi-root session import, mid-turn steering, automatic title sync, per-model thinking levels, and Paseo subagent routing. Prompts, attachments, MCP tool calls and tool outputs go to `agy acp` in the session's working directory and through `agy` to Google's Antigravity service.

## What you get

- Conversation history after a daemon restart or agent reload. Paseo reopens the agy conversation with `session/load` and waits for trailing replay chunks (`loadReplayQuietPeriodMs` on Paseo 0.17.1+).
- Enhanced Import session: lists your local agy CLI conversations for the selected directory, newest first, with in-memory caching and background refresh, percent-encoded and Windows path decoding, multi-root and legacy `/` `workspace_uris` fallback, and filtering of Antigravity desktop app conversations that `agy acp` cannot load.
- Slash commands and skills: classifies built-in commands (`/goal`, `/plan`, `/compact`, etc.) and custom skills separately so mid-prompt `/` skill suggestions work on Paseo 0.17.1+.
- Native tool cards & background-command handling (Paseo 0.17.1+): formats shell commands/output, file reads/writes/diffs, web search, and Paseo MCP calls in native timeline cards, and keeps turns open while non-daemon background commands finish.
- Modes: agy's own Default, Accept edits, Auto and Plan, plus an optional Bypass mode. New agents start in Default, asking for permission through Paseo permission cards before edits and commands. You can switch to Bypass per session or change the default permission mode in **Settings → Antigravity+**. In Bypass, agy runs in its Default mode outside the terminal sandbox and the plugin approves requests with `allow_once`; deny rules in your agy settings still apply in every mode.
- Paseo's MCP servers and the agent's Paseo instructions reach agy, so Antigravity agents can use Paseo's orchestration tools.
- Subagents through Paseo. agy's own `invoke_subagent` starts subagents that Paseo cannot show or control, so it is blocked in Antigravity+ sessions (when the companion hook is installed) and agy is told to use Paseo's `create_agent` instead. agy commands that rely on native subagents, such as `/teamwork` and `/boost`, do not work here; use the agy terminal UI for them.
- The context window meter in the composer, from agy's usage updates, plus automatic syncing of agy's generated conversation title onto provisional Paseo agent titles.
- Steering: a message sent during a running turn joins that turn instead of interrupting it.
- Model and thinking level as separate choices, with each model's own levels, such as XHigh for Gemini 4 Neon and Gemini 4 Hydrogen.

## Setup

The companion agy plugin enforces the `invoke_subagent` restriction. It uses a PowerShell hook on Windows and a `/bin/sh` hook on macOS. The hook denies `invoke_subagent` in agy processes started by Antigravity+, which carry `ANTIGRAVITY_PLUS=1`. It allows the call in other agy sessions. See the repository README for platform setup.

## Quota

The quota source runs the official `agy -p /usage --output-format json` and shows the groups agy reports: weekly and 5-hour limits for the shared Gemini pool (Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon) and Gemini 3.8 Flash), weekly and 5-hour limits for Claude and GPT models, and the separate weekly limit for Gemini 4 Argon (Pro plans). The plugin reads agy's stored login from macOS Keychain (service `gemini`) or Windows Credential Manager (`gemini:antigravity`) only to check which account is active, and never sends the token anywhere. When the login has expired, it runs `agy models` so agy can refresh it.

Versions up to 0.3.0 called Google's internal `cloudcode-pa.googleapis.com` quota APIs directly. Google has told third-party clients that this can get an account flagged, so 0.3.1 removed those calls.

## Manual account switching

Open **Antigravity+ accounts** in the sidebar to add Google consumer accounts. The plugin stores complete logins in macOS Keychain or Windows Credential Manager. Switching changes the shared agy login, so close standalone agy sessions and sessions using Paseo's built-in Antigravity provider first. Once all Antigravity+ turns are idle, you can switch accounts and continue a conversation. The accounts page shows the active account's latest reading and a dated snapshot for each standby account. When quota runs out, open **Quota → Manage accounts** in the composer to confirm a switch.

## Requirements

- Paseo 0.16.0 or later and agy 1.5.8 or later, signed in.
- macOS and Windows. On Windows, credential storage (quota and account switching) and the companion hook require Windows PowerShell. Linux is untested.

## Limits

- Antigravity+ is a separate provider. Agents created with the built-in Antigravity provider stay on it; import their conversations to move them.
- On Paseo 0.16.x (before 0.17.1), long-running commands moved to the background can end the turn early, and shell/read/search tools show as generic tool rows. Upgrade to Paseo 0.17.1+ for deferred turns on background commands and native tool cards.
