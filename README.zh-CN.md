# Antigravity+（Paseo 插件）

[English](./README.md) | 简体中文

Antigravity+ 为 [Paseo](https://paseo.sh) 提供基于 `agy acp`（Antigravity CLI 内置 Agent Client Protocol 服务）的增强型 Antigravity 提供商（`antigravity-plus`），并在 Paseo 的 Usage 面板中集成 Antigravity 额度监控。

## 核心特性

- **重启后保留会话历史**：通过 ACP `session/load` 重新打开并回放历史对话。
- **极速会话导入**：按当前工作区目录列出本地 `agy` CLI 会话（按更新时间倒序，带内存缓存与后台刷新），并自动过滤 `agy acp` 无法加载的 Antigravity 桌面端会话。
- **斜杠命令与技能**：在 Paseo 输入框中支持 `/goal`、`/plan`、`/compact`、`/grill-me` 等斜杠命令与自定义技能补全。
- **完善的权限模式**：支持 `agy` 原生的 **Default**（新建代理默认启用，执行前询问权限）、**Accept edits**、**Auto**、**Plan** 模式，并额外提供可选的 **Bypass** 模式（不进终端沙箱，在流层以 `allow_once` 自动批准权限请求，不污染全局授权配置）。可在会话中按需切换，或在 **Settings → Antigravity+** 中自定义默认权限模式。
- **按模型独立匹配思考档位**：根据 `agy` 的模型变体列表为不同模型提供专属档位（如 Gemini 4 Neon 与 Gemini 4 Hydrogen 支持 `XHigh`，GPT-OSS 与 Orchestrator 等无档位模型自动隐藏档位选择）。
- **运行中插话（Steering）**：在运行轮次中发送新消息会直接并入当前轮次继续执行，不会打断重来。
- **Paseo MCP 与子代理编排**：向 `agy` 透传 Paseo MCP 服务与系统指令，拦截不可见不可控的原生 `invoke_subagent`，引导模型统一使用 Paseo 的 `create_agent` 创建可见、可控的子代理标签页。
- **上下文圆环与额度面板**：输入框实时展示上下文窗口占用。Windows 和 macOS 的 Usage 面板展示套餐名称、Gemini 共享池、Claude/GPT 额度和 Gemini 4 Argon 独立周限额。

## 手动切换账号

在侧栏的 **Antigravity+ 账号** 添加自己的 Google 消费者账号。完整登录凭据保存在 Windows 凭据管理器或 macOS 钥匙串中。切换会更新 agy 的共享登录，也会影响独立运行的 agy 和 Paseo 内置的 Antigravity 提供商。切号前先关闭这些会话，再等待 Antigravity+ 的轮次全部结束。各账号共用本地会话历史。账号页用进度条显示剩余额度，并标注备用账号的快照时间。额度用尽时，**管理账号** 可推荐备用账号供你确认。插件跟随 Paseo 语言设置，提供简体中文和英文。

选中 **Antigravity+** 的模型后，即使还没发第一条消息，也可以点模型、模式旁边的 **额度** 查看当前账号的剩余进度条和重置时间。窗口较窄时，点输入框旁的设置图标，在底部面板里选 **额度**。已有代理也保留输入框上方的 **额度** 快捷入口。

## 环境要求

- **Paseo** `>= 0.16.0`
- **Antigravity CLI (`agy`)** `>= 1.5.8`，且已登录。通过 `PATH` 或 Windows 默认安装路径 `%LOCALAPPDATA%\agy\bin\agy.exe` 启动。
- **支持 Windows 和 macOS**。Windows 使用系统自带的 Windows PowerShell 和凭据管理器。Linux 未经测试。

## 安装方式

从 Paseo 官方插件商城安装（新版审核发布后同步包含 Windows 支持）：

```bash
paseo plugin add jule-x/antigravity-plus
```

或直接从 GitHub 安装最新主分支（已包含 macOS 与 Windows 支持）：

```bash
paseo plugin add git:jule-x/antigravity-plus
```

### Windows 本地源码安装

如果希望在 Windows 上从本地克隆目录安装，在仓库根目录的 PowerShell 中运行以下命令：

```powershell
$paseoCli = Join-Path $env:LOCALAPPDATA 'Programs\Paseo\resources\bin\paseo.cmd'
$agyCli = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
if (!(Test-Path -LiteralPath $agyCli -PathType Leaf)) { $agyCli = 'agy' }
npm ci
& $paseoCli plugin install (Get-Location).Path
& $agyCli plugin install (Join-Path (Get-Location).Path 'agy-plugin\windows')
& $paseoCli plugin ls antigravity-plus
```

本地 Paseo 需在 **Settings → Plugins** 启用插件。新建代理或导入会话时选择 **Antigravity+**。修改本地源码后，用 `plugin reload antigravity-plus` 重载。修改 Windows 钩子后，重新执行伴随插件的安装命令。

可以使用 Paseo 桌面端的 **Import session** 导入历史。脚本导入可在 **PowerShell 7** 中直接运行桌面版自带的 CLI，保留 Paseo 0.16.2 的 `paseo.cmd` 可能丢掉的 JSON 引号。将 `$sessionId` 设置为 agy 原生会话 ID，`$cwd` 设置为该会话的工作区目录。

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

### 配置伴随 `agy` 插件（推荐）

伴随插件在 Antigravity+ 会话中拦截 `agy` 内置的 `invoke_subagent`，引导模型通过 Paseo 的 `create_agent` 启动子代理。Windows 使用上面的伴随插件安装命令。macOS 将 `agy-plugin` 软链到 agy 的全局插件目录：

```bash
mkdir -p ~/.gemini/config/plugins
ln -sfn "$(ls -dt ~/.paseo/plugins/antigravity-plus/*/checkout/agy-plugin | head -n 1)" ~/.gemini/config/plugins/antigravity-plus-guard
```

如果是从本地克隆的目录安装的插件：

```bash
mkdir -p ~/.gemini/config/plugins
ln -sfn /absolute/path/to/antigravity-plus/agy-plugin ~/.gemini/config/plugins/antigravity-plus-guard
```

`paseo plugin update` 后安装目录会变化，请在每次更新后重新执行第一条命令。

该 `PreToolUse` 钩子仅在进程带有 `ANTIGRAVITY_PLUS=1` 环境变量（由 Antigravity+ 自动注入）时拒绝 `invoke_subagent`；在终端或 IDE 等其他环境下均返回 `{"decision":"allow"}`，不影响正常使用。

### 建议：关闭内置 Antigravity 提供商

由于用户插件无法覆盖内置提供商 ID，Antigravity+ 的 ID 为 `antigravity-plus`。你可以在 **Settings → Providers** 中关闭内置的 **Antigravity**，并通过 Import session 将之前的本地会话导入到 **Antigravity+** 中继续使用。

## 本地开发与验证

```bash
npm install
npm run typecheck
npm test
```

## 社区认可与致谢

本项目认可并感谢 [LINUX DO 社区](https://linux.do/) 的开源分享精神，欢迎各位佬友在社区内交流使用体验与改进建议。

## 开源协议

[MIT](./LICENSE)
