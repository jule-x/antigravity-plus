Antigravity+ 为 Paseo 增加了一个通过 `agy acp`（Antigravity CLI 内置的 Agent Client Protocol 服务）运行的 Antigravity 提供商，替代内置提供商使用的 stream-json 打印模式。提示词、附件、MCP 工具调用与工具输出会发送给会话工作目录下的 `agy acp`，并由 `agy` 发往 Google 的 Antigravity 服务。本插件同时在 Usage 面板中提供 Antigravity 额度数据源。

## 主要功能

- 重启或重载后保留历史会话：Paseo 通过 `session/load` 重新打开 agy 会话，并将历史消息回放到时间线中。
- 会话导入：按当前所选目录列出本地 agy CLI 会话（按更新时间倒序），包含由内置 Antigravity 提供商或在 agy 终端中创建的会话。为避免列出 `agy acp` 无法加载的 Antigravity 桌面端会话，插件会检查 `~/.gemini/antigravity-cli/conversations/` 下是否存在本地会话数据库，并在独立的空临时目录（`$TMPDIR/antigravity-plus/session-list`）中执行 `session/list`。
- 斜杠命令与技能：`/goal`、`/plan`、`/compact` 及自定义技能可直接出现在输入框自动补全中。
- 权限模式：提供 agy 原生的 Default、Accept edits、Auto 和 Plan 模式，以及可选的 Bypass 模式。新建代理默认使用 Default，在执行编辑与命令前通过 Paseo 权限卡片请求确认；可在单个会话中随时切换到 Bypass，也可在 **Settings → Antigravity+** 中自定义新建会话的默认权限模式。Bypass 底层让 agy 运行在 Default 模式（不进终端沙箱），并在流层以 `allow_once` 自动批准每次权限请求；你在 agy 配置中的 deny 规则在所有模式下依然生效。
- MCP 与系统指令透传：Paseo 的 MCP 服务与代理级系统指令会传给 agy，因此 Antigravity 代理可以直接使用 Paseo 的编排工具。
- 子代理交由 Paseo 托管：agy 自带的 `invoke_subagent` 创建的子代理在 Paseo 中不可见也不可控，因此在 Antigravity+ 会话中会被拦截，并引导模型改用 Paseo 的 `create_agent`。依赖原生子代理的命令（如 `/teamwork`、`/boost`）在此不可用，需在 agy 终端中使用。
- 上下文用量指示器：根据 agy 的用量更新实时显示在输入框旁。
- 运行中插话（Steering）：在当前轮次运行期间发送的消息会并入当前轮次继续执行，而不会打断重来。
- 按模型独立配置思考档位：每个模型拥有各自的思考档位选项（例如 Gemini 4 Neon 与 Gemini 4 Hydrogen 支持 XHigh，无档位变体的模型不显示档位）。

## 配置说明

伴随插件使用 `PreToolUse` 钩子拦截 `invoke_subagent`。Windows 钩子通过 PowerShell 运行，macOS 钩子通过 `/bin/sh` 运行。钩子仅在带有 `ANTIGRAVITY_PLUS=1` 的 Antigravity+ 进程中拒绝调用，并放行其他 agy 会话中的调用。各平台的配置方式见仓库 README。

## 额度监控

额度数据源从 Windows 凭据管理器（`gemini:antigravity`）或 macOS 钥匙串（服务名 `gemini`）读取 agy 的 Google 登录凭据，并带上本机 `agy` CLI 版本标识（`antigravity/cli/<version>`）向 Google 的 Antigravity 后端（`daily-cloudcode-pa.googleapis.com`）查询额度。面板展示套餐名称和后端返回的额度组，包括 Gemini 共享池和 Claude/GPT 的周限额与 5 小时限额，以及 Pro 套餐下 Gemini 4 Argon 的独立周限额。若摘要接口未返回 Google 模型组，则回退查询 `fetchAvailableModels`。访问令牌过期时，插件会执行一次 `agy models`，由 agy 刷新当前登录。

## 手动切换账号

在侧栏的 **Antigravity+ accounts** 添加自己的 Google 消费者账号。完整登录凭据保存在 Windows 凭据管理器或 macOS 钥匙串中。切换会更新 agy 的共享登录，并保留本地会话历史。切换前先关闭独立 agy 和内置 Antigravity 提供商的会话，再等待 Antigravity+ 的轮次结束。账号页显示活跃账号最近的额度读数及备用账号的额度快照。

## 环境要求

- Paseo 0.16.0 及以上，已登录的 agy 1.5.8 及以上。
- 支持 Windows 和 macOS。Windows 伴随插件需要 Windows PowerShell。Linux 未经测试。

## 已知限制

- Antigravity+ 是独立的提供商，使用内置 Antigravity 提供商创建的旧代理不会自动迁移，可通过会话导入功能迁入。
- 后台命令：当 agy 将耗时命令转为后台运行时，当前轮次可能在命令结束前完成，此时 Paseo 会显示代理已空闲。
- Shell、文件读取与搜索工具展示为带输入输出的通用工具行；文件编辑展示为 diff。
