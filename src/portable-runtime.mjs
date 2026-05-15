import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ELECTRON_VERSION = "41.5.0";
const RUNTIME_ZIP = "electron-runtime-win32-x64-41.5.0.zip";
const ASAR_JSON_OFFSET = 16;
const ASAR_HEADER_SIZE_OFFSET = 4;
const ASAR_STRING_SIZE_OFFSET = 12;
const PRELOAD_PATCH_MARKER = "CLAUDE_CN_PRELOAD_PATCH";
const MAIN_PROCESS_PATCH_MARKER = "CLAUDE_CN_MAIN_PROCESS_PATCH";
const ULTRA_MAX_EFFORT_PATCH_MARKER = "CLAUDE_ULTRA_MAX_EFFORT_PATCH";
const NATIVE_LANGUAGE_LIST_PATCH_MARKER = "CLAUDE_ULTRA_NATIVE_LANGUAGE_LIST_PATCH";

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryBusyFileOperation(operation, retries = 8) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) || attempt === retries) {
        throw error;
      }
      await sleep(250 * (attempt + 1));
    }
  }

  throw lastError;
}

async function expandZip(zipPath, destination) {
  const script = `
$ErrorActionPreference = "Stop"
Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destination)} -Force
`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
}

function runtimeRootFor(app) {
  const base = process.env.LOCALAPPDATA || process.env.TEMP || process.cwd();
  const safeVersion = String(app.version || "unknown").replace(/[^\w.-]+/g, "_");
  return path.join(base, "ClaudeCNOverlay", "runtime", `${safeVersion}-electron-${ELECTRON_VERSION}`);
}

async function findRuntimeZip(rootDir) {
  const candidates = [
    path.join(rootDir, "vendor", RUNTIME_ZIP),
    path.join(path.dirname(process.execPath), "vendor", RUNTIME_ZIP),
    path.join(process.cwd(), "vendor", RUNTIME_ZIP)
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`缺少便携 Electron 运行时资源：${candidates.join(" 或 ")}`);
}

async function materializeRuntimeZip(rootDir, runtimeDir) {
  const assetPath = await findRuntimeZip(rootDir);
  const tempZip = path.join(process.env.TEMP || runtimeDir, `${process.pid}-${RUNTIME_ZIP}`);

  const content = await fs.readFile(assetPath);
  await fs.writeFile(tempZip, content);
  return tempZip;
}

async function ensureElectronRuntime(rootDir, runtimeDir) {
  const runtimeExe = path.join(runtimeDir, "ClaudeCNRuntime.exe");
  if (await pathExists(runtimeExe)) {
    return runtimeExe;
  }

  await fs.rm(runtimeDir, { recursive: true, force: true });
  await fs.mkdir(runtimeDir, { recursive: true });

  const tempZip = await materializeRuntimeZip(rootDir, runtimeDir);
  try {
    await expandZip(tempZip, runtimeDir);
  } finally {
    await fs.rm(tempZip, { force: true });
  }

  const electronExe = path.join(runtimeDir, "electron.exe");
  if (!(await pathExists(electronExe))) {
    throw new Error(`便携 Electron 解压失败：找不到 ${electronExe}`);
  }

  await fs.copyFile(electronExe, runtimeExe);
  return runtimeExe;
}

export async function patchExecutableIcon(exePath, iconPath) {
  if (!(await pathExists(exePath)) || !(await pathExists(iconPath))) {
    return { patched: 0, iconPath };
  }

  const script = `
$ErrorActionPreference = "Stop"
$exePath = ${JSON.stringify(exePath)}
$iconPath = ${JSON.stringify(iconPath)}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NativeResourceUpdater {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, int cbData);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
}
"@

function Assert-Win32([bool] $ok, [string] $message) {
  if (-not $ok) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "$message (Win32 $code)"
  }
}

$icon = [IO.File]::ReadAllBytes($iconPath)
if ([BitConverter]::ToUInt16($icon, 0) -ne 0 -or [BitConverter]::ToUInt16($icon, 2) -ne 1) {
  throw "Invalid ICO file: $iconPath"
}

$count = [BitConverter]::ToUInt16($icon, 4)
$images = New-Object 'System.Collections.Generic.List[byte[]]'
$group = New-Object byte[] (6 + 14 * $count)
[Array]::Copy($icon, 0, $group, 0, 6)

for ($index = 0; $index -lt $count; $index++) {
  $sourceOffset = 6 + 16 * $index
  $targetOffset = 6 + 14 * $index
  [Array]::Copy($icon, $sourceOffset, $group, $targetOffset, 8)
  $bytesInRes = [BitConverter]::ToUInt32($icon, $sourceOffset + 8)
  $imageOffset = [BitConverter]::ToUInt32($icon, $sourceOffset + 12)
  [Array]::Copy([BitConverter]::GetBytes([uint32]$bytesInRes), 0, $group, $targetOffset + 8, 4)
  [Array]::Copy([BitConverter]::GetBytes([uint16]($index + 1)), 0, $group, $targetOffset + 12, 2)

  $image = New-Object byte[] $bytesInRes
  [Array]::Copy($icon, $imageOffset, $image, 0, $bytesInRes)
  $images.Add($image)
}

$handle = [NativeResourceUpdater]::BeginUpdateResource($exePath, $false)
if ($handle -eq [IntPtr]::Zero) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "BeginUpdateResource failed (Win32 $code)"
}

try {
  $language = [uint16]0
  $rtIcon = [IntPtr]3
  $rtGroupIcon = [IntPtr]14
  for ($index = 0; $index -lt $images.Count; $index++) {
    $id = [IntPtr]($index + 1)
    $image = $images[$index]
    Assert-Win32 ([NativeResourceUpdater]::UpdateResource($handle, $rtIcon, $id, $language, $image, $image.Length)) "Update RT_ICON failed"
  }
  Assert-Win32 ([NativeResourceUpdater]::UpdateResource($handle, $rtGroupIcon, [IntPtr]1, $language, $group, $group.Length)) "Update RT_GROUP_ICON failed"
  Assert-Win32 ([NativeResourceUpdater]::EndUpdateResource($handle, $false)) "EndUpdateResource failed"
  $handle = [IntPtr]::Zero
} finally {
  if ($handle -ne [IntPtr]::Zero) {
    [void][NativeResourceUpdater]::EndUpdateResource($handle, $true)
  }
}
`;

  await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });

  return { patched: 1, iconPath };
}

async function convertPngToIco(pngPath, icoPath) {
  if (!(await pathExists(pngPath))) {
    return null;
  }

  await fs.mkdir(path.dirname(icoPath), { recursive: true });

  const script = `
$ErrorActionPreference = "Stop"
$pngPath = ${JSON.stringify(pngPath)}
$icoPath = ${JSON.stringify(icoPath)}

Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile($pngPath)
$entries = New-Object 'System.Collections.Generic.List[object]'
$sizes = @(256, 128, 64, 48, 32, 16)

try {
  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap -ArgumentList $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = New-Object System.IO.MemoryStream

    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

      $scale = [Math]::Min($size / $source.Width, $size / $source.Height)
      $width = [int][Math]::Round($source.Width * $scale)
      $height = [int][Math]::Round($source.Height * $scale)
      $x = [int][Math]::Round(($size - $width) / 2)
      $y = [int][Math]::Round(($size - $height) / 2)
      $graphics.DrawImage($source, $x, $y, $width, $height)
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $entries.Add([pscustomobject]@{
        Size = $size
        Bytes = $stream.ToArray()
      })
    } finally {
      $stream.Dispose()
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }
} finally {
  $source.Dispose()
}

$file = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = New-Object System.IO.BinaryWriter -ArgumentList $file

try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$entries.Count)

  $offset = 6 + (16 * $entries.Count)
  foreach ($entry in $entries) {
    if ($entry.Size -ge 256) {
      $dimension = 0
    } else {
      $dimension = $entry.Size
    }

    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$entry.Bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $entry.Bytes.Length
  }

  foreach ($entry in $entries) {
    $writer.Write([byte[]]$entry.Bytes)
  }
} finally {
  $writer.Dispose()
  $file.Dispose()
}
`;

  await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });

  return icoPath;
}

async function resolveRuntimeIconPath(app, resourcesDir, runtimeDir) {
  const generatedIconPath = path.join(runtimeDir, "ClaudeCNRuntime.ico");
  const iconCandidates = [
    path.join(app.installLocation || "", "assets", "Square150x150Logo.scale-200.png"),
    path.join(app.installLocation || "", "assets", "Square150x150Logo.png"),
    path.join(resourcesDir, "ion-dist", "images", "claude_app_icon.png"),
    path.join(resourcesDir, "Tray-Win32.ico")
  ];

  for (const candidate of iconCandidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }

    if (path.extname(candidate).toLowerCase() === ".ico") {
      return candidate;
    }

    const converted = await convertPngToIco(candidate, generatedIconPath);
    if (converted) {
      return converted;
    }
  }

  return path.join(resourcesDir, "Tray-Win32.ico");
}

function buildTranslatedLocale(englishLocale, dictionary) {
  const result = {};
  for (const [id, value] of Object.entries(englishLocale)) {
    result[id] = typeof value === "string" ? dictionary[value] || value : value;
  }
  return result;
}

async function patchLocale(resourcesDir, app, dictionary, locale = "zh-CN") {
  const officialEnglishPath = path.join(app.resourcesDir, "en-US.json");
  const englishContent = await fs.readFile(officialEnglishPath, "utf8");
  const englishLocale = JSON.parse(englishContent);
  const translatedLocale = buildTranslatedLocale(englishLocale, dictionary);
  const content = `${JSON.stringify(translatedLocale, null, 2)}\n`;

  await fs.writeFile(path.join(resourcesDir, "en-US.json"), `${JSON.stringify(englishLocale, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(resourcesDir, `${locale}.json`), content, "utf8");

  return {
    locale,
    total: Object.keys(translatedLocale).length,
    translated: Object.values(translatedLocale).filter((value) => typeof value === "string" && /[\u4e00-\u9fff]/.test(value)).length,
    preservedDefaultLocale: true
  };
}

function readAsarHeader(archive) {
  const headerSize = archive.readUInt32LE(ASAR_HEADER_SIZE_OFFSET);
  const headerJsonSize = archive.readUInt32LE(ASAR_STRING_SIZE_OFFSET);
  const dataOffset = 8 + headerSize;
  const headerCapacity = dataOffset - ASAR_JSON_OFFSET;
  const headerJson = archive.slice(ASAR_JSON_OFFSET, ASAR_JSON_OFFSET + headerJsonSize).toString("utf8");

  return {
    header: JSON.parse(headerJson),
    dataOffset,
    headerCapacity
  };
}

function getAsarEntry(header, filePath) {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  let cursor = header;

  for (const part of parts) {
    cursor = cursor.files?.[part];
    if (!cursor) {
      return null;
    }
  }

  return cursor;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function buildIntegrity(buffer, blockSize = 4 * 1024 * 1024) {
  const blocks = [];
  for (let offset = 0; offset < buffer.length; offset += blockSize) {
    blocks.push(sha256(buffer.subarray(offset, offset + blockSize)));
  }

  return {
    algorithm: "SHA256",
    hash: sha256(buffer),
    blockSize,
    blocks
  };
}

function buildPreloadPatch(injectionSource) {
  return `
;/* ${PRELOAD_PATCH_MARKER} */
try {
  ${injectionSource}
} catch (error) {
  console.warn("[claude-cn] preload patch failed", error);
}
`;
}

function buildMainProcessPatch(injectionSource) {
  const evaluatedSource = `;(() => {
  let injectError = null;
  try {
    ${injectionSource}
  } catch (error) {
    injectError = String(error && (error.stack || error.message || error));
  }
  try {
    const text = document.body?.innerText || "";
    return {
      url: location.href,
      title: document.title,
      hasOverlay: !!window.__CLAUDE_ZH_CN_OVERLAY__,
      injectError,
      zhCount: (text.match(/[\\u4e00-\\u9fff]/g) || []).length,
      textSample: text.slice(0, 500)
    };
  } catch (error) {
    return { error: String(error) };
  }
})()`;

  return `
;/* ${MAIN_PROCESS_PATCH_MARKER} */
try {
  const { app } = require("electron");
  const fs = require("node:fs");
  const path = require("node:path");
  const source = ${JSON.stringify(evaluatedSource)};
  const statusPath = path.resolve(process.resourcesPath, "..", "claude-cn-injection-status.json");
  const lastStatusPath = path.resolve(process.resourcesPath, "..", "claude-cn-injection-last.json");
  const writeStatus = (status) => {
    try {
      const payload = { at: new Date().toISOString(), ...status };
      fs.writeFileSync(lastStatusPath, JSON.stringify(payload, null, 2));
      if (payload.result && (payload.result.hasOverlay || payload.result.zhCount > 0 || payload.result.textSample)) {
        fs.writeFileSync(statusPath, JSON.stringify(payload, null, 2));
      }
    } catch {}
  };
  const inject = (webContents, reason) => {
    try {
      if (!webContents || webContents.isDestroyed()) return;
      const url = webContents.getURL();
      if (url && (url.startsWith("devtools://") || url.startsWith("chrome://"))) return;
      webContents.executeJavaScript(source, true)
        .then((result) => writeStatus({ reason, result }))
        .catch((error) => writeStatus({ reason, error: String(error), url }));
    } catch (error) {
      writeStatus({ reason, error: String(error) });
    }
  };
  const schedule = (webContents, reason) => {
    for (const delay of [0, 100, 500, 1500, 3500]) {
      setTimeout(() => inject(webContents, reason), delay);
    }
  };
  app.on("web-contents-created", (_event, webContents) => {
    schedule(webContents, "created");
    webContents.on("dom-ready", () => schedule(webContents, "dom-ready"));
    webContents.on("did-finish-load", () => schedule(webContents, "did-finish-load"));
    webContents.on("did-navigate", () => schedule(webContents, "did-navigate"));
    webContents.on("did-navigate-in-page", () => schedule(webContents, "did-navigate-in-page"));
    webContents.on("did-frame-finish-load", () => schedule(webContents, "did-frame-finish-load"));
  });
  writeStatus({ reason: "hook-installed" });
} catch (error) {
  try { console.warn("[claude-cn] main process patch failed", error); } catch {}
}
`;
}

async function patchAsarFile(asarPath, patches) {
  let archive = await fs.readFile(asarPath);
  const parsed = readAsarHeader(archive);
  let patched = 0;

  for (const patch of patches) {
    const entry = getAsarEntry(parsed.header, patch.file);
    if (!entry || entry.unpacked || entry.offset === undefined || entry.size === undefined) {
      continue;
    }

    const start = parsed.dataOffset + Number(entry.offset);
    const end = start + Number(entry.size);
    const original = archive.subarray(start, end);
    if (patch.marker && original.includes(Buffer.from(patch.marker))) {
      continue;
    }

    const originalText = original.toString("utf8");
    const replacementText = patch.transform
      ? patch.transform(originalText)
      : `${patch.prepend || ""}${originalText}${patch.append || ""}`;
    if (replacementText === originalText) {
      continue;
    }

    const replacement = Buffer.from(replacementText, "utf8");
    if (patch.inPlace) {
      if (replacement.length > original.length) {
        throw new Error(`app.asar 原位补丁长度超出：${patch.file} ${replacement.length}/${original.length}`);
      }

      const paddedReplacement = replacement.length === original.length
        ? replacement
        : Buffer.concat([replacement, Buffer.alloc(original.length - replacement.length, 0x20)]);
      paddedReplacement.copy(archive, start);
      entry.integrity = buildIntegrity(paddedReplacement, entry.integrity?.blockSize);
      patched += 1;
      continue;
    }

    entry.offset = String(archive.length - parsed.dataOffset);
    entry.size = replacement.length;
    entry.integrity = buildIntegrity(replacement, entry.integrity?.blockSize);
    archive = Buffer.concat([archive, replacement]);
    patched += 1;
  }

  if (patched === 0) {
    return { patched };
  }

  const nextHeaderJson = JSON.stringify(parsed.header);
  const nextHeaderSize = Buffer.byteLength(nextHeaderJson);
  if (nextHeaderSize > parsed.headerCapacity) {
    throw new Error(`app.asar 头部空间不足，无法写入预加载汉化补丁：${nextHeaderSize}/${parsed.headerCapacity}`);
  }

  archive.writeUInt32LE(nextHeaderSize, ASAR_STRING_SIZE_OFFSET);
  archive.fill(0, ASAR_JSON_OFFSET, parsed.dataOffset);
  archive.write(nextHeaderJson, ASAR_JSON_OFFSET, "utf8");
  await fs.writeFile(asarPath, archive);

  return { patched };
}

async function patchPreloadScripts(resourcesDir, injectionSource) {
  if (!injectionSource) {
    return { patched: 0 };
  }

  const asarPath = path.join(resourcesDir, "app.asar");
  if (!(await pathExists(asarPath))) {
    return { patched: 0 };
  }

  const append = buildPreloadPatch(injectionSource);
  return patchAsarFile(asarPath, [
    { file: ".vite/build/mainView.js", append, marker: PRELOAD_PATCH_MARKER },
    { file: ".vite/build/mainWindow.js", append, marker: PRELOAD_PATCH_MARKER }
  ]);
}

function patchGatewayHealthModelSelector(content) {
  const selectorPattern = /function (\w+)\((\w+)\)\{if\(!\(\2!=null&&\2\.length\)\)return;const (\w+)=\["haiku","sonnet","opus"\];for\(const (\w+) of \3\)\{const (\w+)=\2\.find\((\w+)=>\6\.name\.toLowerCase\(\)\.includes\(\4\)\);if\(\5\)return \5\.name\}return \2\[0\]\.name\}/;
  const nextContent = content.replace(
    selectorPattern,
    (_match, functionName, modelsName) => `function ${functionName}(${modelsName}){if(!(${modelsName}!=null&&${modelsName}.length))return;return ${modelsName}[0].name}`
  );

  return nextContent;
}

function patchCoworkMsixCheck(content) {
  const msixCheckPattern = /if\((\w+)==="win32"&&!\w+\(\)\)return\{status:"unsupported",reason:\w+\(\)\.formatMessage\(\{defaultMessage:"Cowork requires Claude Desktop be installed with our modern installer",id:"EmeqFY8DA1"\}\),unsupportedCode:"msix_required"\};/;
  const nextContent = content.replace(
    msixCheckPattern,
    (_match, platformName) => `if(false&&${platformName}==="win32")return{status:"supported"};`
  );

  return nextContent;
}

async function patchPortableCompatibility(resourcesDir) {
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!(await pathExists(asarPath))) {
    return { patched: 0 };
  }

  return patchAsarFile(asarPath, [
    {
      file: ".vite/build/index.js",
      transform: (content) => patchCoworkMsixCheck(patchGatewayHealthModelSelector(content)),
      inPlace: true
    }
  ]);
}

async function findJavaScriptFiles(rootPath) {
  const files = [];

  async function walk(currentPath) {
    let entries = [];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".map")) {
        files.push(entryPath);
      }
    }
  }

  await walk(rootPath);
  return files;
}

function replaceWithCount(content, pattern, replacement) {
  let count = 0;
  const nextContent = content.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });

  return { content: nextContent, count };
}

function applyMaxEffortPatchRules(content) {
  const matchedRules = [];
  const stringRules = [
    {
      name: "legacy-max-support",
      needle: 'return!(!s.includes("opus-4-6")&&!s.includes("opus-4-7"))||!!t&&!(s.includes("haiku")||s.includes("sonnet")||s.includes("opus"))',
      replacement: "return!0"
    },
    {
      name: "legacy-model-menu-section",
      needle: 'items:O.numberedModelItems,extraSections:$,disabled:0===n.length||o',
      replacement: 'items:iM,extraSections:[...($??iM),{key:"models",header:N.formatMessage({defaultMessage:"Models",id:"blWvagsLt7"}),items:O.numberedModelItems}],disabled:0===n.length||o'
    }
  ];
  const regexRules = [
    {
      name: "current-max-support-return",
      pattern: /return!\(!([A-Za-z_$][\w$]*)\.includes\("opus-4-6"\)&&!\1\.includes\("opus-4-7"\)\)\|\|!\(\1\.includes\("haiku"\)\|\|\1\.includes\("sonnet"\)\|\|\1\.includes\("opus"\)\)/g,
      replacement: "return!0"
    },
    {
      name: "current-effort-options-filter",
      pattern: /const ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.filter\(([A-Za-z_$][\w$]*)=>\("max"!==\3\|\|([A-Za-z_$][\w$]*)\)&&\("xhigh"!==\3\|\|([A-Za-z_$][\w$]*)\)\)/g,
      replacement: 'const $1=$2.filter($3=>("xhigh"!==$3||$5))'
    },
    {
      name: "current-stored-max-downgrade",
      pattern: /([A-Za-z_$][\w$]*)="max"===([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)\|\|"xhigh"===\2&&!([A-Za-z_$][\w$]*)\?"high":\2/g,
      replacement: '$1="xhigh"===$2&&!$4?"high":$2'
    },
    {
      name: "current-session-max-downgrade",
      pattern: /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.success\?"max"===\2\.data&&!([A-Za-z_$][\w$]*)\|\|"xhigh"===\2\.data&&!([A-Za-z_$][\w$]*)\?"high":\2\.data:void 0/g,
      replacement: '$1=$2.success?"xhigh"===$2.data&&!$4?"high":$2.data:void 0'
    }
  ];

  let nextContent = content;

  for (const rule of stringRules) {
    if (nextContent.includes(rule.needle)) {
      nextContent = nextContent.replace(rule.needle, rule.replacement);
      matchedRules.push(rule.name);
    }
  }

  for (const rule of regexRules) {
    const result = replaceWithCount(nextContent, rule.pattern, rule.replacement);
    if (result.count > 0) {
      nextContent = result.content;
      matchedRules.push(rule.name);
    }
  }

  return {
    content: nextContent,
    matchedRules,
    changed: nextContent !== content
  };
}

async function patchMaxEffortSupport(resourcesDir) {
  const ionDistDir = path.join(resourcesDir, "ion-dist");
  if (!(await pathExists(ionDistDir))) {
    return { patched: 0, rules: [] };
  }

  let patched = 0;
  const matchedRules = new Set();

  for (const filePath of await findJavaScriptFiles(ionDistDir)) {
    let content = await fs.readFile(filePath, "utf8");
    const result = applyMaxEffortPatchRules(content);

    if (!result.changed) {
      continue;
    }

    content = result.content;
    for (const ruleName of result.matchedRules) {
      matchedRules.add(ruleName);
    }

    if (!content.includes(ULTRA_MAX_EFFORT_PATCH_MARKER)) {
      content += `\n;window.__${ULTRA_MAX_EFFORT_PATCH_MARKER}__=true;\n`;
    }

    await fs.writeFile(filePath, content, "utf8");
    patched += 1;
  }

  return { patched, rules: [...matchedRules] };
}

function tryPatchSupportedLocaleArray(content, locale) {
  const officialLocales = ["en-US", "de-DE", "fr-FR", "ko-KR", "ja-JP", "es-419", "es-ES", "it-IT", "hi-IN", "pt-BR", "id-ID"];
  const localeArrayPattern = /\[((?:"[a-z]{2}(?:-[A-Z0-9]{2,3})?"(?:,)?){8,16})\]/g;
  let patched = false;
  const nextContent = content.replace(localeArrayPattern, (match, body) => {
    let locales;
    try {
      locales = JSON.parse(`[${body}]`);
    } catch {
      return match;
    }

    if (!officialLocales.every((candidate) => locales.includes(candidate)) || locales.includes(locale)) {
      return match;
    }

    const nextLocales = [...locales];
    const englishIndex = nextLocales.indexOf("en-US");
    nextLocales.splice(englishIndex >= 0 ? englishIndex + 1 : 0, 0, locale);
    patched = true;
    return JSON.stringify(nextLocales);
  });

  let labeledContent = nextContent;
  const nativeLabelNeedle = "localName:e.formatters.getDisplayNames(s,_es).of(s)";
  if (patched && labeledContent.includes(nativeLabelNeedle)) {
    labeledContent = labeledContent.replace(
      nativeLabelNeedle,
      `localName:s===${JSON.stringify(locale)}?"简体中文":e.formatters.getDisplayNames(s,_es).of(s)`
    );
  }

  return {
    content: patched && !labeledContent.includes(NATIVE_LANGUAGE_LIST_PATCH_MARKER)
      ? `${labeledContent}\n;window.__${NATIVE_LANGUAGE_LIST_PATCH_MARKER}__=true;\n`
      : labeledContent,
    patched
  };
}

async function patchNativeLanguageList(resourcesDir, locale = "zh-CN") {
  const ionDistDir = path.join(resourcesDir, "ion-dist");
  if (!(await pathExists(ionDistDir))) {
    return { patched: 0 };
  }

  let patched = 0;
  for (const filePath of await findJavaScriptFiles(ionDistDir)) {
    let content = await fs.readFile(filePath, "utf8");
    if (!content.includes("en-US") || !content.includes("fr-FR") || !content.includes("pt-BR")) {
      continue;
    }

    const result = tryPatchSupportedLocaleArray(content, locale);
    if (!result.patched) {
      continue;
    }

    await fs.writeFile(filePath, result.content, "utf8");
    patched += 1;
  }

  return { patched };
}

async function patchMainProcess(resourcesDir, injectionSource) {
  if (!injectionSource) {
    return { patched: 0 };
  }

  const asarPath = path.join(resourcesDir, "app.asar");
  if (!(await pathExists(asarPath))) {
    return { patched: 0 };
  }

  return patchAsarFile(asarPath, [
    {
      file: ".vite/build/index.pre.js",
      prepend: buildMainProcessPatch(injectionSource),
      marker: MAIN_PROCESS_PATCH_MARKER
    }
  ]);
}

export async function preparePortableRuntime(rootDir, app, dictionary, options = {}) {
  const runtimeDir = runtimeRootFor(app);
  const runtimeExe = await ensureElectronRuntime(rootDir, runtimeDir);
  const resourcesDir = path.join(runtimeDir, "resources");

  await fs.mkdir(resourcesDir, { recursive: true });
  await retryBusyFileOperation(() => fs.cp(app.resourcesDir, resourcesDir, { recursive: true, force: true }));
  const runtimeIconPath = await resolveRuntimeIconPath(app, resourcesDir, runtimeDir);
  const iconStats = await patchExecutableIcon(runtimeExe, runtimeIconPath);
  const localeStats = await patchLocale(resourcesDir, app, dictionary, options.locale || "zh-CN");
  const effortStats = await patchMaxEffortSupport(resourcesDir);
  const nativeLanguageStats = await patchNativeLanguageList(resourcesDir, options.locale || "zh-CN");
  const compatibilityStats = await patchPortableCompatibility(resourcesDir);
  const mainProcessStats = await patchMainProcess(resourcesDir, options.injectionSource);
  const preloadStats = await patchPreloadScripts(resourcesDir, options.injectionSource);

  await fs.writeFile(
    path.join(runtimeDir, "claude-cn-runtime.json"),
    `${JSON.stringify(
      {
        sourcePackage: app.packageFullName,
        sourceVersion: app.version,
        electronVersion: ELECTRON_VERSION,
        iconStats,
        localeStats,
        effortStats,
        nativeLanguageStats,
        compatibilityStats,
        mainProcessStats,
        preloadStats
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    runtimeDir,
    runtimeExe,
    resourcesDir,
    iconStats,
    localeStats,
    effortStats,
    nativeLanguageStats,
    compatibilityStats,
    mainProcessStats,
    preloadStats
  };
}
