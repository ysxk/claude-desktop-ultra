# Claude ultra

Claude ultra 是一个 Claude Desktop 增强器。macOS 会在用户目录生成独立的 `Claude ultra.app` 增强运行时，并使用独立用户数据目录，避免以重签 Claude 的身份访问原 Claude 钥匙串项；Windows MSIX 仍使用用户目录内的便携运行时副本，不直接改写 `C:\Program Files\WindowsApps`。

## 已实现功能

- 非侵入式 MSIX 适配：自动检测 Microsoft Store / MSIX 版 Claude Desktop，复制资源到 `%LOCALAPPDATA%\ClaudeCNOverlay\runtime`，不需要管理员权限。
- 多版本适配：运行时目录按 Claude 版本和 Electron 版本隔离，补丁会扫描 Claude 的哈希资源文件，尽量避免固定版本路径失效。
- 可运行 exe：支持打包为 `dist\ClaudeCN.exe`，可双击启动，也可通过命令行启动、检测和调试。
- 原生中文语言选项：保留官方英文资源，并在 Claude 自带语言设置里额外加入 `简体中文 (zh-CN)`。
- 默认中文启动：默认以 `zh-CN` 启动 Claude，同时仍可从 Claude 原生语言设置切回其他语言。
- UI 汉化增强：写入 `zh-CN.json`，并通过主进程 / preload 注入补足设置页、开发者模式等动态界面的翻译。
- 第三方模型解锁：同步 Claude-3p Gateway 的 `/v1/models` 到 Claude-3p 配置，写入 `inferenceModels` 并关闭模型校验限制，让 Claude 显示非官方模型。
- 跨机器网关兼容：启动时会把更可能可用的第三方模型排到第一位，并在存在静态 Gateway API Key 时探测可用模型，避免 Claude 健康检查误选无权限的 Sonnet / Haiku / Opus。
- 模型同步诊断：如果目标电脑没有 Claude-3p Gateway 配置，会输出缺失项、配置文件路径和可直接运行的修复命令。
- 空白机器 3P 初始化：首次写入第三方模型时会自动创建 Claude 认可的 `configLibrary/_meta.json`，并把 `deploymentMode` 切到 `3p`。
- 旧版配置迁移：如果之前版本写过 `configLibrary/default.json`，新版会迁移到 Claude 真正读取的 UUID 配置文件。
- 思考档位增强：在模型思考值菜单中加入 `Max` 选项，并兼容新版 Claude 对 `modelSupportsMaxEffort` 的隐藏逻辑。
- Cowork 便携兼容：绕过 Ultra 便携运行时触发的 MSIX 安装来源误判；如果系统缺少虚拟机平台 / HCS 服务，仍会保留真实系统提示。
- 彩色应用图标：启动的 `ClaudeCNRuntime.exe` 会写入 Claude 官方彩色图标，避免任务栏显示空白或黑色托盘图标。
- 自动桌面快捷方式：首次正常启动后会在 Windows 桌面创建 `Claude ultra.lnk`，后续启动只复用 / 更新，不重复创建。
- 运行时状态记录：每次准备运行时都会写入 `claude-cn-runtime.json`，记录图标、语言、Max 档位、主进程注入和 preload 注入是否成功。
- Windows 自检：内置 `doctor` 命令，会用 `deepseek-v4-flash` 模拟 Gateway，验证汉化运行时、模型解锁、Max 思考值和旧版配置迁移。
- macOS 适配：自动检测 `/Applications/Claude.app` 或 `~/Applications/Claude.app`，生成 `Claude ultra.app` 增强运行时，并隔离用户数据以减少钥匙串权限提示。
- macOS DMG 分发：支持生成可拖拽安装的 `Claude-ultra-macos-<架构>.dmg`，挂载后可将 `Claude ultra.app` 拖入 Applications。
- Sub Agent 解锁：macOS 运行时会共享原版 Claude-3p 的 `local-agent-mode-sessions`、`claude-code` 和工作树状态，让增强版继续使用原版已启用的 agent / Code 能力。

## 最近更新

- macOS 非侵入式适配完成：`Claude ultra.app` 使用独立运行时身份和用户数据目录，同时通过符号链接持续共享原版 Claude-3p 配置与 Code / agent 状态，不直接修改原版配置文件。
- macOS 分发体验增强：新增 `npm run build:dmg`，生成带 `Applications` 入口的 DMG，用户双击后可以直接拖拽安装。
- Sub Agent / 本地 agent 状态解锁：增强版会复用原版 `local-agent-mode-sessions`、`claude-code`、`git-worktrees.json` 等状态，避免切到 Ultra 后 agent / Code 能力丢失。
- 修复 Code 标签缺失：macOS 运行时补齐 Claude Desktop User-Agent 标识，让 Claude 能正确识别桌面 Code 能力。
- 修复模型切换显示不同步：汉化注入现在会采纳 React 动态更新文本，模型列表打勾后右下角常驻模型名会同步更新。
- 修复 Max / 模型菜单兼容问题：避免 Max 思考档位补丁反转模型菜单主列表，也避免把模型列表塞进空主菜单。
- 修复 macOS 便携运行时兼容问题：绕过安装来源和虚拟化 entitlement 误判，并阻止共享配置场景下的运行时配置写入。
- 中文覆盖更完整：补齐设置、Claude Code、Cowork、隐私、能力、连接器、桌面常规、扩展高级和开发者 MCP 页面的说明、按钮、下拉选项与 placeholder 翻译。

## 使用方法

双击运行：

```powershell
.\dist\ClaudeCN.exe
```

命令行启动：

```powershell
.\dist\ClaudeCN.exe launch
```

macOS 直接运行源码：

```bash
npm run launch
```

如果 Claude 安装在自定义位置：

```bash
CLAUDE_DESKTOP_APP_PATH="/path/to/Claude.app" npm run launch
```

## 交流群

- QQ 群：AI 技术交流
- 群号：837772867
- 欢迎交流 Claude ultra、Claude Desktop 增强、第三方模型接入和本地 AI 工具玩法。

![QQ 群二维码](docs/qrcode_1778832525816.jpg)

## 常用命令

```powershell
npm run detect
npm run doctor
npm run audit
npm run launch
npm run build:exe
npm run build:mac
npm run build:dmg
```

打包后也可以直接使用 exe：

```powershell
.\dist\ClaudeCN.exe detect
.\dist\ClaudeCN.exe doctor
.\dist\ClaudeCN.exe launch
.\dist\ClaudeCN.exe launch --dry-run
.\dist\ClaudeCN.exe models
```

## 启动选项

```powershell
.\dist\ClaudeCN.exe launch --dry-run
.\dist\ClaudeCN.exe launch --no-stop
.\dist\ClaudeCN.exe launch --no-shortcut
.\dist\ClaudeCN.exe launch --no-model-sync
.\dist\ClaudeCN.exe launch --no-model-probe
.\dist\ClaudeCN.exe launch --model-probe-limit 8
.\dist\ClaudeCN.exe launch --include-non-chat-models
.\dist\ClaudeCN.exe launch --lang=en-US
.\dist\ClaudeCN.exe launch --port 9229
```

- `--dry-run`：只准备运行时并打印启动路径，不真正启动 Claude。
- `--no-stop`：不关闭旧的 Claude / ClaudeCNRuntime 进程。
- `--no-shortcut`：跳过桌面快捷方式创建 / 更新。
- `--no-model-sync`：跳过第三方模型同步。
- `--no-model-probe`：同步模型时不发送 `/v1/messages` 试探请求，只按模型名称排序。
- `--model-probe-limit 8`：最多试探前 N 个模型，默认 8。
- `--include-non-chat-models`：同步模型时包含 image、embedding、tts、audio 等非聊天模型。
- `--lang=en-US`：临时用英文启动。
- `--port 9229`：在 classic/CDP 调试路径中指定 DevTools 端口；macOS 默认运行时不依赖该端口。

## 第三方模型配置

如果目标电脑已经在“开发者模式 → 配置第三方推理”里配置过 Gateway，直接运行：

```powershell
.\dist\ClaudeCN.exe models
```

如果目标电脑还没有配置，可以用命令写入基础配置：

```powershell
.\dist\ClaudeCN.exe models --gateway-base-url "https://你的网关地址" --gateway-api-key "你的 API Key" --models "deepseek-v4-flash,gpt-4o,gemini-2.5-pro"
```

也可以用环境变量，避免把 Key 放在命令行历史里：

```powershell
$env:CLAUDE_ULTRA_GATEWAY_BASE_URL="https://你的网关地址"
$env:CLAUDE_ULTRA_GATEWAY_API_KEY="你的 API Key"
$env:CLAUDE_ULTRA_MODELS="deepseek-v4-flash,gpt-4o,gemini-2.5-pro"
.\dist\ClaudeCN.exe models
```

## 常见问题

- 别的电脑没有解锁模型：通常是那台电脑没有 Claude-3p Gateway 配置、`configLibrary/_meta.json` 缺失，或 `/v1/models` 读取失败。先运行 `.\dist\ClaudeCN.exe models --gateway-base-url "网关地址" --gateway-api-key "Key" --models "deepseek-v4-flash"`，新版会自动修复配置索引并切到 3P 模式。
- 不确定目标电脑是否可用：运行 `.\dist\ClaudeCN.exe doctor`，自检会用 `deepseek-v4-flash` 验证空白机器、旧版迁移、汉化运行时和 Max 思考值补丁。
- 别的电脑没有 `Max` 思考值：请运行新版启动器，启动日志里应出现 `Max 思考档位增强已写入`，同时 `claude-cn-runtime.json` 里的 `effortStats.rules` 不应为空。
- 别的电脑提示 `Gateway returned an error`：通常是网关健康检查选到了该账号无权限 / 无额度的模型。新版会优先选择可用第三方模型；仍失败时，打开“开发者模式 → 配置第三方推理”，把模型列表第一项改成网关实际能调用的模型。
- 别的电脑提示 `Reinstall required`：这是 Claude 对便携运行时的安装来源检测。Ultra 已绕过 MSIX 来源误判；如果仍提示，请确认目标电脑安装的是 Microsoft Store / MSIX 版 Claude Desktop，并重新运行新版 exe。

## 构建 exe

```powershell
npm run build:exe
```

生成文件：

```text
dist\ClaudeCN.exe
```

## macOS 支持

```bash
npm run detect
npm run launch
npm run build:mac
npm run build:dmg
```

生成文件：

```text
dist/Claude-ultra-macos-<当前架构>
dist/Claude-ultra-macos-<当前架构>.dmg
```

说明：

- macOS 会复制 `Claude.app` 到 `~/Library/Application Support/ClaudeCNOverlay/runtime/<版本>-mac/Claude ultra.app`，在副本中写入中文 locale、主进程注入和 preload 注入，不改原始 `/Applications/Claude.app`。
- `Claude ultra.app` 会使用 `~/Library/Application Support/ClaudeCNOverlay/runtime/<版本>-mac/user-data` 作为独立用户数据目录；首次使用可能需要重新登录 Claude，但不会直接读取原 Claude 的钥匙串项。
- 如果本机存在 `~/Library/Application Support/Claude-3p` 配置，macOS 运行时会通过符号链接共享 `claude_desktop_config.json`、`configLibrary`、`claude-code`、`local-agent-mode-sessions` 和工作树状态，保持原版与增强版持续共用配置。
- 默认会先关闭已有 Claude 进程，避免 Electron 单实例复用旧窗口；需要保留现有进程时可用 `--no-stop`。
- Windows MSIX 便携运行时、桌面 `.lnk` 快捷方式和 exe 图标写入仍只在 Windows 生效。
- `npm run build:dmg` 会生成可拖拽安装的 DMG，适合发给普通 macOS 用户；正式公开分发前仍建议使用 Developer ID 签名并完成 Apple notarization。

## 运行时位置

Claude ultra 不改写 WindowsApps 内的 Claude 安装目录。Windows/MSIX 或 macOS 的增强运行时会生成在：

```text
%LOCALAPPDATA%\ClaudeCNOverlay\runtime\<Claude版本>-electron-<Electron版本>
```

常见状态文件：

```text
%LOCALAPPDATA%\ClaudeCNOverlay\runtime\<版本>\claude-cn-runtime.json
%LOCALAPPDATA%\ClaudeCNOverlay\runtime\<版本>\claude-cn-injection-status.json
%LOCALAPPDATA%\ClaudeCNOverlay\runtime\<版本>\claude-cn-injection-last.json
```

## TODO

- 自定义 1m 上下文解锁：允许用户配置并启用更长上下文窗口。
