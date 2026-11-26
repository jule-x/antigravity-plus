Antigravity+ 为 Paseo 提供基于 `agy acp`（Antigravity CLI 内置的 Agent Client Protocol 服务）的增强型 Antigravity 提供商（`antigravity-plus`），在基础 ACP 能力之上补充了多账号管理与手动切号、输入框额度快捷弹窗、缓存加速的多目录会话导入、运行中插话（Steering）、agy 会话标题自动同步、按模型独立思考档位以及 Paseo 子代理编排。提示词、附件、MCP 工具调用与工具输出会发送给会话工作目录下的 `agy acp`，并由 `agy` 发往 Google 的 Antigravity 服务。

## 主要功能

- 重启或重载后保留历史会话：Paseo 通过 `session/load` 重新打开 agy 会话并回放时间线，在 Paseo 0.17.1+ 上自动等待尾段历史回放完成（`loadReplayQuietPeriodMs`），避免长对话丢尾。
- 增强会话导入：按当前所选目录列出本地 agy CLI 会话（按更新时间倒序，带内存缓存与后台刷新），支持中文与 Windows 路径解码、多目录及历史 `/` 会话的 `workspace_uris` 兜底，并过滤 `agy acp` 无法加载的 Antigravity 桌面端会话。
- 斜杠命令与技能分类：将 `/goal`、`/plan`、`/compact` 等内置命令与自定义技能分开标注，在 Paseo 0.17.1+ 上支持正文中间输入 `/` 补全技能。
- 原生工具卡片与后台命令守护（Paseo 0.17.1+）：将 Shell 命令与输出、文件读写与 diff、网页搜索以及 Paseo MCP 调用映射为原生卡片；非守护型后台命令执行期间保持轮次运行状态与停止按钮。
- 权限模式：提供 agy 原生的 Default、Accept edits、Auto 和 Plan 模式，以及可选的 Bypass 模式。新建代理默认使用 Default，在执行编辑与命令前通过 Paseo 权限卡片请求确认；可在单个会话中随时切换到 Bypass，也可在 **Settings → Antigravity+** 中自定义新建会话的默认权限模式。Bypass 底层让 agy 运行在 Default 模式（不进终端沙箱），并在流层以 `allow_once` 自动批准每次权限请求；你在 agy 配置中的 deny 规则在所有模式下依然生效。
- MCP 与系统指令透传：Paseo 的 MCP 服务与代理级系统指令会传给 agy，因此 Antigravity 代理可以直接使用 Paseo 的编排工具。
- 子代理交由 Paseo 托管：agy 自带的 `invoke_subagent` 创建的子代理在 Paseo 中不可见也不可控，配置伴随钩子后会在 Antigravity+ 会话中拦截该调用，并引导模型改用 Paseo 的 `create_agent`。依赖原生子代理的命令（如 `/teamwork`、`/boost`）在此不可用，需在 agy 终端中使用。
- 上下文用量与标题同步：输入框实时显示上下文窗口占用，并在轮次结束后自动将 agy 生成的会话短标题同步到未手动命名的 Paseo 代理。
- 运行中插话（Steering）：在当前轮次运行期间发送的消息会并入当前轮次继续执行，而不会打断重来。
- 按模型独立配置思考档位：每个模型拥有各自的思考档位选项（例如 Gemini 4 Neon 与 Gemini 4 Hydrogen 支持 XHigh，无档位变体的模型不显示档位）。

## 配置说明

伴随插件使用 `PreToolUse` 钩子拦截 `invoke_subagent`。Windows 钩子通过 PowerShell 运行，macOS 钩子通过 `/bin/sh` 运行。钩子仅在带有 `ANTIGRAVITY_PLUS=1` 的 Antigravity+ 进程中拒绝调用，并放行其他 agy 会话中的调用。各平台的配置方式见仓库 README。

## 额度监控

额度数据源运行官方的 `agy -p /usage --output-format json`，展示 agy 返回的额度组：Gemini 共享池和 Claude/GPT 的周限额与 5 小时限额，以及 Pro 套餐下 Gemini 4 Argon 的独立周限额。插件读取 Windows 凭据管理器（`gemini:antigravity`）或 macOS 钥匙串（服务名 `gemini`）里的 agy 登录凭据，只用来确认当前是哪个账号，不会把令牌发往任何地方。登录过期时，插件会执行一次 `agy models`，由 agy 刷新当前登录。

0.3.0 及更早版本会直接调用 Google 内部的 `cloudcode-pa.googleapis.com` 额度接口。Google 已告知第三方客户端这样做可能导致账号被标记，所以 0.3.1 删掉了这些调用。

## 手动切换账号

在侧栏的 **Antigravity+ 账号** 添加自己的 Google 消费者账号。完整登录凭据保存在 Windows 凭据管理器或 macOS 钥匙串中。切换会更新 agy 的共享登录，并保留本地会话历史。切换前先关闭独立 agy 和内置 Antigravity 提供商的会话，再等待 Antigravity+ 的轮次结束。账号页显示活跃账号最近的额度读数及备用账号的额度快照；额度用尽时可在输入框点 **额度 → 管理账号** 确认切换。

## 环境要求

- Paseo 0.16.0 及以上，已登录的 agy 1.5.8 及以上。
- 支持 Windows 和 macOS。Windows 下的凭据管理（额度与切号）及伴随插件钩子依赖系统自带的 Windows PowerShell。Linux 未经测试。

## 已知限制

- Antigravity+ 是独立的提供商，使用内置 Antigravity 提供商创建的旧代理不会自动迁移，可通过会话导入功能迁入。
- 在 Paseo 0.16.x（0.17.1 之前）中，耗时命令转为后台运行时轮次可能提前结束，且 Shell/读取/搜索工具以通用工具行显示；升级到 Paseo 0.17.1+ 即可自动获得后台命令保持运行状态与原生工具卡片。
