import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { detectClaude, isClaudeRunning } from "./adapters/claude-desktop.mjs";
import { findAvailablePort, waitForCdp, watchAndInject } from "./cdp.mjs";
import { buildInjectionSource } from "./injection-source.mjs";
import { auditLocale, loadProfile, readEnglishLocale, writeMissingTemplate } from "./locale.mjs";
import { preparePortableRuntime } from "./portable-runtime.mjs";
import { syncThirdPartyModels } from "./third-party-models.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

const logger = {
  info: (message) => console.log(`[claude-cn] ${message}`),
  warn: (message) => console.warn(`[claude-cn] ${message}`)
};

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
Claude Desktop 简体中文非侵入式汉化启动器

用法：
  node ./bin/claude-cn.mjs detect
  node ./bin/claude-cn.mjs audit [--write-template]
  node ./bin/claude-cn.mjs models [--include-non-chat-models] [--no-model-probe]
  node ./bin/claude-cn.mjs models --gateway-base-url <url> --gateway-api-key <key> --models <model1,model2>
  node ./bin/claude-cn.mjs launch [--profile profiles/zh-CN.json] [--no-stop] [--no-shortcut]
  node ./bin/claude-cn.mjs attach --port 9229

说明：
  - Microsoft Store/MSIX 版会在用户目录创建便携运行时，复制 Claude 资源并覆盖 locale，不修改 WindowsApps。
  - classic 安装版仍使用 127.0.0.1 DevTools 端口注入 DOM 汉化层。
  - 第三方 Gateway 会优先探测可用模型并放到模型列表第一位，避免健康检查误选无权限模型。
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

function launchClaude(app, port, flags) {
  const args = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`
  ];

  if (flags.userDataDir) {
    args.push(`--user-data-dir=${path.resolve(flags.userDataDir)}`);
  }

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

async function stopProcesses(processNames) {
  const uniqueNames = [...new Set(processNames.filter(Boolean))]
    .map((name) => name.replace(/[^\w.-]/g, ""))
    .filter(Boolean);
  if (uniqueNames.length === 0) {
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
$shortcutName = "Claude Desktop Ultra.lnk"
$legacyNames = @("Claude Desktop Ultra.lnk", "Claude CN.lnk")
$description = "Claude Desktop Ultra - non-invasive Claude Desktop enhancer"

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
    $isMarked = $existingDescription.IndexOf("Claude Desktop Ultra", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
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
    args.push("--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${options.port}`);
  }

  const child = spawn(runtime.runtimeExe, args, {
    cwd: runtime.runtimeDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CLAUDE_CN_OVERLAY: "portable-locale",
      LANG: locale
    }
  });

  child.once("error", (error) => {
    logger.warn(`启动便携 Claude 运行时失败：${error.message}`);
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

async function runModelSync(flags = {}) {
  try {
    const modelProbeLimit = flags.modelProbeLimit && flags.modelProbeLimit !== true
      ? Number(flags.modelProbeLimit)
      : undefined;
    const gatewayTimeoutMs = flags.gatewayTimeoutMs && flags.gatewayTimeoutMs !== true
      ? Number(flags.gatewayTimeoutMs)
      : undefined;
    const result = await syncThirdPartyModels({
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
      logger.info(`第三方推理模式文件：${result.deploymentMode?.path}`);
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

  const port = flags.port && flags.port !== true ? Number(flags.port) : await findAvailablePort();
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("端口无效。请使用 `--port 9229` 这样的正整数。");
  }

  const { profile, source } = await buildSource(flags);

  if (flags.dryRun) {
    logger.info(`将启动：${app.executable}`);
    logger.info(`参数：--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`);
    return;
  }

  const alreadyRunning = await isClaudeRunning();
  if (alreadyRunning && !flags.force) {
    throw new Error("Claude 已在运行。请先从托盘/任务管理器完全退出 Claude，再运行插件；如果已手动开启 DevTools 端口，可用 `attach --port <端口>`。");
  }

  await ensureDesktopShortcutForLaunch({ iconPath: app.executable }, flags);
  launchClaude(app, port, flags);
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
