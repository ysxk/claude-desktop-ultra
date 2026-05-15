# Claude Desktop 非侵入式汉化层设计

## 目标

- 不修改 `C:\Program Files\WindowsApps` 下的 Claude 文件。
- 不需要管理员权限，不替换 `app.asar`，不做 DLL 注入。
- 支持 Microsoft Store/MSIX 与后续 classic 安装形态的动态发现。
- Claude 升级后，自动重新检测安装目录与英文 locale，并用审计工具提示缺失翻译。

## 机制

1. `detect` 通过当前用户范围的 `Get-AppxPackage -Name Claude` 找到最新 Claude 包。
2. `launch` 使用 Claude 原始可执行文件启动，并附加：
   - `--remote-debugging-address=127.0.0.1`
   - `--remote-debugging-port=<随机端口或指定端口>`
3. 插件只连接本机 DevTools 端口，向页面和 webview 注入一个小型 DOM 翻译覆盖层。
4. 覆盖层使用精确字典和 `{placeholder}` 模板匹配翻译界面文本，并用 `MutationObserver` 处理动态 UI。

## 版本适配

- 安装路径不写死版本号，始终从系统包注册表动态获取。
- 翻译字典以英文原文为键；当 Claude 更新但 UI 文案不变时会继续生效。
- `audit` 会读取当前版本 `app\resources\en-US.json`，统计已翻译、缺失和过期条目。
- `audit --write-template` 会生成当前版本的缺失翻译模板，便于增量补齐。

## 边界

- 这是运行时覆盖层，不会改变 Claude 官方资源文件。
- 如果 Claude 已经在运行，必须完全退出后再用插件启动，否则主实例不会启用 DevTools 端口。
- 远程网页内容、图片文字、Canvas 文字、复杂富文本可能无法全部覆盖。
- DevTools 端口只绑定 `127.0.0.1`，但仍应视为本机调试入口；使用完退出 Claude 即可关闭。

