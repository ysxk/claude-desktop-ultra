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
- 思考档位增强：在模型思考值菜单中加入 `Max` 选项。
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
.\dist\ClaudeCN.exe launch --include-non-chat-models
.\dist\ClaudeCN.exe launch --lang=en-US
.\dist\ClaudeCN.exe launch --port 9229
```

- `--dry-run`：只准备运行时并打印启动路径，不真正启动 Claude。
- `--no-stop`：不关闭旧的 Claude / ClaudeCNRuntime 进程。
- `--no-shortcut`：跳过桌面快捷方式创建 / 更新。
- `--no-model-sync`：跳过第三方模型同步。
- `--include-non-chat-models`：同步模型时包含 image、embedding、tts、audio 等非聊天模型。
- `--lang=en-US`：临时用英文启动。
- `--port 9229`：开启 DevTools 调试端口，方便排查注入问题。

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
