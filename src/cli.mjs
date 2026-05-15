import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { detectClaude, isClaudeRunning } from "./adapters/claude-desktop.mjs";
import { findAvailablePort, waitForCdp, watchAndInject } from "./cdp.mjs";
import { buildInjectionSource } from "./injection-source.mjs";
import { auditLocale, loadProfile, readEnglishLocale, writeMissingTemplate } from "./locale.mjs";
import { prepareMacPortableRuntime, preparePortableRuntime } from "./portable-runtime.mjs";
import { runWindowsSelfTest } from "./self-test.mjs";
import { syncThirdPartyModels } from "./third-party-models.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

const logger = {
  info: (message) => console.log(`[claude-cn] ${message}`),
  warn: (message) => console.warn(`[claude-cn] ${message}`)
};

const appDisplayName = "Claude ultra";

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "launch";
  const flags = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      (flags._ ??= []).push(arg);
      continue;
    }

    const optionText = arg.slice(2);
    const equalsIndex = optionText.indexOf("=");
    const rawName = equalsIndex >= 0 ? optionText.slice(0, equalsIndex) : optionText;
    const inlineValue = equalsIndex >= 0 ? optionText.slice(equalsIndex + 1) : undefined;
    const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }

  return { command, flags };
}

function printHelp() {
  console.log(`
Claude ultra - Claude Desktop 增强器

用法：
  node ./bin/claude-cn.mjs detect
  node ./bin/claude-cn.mjs doctor [--skip-runtime]
  node ./bin/claude-cn.mjs audit [--write-template]
  node ./bin/claude-cn.mjs models [--include-non-chat-models] [--no-model-probe]
  node ./bin/claude-cn.mjs models --gateway-base-url <url> --gateway-api-key <key> --models <model1,model2>
  node ./bin/claude-cn.mjs launch [--profile profiles/zh-CN.json] [--no-stop] [--no-shortcut]
  node ./bin/claude-cn.mjs attach --port 9229

说明：
  - Microsoft Store/MSIX 版会在用户目录创建便携运行时，复制 Claude 资源并覆盖 locale，不修改 WindowsApps。
  - macOS 会创建 Claude ultra 便携增强运行时，并使用独立用户数据目录避免访问原 Claude 钥匙串项。
  - 原版 Claude.app 当前会拦截未授权 CDP 调试参数；--experimental-cdp 仅保留用于验证。
  - classic 安装版仍使用 127.0.0.1 DevTools 端口注入 DOM 汉化层。
  - 第三方 Gateway 会优先探测可用模型并放到模型列表第一位，避免健康检查误选无权限模型。
  - doctor 会用 deepseek-v4-flash 自检汉化、模型解锁、Max 思考值和旧版配置迁移。
`);
}

async function requireClaude() {
  const app = await detectClaude();
  if (!app) {
    throw new Error("没有检测到 Claude Desktop。请确认已安装 Claude，或补充 classic 安装路径适配。");
  }
  return app;
}

async function runDetect() {
  const app = await requireClaude();
  console.log(JSON.stringify(app, null, 2));
}

async function runAudit(flags) {
  const app = await requireClaude();
  const { auditDictionary } = await loadProfile(rootDir, flags.profile);
  const { localePath, locale } = await readEnglishLocale(app);
  const result = auditLocale(locale, auditDictionary);

  logger.info(`Claude: ${app.version || "unknown"} (${app.kind})`);
  logger.info(`英文 locale: ${localePath}`);
  logger.info(`官方字符串: ${result.total}`);
  logger.info(`已翻译: ${result.translated.length}`);
  logger.info(`缺失: ${result.missing.length}`);
  logger.info(`疑似过期: ${result.stale.length}`);

  if (flags.writeTemplate) {
    const outputPath = await writeMissingTemplate(rootDir, app, result.missing);
    logger.info(`缺失模板已写入：${outputPath}`);
  } else if (result.missing.length > 0) {
    logger.info("可运行 `npm run audit -- --write-template` 生成缺失翻译模板。");
  }
}

async function buildSource(flags) {
  const { profile, dictionary } = await loadProfile(rootDir, flags.profile);
  const locale = resolveLocale(profile, flags);
  return {
    profile,
    source: buildInjectionSource({
      profile,
      dictionary,
      launchLocale: locale,
      localeOverride: shouldOverrideLocale(profile, flags)
    })
  };
}

function buildRemoteDebuggingArgs(port, flags = {}) {
  const args = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`
  ];

  if (flags.userDataDir) {
    args.push(`--user-data-dir=${path.resolve(flags.userDataDir)}`);
  }

  return args;
}

function launchClaude(app, port, flags) {
  const args = buildRemoteDebuggingArgs(port, flags);

  logger.info(`启动 Claude：${app.executable}`);
  logger.info(`DevTools 端口：127.0.0.1:${port}`);

  const child = spawn(app.executable, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CLAUDE_CN_OVERLAY: "1"
    }
  });
  child.once("error", (error) => {
    logger.warn(`启动 Claude 进程失败：${error.message}`);
  });
  child.unref();
}

async function launchMacClaude(app, port, flags) {
  const args = buildRemoteDebuggingArgs(port, flags);

  logger.info(`启动 Claude.app：${app.installLocation}`);
  logger.info(`DevTools 端口：127.0.0.1:${port}`);

  await execFileAsync("open", ["-a", app.installLocation, "--args", ...args], {
    env: {
      ...process.env,
      CLAUDE_CN_OVERLAY: "cdp"
    },
    maxBuffer: 1024 * 1024
  });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function stopProcesses(processNames) {
  const uniqueNames = [...new Set(processNames.filter(Boolean))]
    .map((name) => name.replace(/[^\w.-]/g, ""))
    .filter(Boolean);
  if (uniqueNames.length === 0) {
    return;
  }

  if (process.platform === "darwin") {
    for (const name of uniqueNames) {
      try {
        await execFileAsync("pkill", ["-x", name], { maxBuffer: 1024 * 1024 });
      } catch {
        // pkill exits non-zero when no matching process exists.
      }
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      let stillRunning = false;
      for (const name of uniqueNames) {
        try {
          const { stdout } = await execFileAsync("pgrep", ["-x", name], { maxBuffer: 1024 * 1024 });
          stillRunning ||= Boolean(stdout.trim());
        } catch {
          // pgrep exits non-zero when no matching process exists.
        }
      }
      if (!stillRunning) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return;
  }

  if (process.platform !== "win32") {
    return;
  }

  const names = uniqueNames.join(",");
  const script = `
$ErrorActionPreference = "SilentlyContinue"
Get-Process -Name ${names} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(15)
do {
  $running = Get-Process -Name ${names} -ErrorAction SilentlyContinue
  if (-not $running) {
    break
  }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
exit 0
`;

  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    logger.warn(`旧进程清理未完全成功，继续启动：${error.message}`);
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findPidsByPattern(pattern) {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", pattern], { maxBuffer: 1024 * 1024 });
    return stdout
      .trim()
      .split(/\s+/)
      .map((pid) => Number(pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

async function stopMacRuntimeApp(runtimeApp) {
  if (process.platform !== "darwin" || !runtimeApp) {
    return;
  }

  const pattern = escapeRegex(runtimeApp);
  let pids = await findPidsByPattern(pattern);
  if (pids.length === 0) {
    return;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    pids = await findPidsByPattern(pattern);
    if (pids.length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  for (const pid of await findPidsByPattern(pattern)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

async function macSupportsArm64() {
  if (process.platform !== "darwin") {
    return false;
  }

  try {
    const { stdout } = await execFileAsync("sysctl", ["-in", "hw.optional.arm64"], { maxBuffer: 1024 * 1024 });
    return stdout.trim() === "1";
  } catch {
    return os.arch() === "arm64";
  }
}

function resolveLocale(profile, flags = {}) {
  return flags.locale || flags.lang || profile.locale || "zh-CN";
}

function shouldOverrideLocale(profile, flags = {}) {
  return Boolean(flags.locale || flags.lang || profile.localeOverride);
}

function optionalFlagValue(value) {
  return value && value !== true ? value : undefined;
}

function powershellString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function resolveShortcutLaunchTarget(rootDir) {
  if (process.pkg) {
    return {
      targetPath: process.execPath,
      arguments: "launch",
      workingDirectory: path.dirname(process.execPath)
    };
  }

  return {
    targetPath: process.execPath,
    arguments: `"${path.join(rootDir, "bin", "claude-cn.mjs")}" launch`,
    workingDirectory: rootDir
  };
}

async function ensureDesktopShortcut(rootDir, options = {}) {
  const launchTarget = resolveShortcutLaunchTarget(rootDir);
  const iconPath = options.iconPath || launchTarget.targetPath;
  const legacyScriptPath = path.join(rootDir, "scripts", "Start-ClaudeCN.ps1");
  const script = `
$ErrorActionPreference = "Stop"
$targetPath = ${powershellString(launchTarget.targetPath)}
$argumentsText = ${powershellString(launchTarget.arguments)}
$workingDirectory = ${powershellString(launchTarget.workingDirectory)}
$iconPath = ${powershellString(iconPath)}
$legacyScriptPath = ${powershellString(legacyScriptPath)}
$shortcutName = ${powershellString(`${appDisplayName}.lnk`)}
$legacyNames = @("Claude ultra.lnk", "Claude Desktop Ultra.lnk", "Claude CN.lnk")
$description = ${powershellString(`${appDisplayName} - non-invasive Claude Desktop enhancer`)}

$shell = New-Object -ComObject WScript.Shell

function Normalize-Path([string] $value) {
  if ([string]::IsNullOrWhiteSpace($value)) {
    return ""
  }
  try {
    return [IO.Path]::GetFullPath($value).TrimEnd("\\").ToLowerInvariant()
  } catch {
    return $value.Trim().TrimEnd("\\").ToLowerInvariant()
  }
}

function Is-UltraShortcut($file) {
  try {
    $shortcut = $shell.CreateShortcut($file.FullName)
    $name = $file.Name
    $target = Normalize-Path $shortcut.TargetPath
    $arguments = "$($shortcut.Arguments)"
    $existingDescription = "$($shortcut.Description)"
    $isSameTarget = $target -eq (Normalize-Path $targetPath)
    $isLegacyScript = $arguments.IndexOf($legacyScriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $isMarked = $existingDescription.IndexOf("Claude ultra", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      $existingDescription.IndexOf("Claude Desktop Ultra", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      $existingDescription.IndexOf("non-invasive zh-CN overlay", [StringComparison]::OrdinalIgnoreCase) -ge 0
    $isKnownName = $legacyNames -contains $name
    return $isSameTarget -or $isLegacyScript -or ($isKnownName -and $isMarked) -or ($name -eq $shortcutName)
  } catch {
    return $false
  }
}

$userDesktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
if ([string]::IsNullOrWhiteSpace($userDesktop)) {
  $userDesktop = [Environment]::GetFolderPath("Desktop")
}
if ([string]::IsNullOrWhiteSpace($userDesktop)) {
  throw "Cannot resolve user desktop path"
}
[IO.Directory]::CreateDirectory($userDesktop) | Out-Null

$desktopDirs = New-Object 'System.Collections.Generic.List[string]'
$desktopDirs.Add($userDesktop)
$commonDesktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)
if (-not [string]::IsNullOrWhiteSpace($commonDesktop) -and $commonDesktop -ne $userDesktop) {
  $desktopDirs.Add($commonDesktop)
}

$existing = $null
foreach ($desktopDir in $desktopDirs) {
  if (-not [IO.Directory]::Exists($desktopDir)) {
    continue
  }
  $existing = Get-ChildItem -LiteralPath $desktopDir -Filter "*.lnk" -File -ErrorAction SilentlyContinue |
    Where-Object { Is-UltraShortcut $_ } |
    Select-Object -First 1
  if ($existing) {
    break
  }
}

if ($existing) {
  $shortcutPath = $existing.FullName
  $created = $false
} else {
  $shortcutPath = Join-Path $userDesktop $shortcutName
  $created = $true
}

$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.Arguments = $argumentsText
$shortcut.WorkingDirectory = $workingDirectory
if (-not [string]::IsNullOrWhiteSpace($iconPath) -and [IO.File]::Exists($iconPath)) {
  if ([IO.Path]::GetExtension($iconPath).Equals(".ico", [StringComparison]::OrdinalIgnoreCase)) {
    $shortcut.IconLocation = $iconPath
  } else {
    $shortcut.IconLocation = "$iconPath,0"
  }
}
$shortcut.Description = $description
$shortcut.Save()

[pscustomobject]@{
  created = $created
  shortcutPath = $shortcutPath
  targetPath = $targetPath
  arguments = $argumentsText
  iconPath = $iconPath
} | ConvertTo-Json -Compress
`;

  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  const output = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  return output ? JSON.parse(output) : null;
}

async function ensureDesktopShortcutForLaunch(options = {}, flags = {}) {
  if (flags.noShortcut || flags.dryRun) {
    return null;
  }

  if (process.platform !== "win32") {
    return null;
  }

  try {
    const shortcut = await ensureDesktopShortcut(rootDir, options);
    if (shortcut?.created) {
      logger.info(`桌面快捷方式已创建：${shortcut.shortcutPath}`);
    } else if (shortcut?.shortcutPath) {
      logger.info(`桌面快捷方式已存在，已复用：${shortcut.shortcutPath}`);
    }
    return shortcut;
  } catch (error) {
    logger.warn(`桌面快捷方式创建失败，继续启动：${error.message}`);
    return null;
  }
}

function launchPortableRuntime(runtime, profile, options = {}) {
  const locale = options.locale || profile.locale || "zh-CN";
  const args = [`--lang=${locale}`];
  if (options.port) {
    args.push(...buildRemoteDebuggingArgs(options.port));
  }

  const child = spawn(runtime.runtimeExe, args, {
    cwd: runtime.runtimeDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CLAUDE_CN_OVERLAY: "portable-locale",
      CLAUDE_CN_STATUS_DIR: runtime.runtimeDir,
      LANG: locale
    }
  });

  child.once("error", (error) => {
    logger.warn(`启动便携 Claude 运行时失败：${error.message}`);
  });
  child.unref();
  return child.pid;
}

function launchMacPortableRuntime(runtime, profile, options = {}) {
  const locale = options.locale || profile.locale || "zh-CN";
  const runtimeArgs = [`--lang=${locale}`];
  const command = options.forceArm64 ? "/usr/bin/arch" : runtime.runtimeExe;
  const args = options.forceArm64
    ? ["-arm64", runtime.runtimeExe, ...runtimeArgs]
    : runtimeArgs;
  const child = spawn(command, args, {
    cwd: path.dirname(runtime.runtimeExe),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CLAUDE_CN_OVERLAY: "mac-portable-locale",
      CLAUDE_CN_STATUS_DIR: runtime.runtimeDir,
      CLAUDE_USER_DATA_DIR: runtime.userDataDir,
      LANG: locale
    }
  });

  child.once("error", (error) => {
    logger.warn(`启动 macOS 便携 Claude 运行时失败：${error.message}`);
  });
  child.unref();
  return child.pid;
}

async function runAttach(flags) {
  const port = Number(flags.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("attach 需要 `--port <端口>`。");
  }

  const { profile, source } = await buildSource(flags);
  await waitForCdp(port);
  logger.info(`已连接 Claude DevTools，语言配置：${profile.name || profile.locale}`);
  logger.info("保持此终端开启，插件会持续注入新窗口。按 Ctrl+C 停止注入器。");
  await watchAndInject({
    port,
    source,
    intervalMs: profile.pollIntervalMs ?? 1200,
    logger
  });
}

async function runMsixPortableLaunch(app, flags) {
  const { profile, dictionary } = await loadProfile(rootDir, flags.profile);
  const locale = resolveLocale(profile, flags);
  const injectionSource = flags.noPreloadPatch
    ? null
    : buildInjectionSource({ profile, dictionary, launchLocale: locale, localeOverride: shouldOverrideLocale(profile, flags) });

  if (!flags.noStop) {
    logger.info("正在关闭旧的 Claude/ClaudeCNRuntime 进程，避免单实例冲突。");
    await stopProcesses(["Claude", "ClaudeCNRuntime"]);
  }

  if (!flags.noModelSync) {
    await runModelSync({
      includeNonChatModels: flags.includeNonChatModels,
      noModelProbe: flags.noModelProbe,
      modelProbeLimit: flags.modelProbeLimit,
      gatewayTimeoutMs: flags.gatewayTimeoutMs,
      models: flags.models ?? flags.model,
      gatewayBaseUrl: flags.gatewayBaseUrl,
      gatewayApiKey: flags.gatewayApiKey,
      gatewayAuthScheme: flags.gatewayAuthScheme,
      inferenceProvider: flags.inferenceProvider
    });
  }

  logger.info("正在准备用户目录内的便携中文运行时。首次运行会解压 Electron，可能需要几十秒。");
  const runtime = await preparePortableRuntime(rootDir, app, dictionary, { injectionSource, locale: profile.locale || "zh-CN" });
  logger.info(`运行时图标已写入：${runtime.iconStats.patched} 个入口。`);
  logger.info(`中文资源已写入：${runtime.localeStats.translated}/${runtime.localeStats.total} 条。`);
  logger.info(`原生语言设置已加入中文：${runtime.nativeLanguageStats.patched} 个入口。`);
  if (runtime.effortStats.patched > 0) {
    logger.info(`Max 思考档位增强已写入：${runtime.effortStats.patched} 个入口（${runtime.effortStats.rules?.join(", ") || "legacy"}）。`);
  } else {
    logger.warn("Max 思考档位增强未命中当前 Claude 资源；请把 claude-cn-runtime.json 发给开发者排查。");
  }
  logger.info(`便携兼容增强已写入：${runtime.compatibilityStats.patched} 个入口。`);
  logger.info(`主进程汉化注入已写入：${runtime.mainProcessStats.patched} 个入口。`);
  logger.info(`预加载汉化脚本已写入：${runtime.preloadStats.patched} 个入口。`);

  if (flags.dryRun) {
    logger.info(`将启动：${runtime.runtimeExe}`);
    logger.info(`工作目录：${runtime.runtimeDir}`);
    return;
  }

  const port = flags.port && flags.port !== true ? Number(flags.port) : null;
  if (port !== null && (!Number.isInteger(port) || port <= 0)) {
    throw new Error("端口无效。请使用 `--port 9229` 这样的正整数。");
  }

  await ensureDesktopShortcutForLaunch({ iconPath: runtime.iconStats?.iconPath || runtime.runtimeExe }, flags);
  const processId = launchPortableRuntime(runtime, profile, { locale, port });
  logger.info(`已启动便携 Claude 中文版：PID ${processId}`);
  logger.info(`运行时目录：${runtime.runtimeDir}`);
}

function macClaude3pRoot() {
  return path.join(os.homedir(), "Library", "Application Support", "Claude-3p");
}

async function seedMacPortableUserData(userDataDir) {
  const sourceRoot = macClaude3pRoot();
  const linked = [];
  const entries = [
    "claude_desktop_config.json",
    "configLibrary",
    "developer_settings.json",
    "extensions-installations.json",
    "Claude Extensions Settings",
    "claude-code",
    "local-agent-mode-sessions",
    "git-worktrees.json",
    "cowork-enabled-cli-ops.json"
  ];

  await fs.mkdir(userDataDir, { recursive: true });
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry);
    const destination = path.join(userDataDir, entry);
    if (!(await pathExists(source)) || await pathExists(destination)) {
      continue;
    }
    await fs.symlink(source, destination);
    linked.push(entry);
  }

  return { sourceRoot, userDataDir, linked };
}

async function cleanupMacPortableBrowserState(userDataDir) {
  const entries = [
    "blob_storage",
    "Cache",
    "Code Cache",
    "Cookies",
    "Cookies-journal",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "DIPS",
    "DIPS-wal",
    "GPUCache",
    "IndexedDB",
    "Local State",
    "Local Storage",
    "Network Persistent State",
    "Partitions",
    "Preferences",
    "Service Worker",
    "Session Storage",
    "Shared Dictionary",
    "SharedStorage",
    "TransportSecurity",
    "Trust Tokens",
    "Trust Tokens-journal",
    "WebStorage"
  ];
  const removed = [];

  for (const entry of entries) {
    const target = path.join(userDataDir, entry);
    if (!(await pathExists(target))) {
      continue;
    }

    await fs.rm(target, { recursive: true, force: true });
    removed.push(entry);
  }

  return { removed };
}

async function cleanupMacPortableKeychainItem() {
  if (process.platform !== "darwin") {
    return { removed: false };
  }

  try {
    await execFileAsync("security", [
      "delete-generic-password",
      "-s",
      `${appDisplayName} Safe Storage`,
      "-a",
      `${appDisplayName} Key`
    ], { maxBuffer: 1024 * 1024 });
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

async function runMacPortableLaunch(app, flags) {
  const { profile, dictionary } = await loadProfile(rootDir, flags.profile);
  const locale = resolveLocale(profile, flags);
  const injectionSource = flags.noPreloadPatch
    ? null
    : buildInjectionSource({ profile, dictionary, launchLocale: locale, localeOverride: shouldOverrideLocale(profile, flags) });

  if (!flags.noStop) {
    logger.info("正在关闭旧的 Claude/ClaudeCNRuntime 进程，避免单实例冲突。");
    await stopProcesses(["Claude"]);
  }

  logger.info("正在准备用户目录内的 macOS Claude ultra 运行时。首次运行会复制 Claude.app，可能需要几十秒。");
  const runtime = await prepareMacPortableRuntime(rootDir, app, dictionary, { injectionSource, locale: profile.locale || "zh-CN" });
  logger.info(`运行时身份：${runtime.identityStats?.appName || "Claude ultra"} (${runtime.identityStats?.bundleIdentifier || "unknown"})。`);
  const sharedConfigRoot = await pathExists(path.join(macClaude3pRoot(), "claude_desktop_config.json"))
    ? macClaude3pRoot()
    : null;
  if (sharedConfigRoot) {
    const seededUserData = await seedMacPortableUserData(runtime.userDataDir);
    logger.info(`Claude ultra 将通过符号链接共享原版 3P 配置：${sharedConfigRoot}`);
    if (seededUserData.linked.length > 0) {
      logger.info(`已链接共享配置/状态：${seededUserData.linked.join(", ")}。`);
    }
  } else {
    logger.warn("未发现原版 Claude-3p 配置；按非侵入式规则，本次不会创建或复制配置文件。");
  }

  if (!flags.noModelSync) {
    logger.info("已跳过模型同步写入，避免创建或修改配置文件。");
  }

  logger.info(`中文资源已写入：${runtime.localeStats.translated}/${runtime.localeStats.total} 条。`);
  logger.info(`原生语言设置已加入中文：${runtime.nativeLanguageStats.patched} 个入口。`);
  if (runtime.effortStats.patched > 0) {
    logger.info(`Max 思考档位增强已写入：${runtime.effortStats.patched} 个入口（${runtime.effortStats.rules?.join(", ") || "legacy"}）。`);
  } else {
    logger.warn("Max 思考档位增强未命中当前 Claude 资源；请把 claude-cn-runtime.json 发给开发者排查。");
  }
  logger.info(`便携兼容增强已写入：${runtime.compatibilityStats.patched} 个入口。`);
  logger.info(`主进程汉化注入已写入：${runtime.mainProcessStats.patched} 个入口。`);
  logger.info(`预加载汉化脚本已写入：${runtime.preloadStats.patched} 个入口。`);

  if (flags.dryRun) {
    logger.info(`将启动：${runtime.runtimeExe}`);
    logger.info(`工作目录：${runtime.runtimeDir}`);
    logger.info(`用户数据目录：${runtime.userDataDir}`);
    return;
  }

  await stopMacRuntimeApp(runtime.runtimeApp);

  const browserStateCleanup = await cleanupMacPortableBrowserState(runtime.userDataDir);
  if (browserStateCleanup.removed.length > 0) {
    logger.info(`已清理 Claude ultra 浏览器状态，避免读取旧钥匙串项：${browserStateCleanup.removed.join(", ")}。`);
  }
  const keychainCleanup = await cleanupMacPortableKeychainItem();
  if (keychainCleanup.removed) {
    logger.info("已移除 Claude ultra 专用 Safe Storage 钥匙串项，将由当前运行时重新生成。");
  }

  const forceArm64 = await macSupportsArm64();
  if (forceArm64 && process.arch !== "arm64") {
    logger.info("检测到 Apple Silicon，已强制以 arm64 启动 Claude ultra 运行时。");
  }
  const processId = launchMacPortableRuntime(runtime, profile, { locale, forceArm64 });
  logger.info(`已启动 macOS 便携 Claude 中文版：PID ${processId}`);
  logger.info(`运行时目录：${runtime.runtimeDir}`);
  logger.info(`用户数据目录：${runtime.userDataDir}`);
}

async function runModelSync(flags = {}) {
  try {
    const modelProbeLimit = flags.modelProbeLimit && flags.modelProbeLimit !== true
      ? Number(flags.modelProbeLimit)
      : undefined;
    const gatewayTimeoutMs = flags.gatewayTimeoutMs && flags.gatewayTimeoutMs !== true
      ? Number(flags.gatewayTimeoutMs)
      : undefined;
    const result = await syncThirdPartyModels({
      rootDir: flags.rootDir,
      includeNonChatModels: Boolean(flags.includeNonChatModels),
      probeModels: !flags.noModelProbe,
      modelProbeLimit,
      gatewayTimeoutMs,
      models: optionalFlagValue(flags.models ?? flags.model),
      gatewayBaseUrl: optionalFlagValue(flags.gatewayBaseUrl),
      gatewayApiKey: optionalFlagValue(flags.gatewayApiKey),
      gatewayAuthScheme: optionalFlagValue(flags.gatewayAuthScheme),
      inferenceProvider: optionalFlagValue(flags.inferenceProvider)
    });
    if (result.modelCount > 0) {
      logger.info(`第三方模型已同步：${result.modelCount} 个（provider: ${result.provider || "unknown"}，${result.changed ? "已更新" : "已是最新"}）。`);
      if (result.verifiedModel) {
        logger.info(`网关健康检查模型已优先使用：${result.verifiedModel}`);
      } else if (result.probeSkipped === "missing-static-gateway-credential") {
        logger.info("模型连通性探测已跳过：未发现静态 Gateway API Key。");
      } else if (result.probeSkipped === "disabled") {
        logger.info("模型连通性探测已跳过。");
      } else if (result.probeFailures?.length > 0) {
        const failedModels = result.probeFailures.map((failure) => failure.model).filter(Boolean).join(", ");
        logger.warn(`模型连通性探测未找到可用模型：${failedModels || "unknown"}`);
      }
      if (result.fetchError) {
        logger.warn(`读取 Gateway /v1/models 失败，已使用现有/手动模型列表：${result.fetchError}`);
      }
      if (result.metaChanged) {
        logger.info(`已创建 / 修复 Claude-3p 配置索引：${result.metaPath}`);
      }
      if (result.legacyConfigMigrated) {
        logger.info(`已迁移旧版默认配置：${result.legacyConfigPath}`);
      }
      if (result.deploymentMode?.changed) {
        logger.info(`已切换 Claude 第三方推理模式：${result.deploymentMode.path}`);
      }
      logger.info(`配置文件：${result.configPath}`);
    } else {
      logger.warn("没有同步到第三方模型；那台电脑还没有可用的 Claude-3p Gateway 模型配置。");
      logger.info(`配置文件：${result.configPath}`);
      logger.info(`配置索引：${result.metaPath}`);
      logger.info(`旧版默认配置：${result.legacyConfigPath}`);
      if (result.deploymentMode?.path) {
        logger.info(`第三方推理模式文件：${result.deploymentMode.path}`);
      }
      if (!result.configExists) {
        logger.warn("未发现 Claude-3p 配置文件；需要先在开发者模式里配置第三方推理，或用命令写入。");
      }
      if (result.missingFields?.length > 0) {
        logger.warn(`缺少配置项：${result.missingFields.join(", ")}`);
      }
      if (result.fetchError) {
        logger.warn(`读取 Gateway /v1/models 失败：${result.fetchError}`);
      }
      logger.info("可在目标电脑运行：ClaudeCN.exe models --gateway-base-url <url> --gateway-api-key <key> --models <model1,model2>");
    }
    return result;
  } catch (error) {
    logger.warn(`第三方模型同步失败：${error.message}`);
    return null;
  }
}

async function runLaunch(flags) {
  const app = await requireClaude();

  if (app.kind === "msix" && !flags.experimentalCdp) {
    await runMsixPortableLaunch(app, flags);
    return;
  }

  if (app.kind === "mac" && !flags.experimentalCdp) {
    await runMacPortableLaunch(app, flags);
    return;
  }

  const port = flags.port && flags.port !== true ? Number(flags.port) : await findAvailablePort();
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("端口无效。请使用 `--port 9229` 这样的正整数。");
  }

  const { profile, source } = await buildSource(flags);

  if (flags.dryRun) {
    if (app.kind === "mac") {
      logger.info(`将通过 macOS open 启动：${app.installLocation}`);
    } else {
      logger.info(`将启动：${app.executable}`);
    }
    logger.info(`参数：${buildRemoteDebuggingArgs(port, flags).join(" ")}`);
    return;
  }

  if (app.kind === "mac" && !flags.noModelSync) {
    await runModelSync({
      includeNonChatModels: flags.includeNonChatModels,
      noModelProbe: flags.noModelProbe,
      modelProbeLimit: flags.modelProbeLimit,
      gatewayTimeoutMs: flags.gatewayTimeoutMs,
      models: flags.models ?? flags.model,
      gatewayBaseUrl: flags.gatewayBaseUrl,
      gatewayApiKey: flags.gatewayApiKey,
      gatewayAuthScheme: flags.gatewayAuthScheme,
      inferenceProvider: flags.inferenceProvider
    });
  }

  if (!flags.noStop && process.platform === "darwin") {
    logger.info("正在关闭旧的 Claude 进程，避免单实例复用已有窗口。");
    await stopProcesses(["Claude"]);
  }

  const alreadyRunning = await isClaudeRunning();
  if (alreadyRunning && !flags.force) {
    throw new Error("Claude 已在运行。请先从托盘/任务管理器完全退出 Claude，再运行插件；如果已手动开启 DevTools 端口，可用 `attach --port <端口>`。");
  }

  await ensureDesktopShortcutForLaunch({ iconPath: app.executable }, flags);
  if (app.kind === "mac") {
    await launchMacClaude(app, port, flags);
  } else {
    launchClaude(app, port, flags);
  }
  await waitForCdp(port);
  logger.info(`汉化层已就绪：${profile.name || profile.locale}`);
  logger.info("保持此终端开启，插件会持续注入新窗口。按 Ctrl+C 停止注入器；退出 Claude 会关闭调试端口。");

  await watchAndInject({
    port,
    source,
    intervalMs: profile.pollIntervalMs ?? 1200,
    logger
  });
}

export async function main(argv) {
  const { command, flags } = parseArgs(argv);

  if (flags.help || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  process.on("SIGINT", () => {
    console.log("\n[claude-cn] 注入器已停止。Claude 本体不会被强制关闭。");
    process.exit(0);
  });

  switch (command) {
    case "detect":
      await runDetect();
      return;
    case "doctor":
    case "self-test":
      if (!["win32", "darwin"].includes(process.platform) && !flags.skipRuntime) {
        logger.info("当前平台暂不支持便携运行时自检，已自动跳过运行时检查。");
        flags.skipRuntime = true;
      }
      if (process.platform === "win32" && !flags.noStop && !flags.skipRuntime) {
        logger.info("正在关闭旧的 Claude/ClaudeCNRuntime 进程，避免运行时文件锁。");
        await stopProcesses(["Claude", "ClaudeCNRuntime"]);
      }
      await runWindowsSelfTest({ rootDir, flags, logger });
      return;
    case "audit":
      await runAudit(flags);
      return;
    case "models":
    case "sync-models":
      await runModelSync(flags);
      return;
    case "attach":
      await runAttach(flags);
      return;
    case "launch":
      await runLaunch(flags);
      return;
    default:
      throw new Error(`未知命令：${command}。运行 \`node ./bin/claude-cn.mjs help\` 查看用法。`);
  }
}
