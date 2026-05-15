# Claude Desktop Ultra

Claude Desktop Ultra 是一个 Claude Desktop 增强器。它通过非侵入式运行时覆盖实现增强能力：不直接改写 `C:\Program Files\WindowsApps`，而是在用户目录生成便携运行时副本，再启动增强后的 Claude。

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
- 自动桌面快捷方式：首次正常启动后会在 Windows 桌面创建 `Claude Desktop Ultra.lnk`，后续启动只复用 / 更新，不重复创建。
- 运行时状态记录：每次准备运行时都会写入 `claude-cn-runtime.json`，记录图标、语言、Max 档位、主进程注入和 preload 注入是否成功。

## 使用方法

双击运行：

```powershell
.\dist\ClaudeCN.exe
```

命令行启动：

```powershell
.\dist\ClaudeCN.exe launch
```

## 交流群

- QQ 群：AI 技术交流
- 群号：837772867
- 欢迎交流 Claude Desktop Ultra、Claude Desktop 增强、第三方模型接入和本地 AI 工具玩法。

![QQ 群二维码](docs/qrcode_1778832525816.jpg)

## 常用命令

```powershell
npm run detect
npm run audit
npm run launch
npm run build:exe
```

打包后也可以直接使用 exe：

```powershell
.\dist\ClaudeCN.exe detect
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
- `--port 9229`：开启 DevTools 调试端口，方便排查注入问题。

## 第三方模型配置

如果目标电脑已经在“开发者模式 → 配置第三方推理”里配置过 Gateway，直接运行：

```powershell
.\dist\ClaudeCN.exe models
```

如果目标电脑还没有配置，可以用命令写入基础配置：

```powershell
.\dist\ClaudeCN.exe models --gateway-base-url "https://你的网关地址" --gateway-api-key "你的 API Key" --models "gpt-4o,gemini-2.5-pro,deepseek-chat"
```

也可以用环境变量，避免把 Key 放在命令行历史里：

```powershell
$env:CLAUDE_ULTRA_GATEWAY_BASE_URL="https://你的网关地址"
$env:CLAUDE_ULTRA_GATEWAY_API_KEY="你的 API Key"
$env:CLAUDE_ULTRA_MODELS="gpt-4o,gemini-2.5-pro,deepseek-chat"
.\dist\ClaudeCN.exe models
```

## 常见问题

- 别的电脑没有解锁模型：通常是那台电脑没有 Claude-3p Gateway 配置、`configLibrary/_meta.json` 缺失，或 `/v1/models` 读取失败。先运行 `.\dist\ClaudeCN.exe models --gateway-base-url "网关地址" --gateway-api-key "Key" --models "gpt-4o"`，新版会自动修复配置索引并切到 3P 模式。
- 别的电脑没有 `Max` 思考值：请运行新版 exe，启动日志里应出现 `Max 思考档位增强已写入`，同时 `claude-cn-runtime.json` 里的 `effortStats.rules` 不应为空。
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

## 运行时位置

Claude Desktop Ultra 不改写 WindowsApps 内的 Claude 安装目录。增强后的运行时会生成在：

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

- Sub Agent 激活：解锁 / 接入 Claude Desktop 内部的 Sub Agent 能力，让增强器可以显示并启用更多 agent 编排入口。
- 自定义 1m 上下文解锁：允许用户配置并启用更长上下文窗口。
