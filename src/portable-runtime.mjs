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
const PRELOAD_PATCH_MARKER = "CLAUDE_CN_PRELOAD_PATCH_V7_BAIDU_TRANSLATE_BRIDGE";
const MAIN_PROCESS_PATCH_MARKER = "CLAUDE_CN_MAIN_PROCESS_PATCH_V13_BAIDU_TRANSLATE_BRIDGE";
const ULTRA_MAX_EFFORT_PATCH_MARKER = "CLAUDE_ULTRA_MAX_EFFORT_PATCH";
const NATIVE_LANGUAGE_LIST_PATCH_MARKER = "CLAUDE_ULTRA_NATIVE_LANGUAGE_LIST_PATCH";
const CODE_ORG_DISABLED_GATE_PATCH_MARKER = "CLAUDE_ULTRA_CODE_ORG_DISABLED_GATE_PATCH";
const PORTABLE_COMPATIBILITY_PATCH_VERSION = 12;
const MAC_RUNTIME_APP_NAME = "Claude ultra";
const MAC_RUNTIME_BUNDLE_IDENTIFIER = "com.claudeultra.runtime";
const MAC_RUNTIME_IDENTITY_VERSION = 2;
const MAC_BUNDLE_TRANSIENT_FILES = [
  "claude-cn-injection-status.json",
  "claude-cn-injection-last.json"
];

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function reusePreviousStats(current, previous) {
  if (!previous || current?.patched !== 0 || !previous.patched || previous.patched <= 0) {
    return current;
  }
  return previous;
}

function isCompleteMacRuntimeStatus(status, expectedInjectionHash = null) {
  return Boolean(
    status?.localeStats?.translated > 0
      && status?.nativeLanguageStats?.patched > 0
      && status?.effortStats?.patched > 0
      && status?.compatibilityStats?.patched > 0
      && status?.compatibilityStats?.version === PORTABLE_COMPATIBILITY_PATCH_VERSION
      && status?.mainProcessStats?.patched > 0
      && status?.preloadStats?.patched > 0
      && status?.identityStats?.version === MAC_RUNTIME_IDENTITY_VERSION
      && status?.identityStats?.appName === MAC_RUNTIME_APP_NAME
      && status?.identityStats?.bundleIdentifier === MAC_RUNTIME_BUNDLE_IDENTIFIER
      && status?.asarIntegrityStats?.patched > 0
      && status?.signingStats?.signed === true
      && status?.mainProcessPatchMarker === MAIN_PROCESS_PATCH_MARKER
      && status?.preloadPatchMarker === PRELOAD_PATCH_MARKER
      && (!expectedInjectionHash || status?.injectionHash === expectedInjectionHash)
  );
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

async function runCommand(command, args, options = {}) {
  await execFileAsync(command, args, {
    maxBuffer: 1024 * 1024,
    ...options
  });
}

async function removeMacQuarantine(appPath) {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    await runCommand("xattr", ["-dr", "com.apple.quarantine", appPath]);
  } catch {
    // Missing quarantine xattrs are harmless.
  }
}

async function signMacApp(appPath) {
  if (process.platform !== "darwin") {
    return { signed: false };
  }

  await removeMacQuarantine(appPath);
  await runCommand("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  return { signed: true, identity: "ad-hoc" };
}

async function removeMacBundleTransientFiles(appPath) {
  if (process.platform !== "darwin") {
    return { removed: 0, files: [] };
  }

  const contentsDir = path.join(appPath, "Contents");
  const removedFiles = [];
  for (const fileName of MAC_BUNDLE_TRANSIENT_FILES) {
    const filePath = path.join(contentsDir, fileName);
    if (!(await pathExists(filePath))) {
      continue;
    }

    await fs.rm(filePath, { force: true });
    removedFiles.push(filePath);
  }

  return { removed: removedFiles.length, files: removedFiles };
}

async function updateMacAsarIntegrity(runtimeApp) {
  if (process.platform !== "darwin") {
    return { patched: 0 };
  }

  const asarPath = path.join(runtimeApp, "Contents", "Resources", "app.asar");
  if (!(await pathExists(asarPath))) {
    return { patched: 0 };
  }

  const archive = await fs.readFile(asarPath);
  const headerJsonSize = archive.readUInt32LE(ASAR_STRING_SIZE_OFFSET);
  const nextHash = sha256(archive.slice(ASAR_JSON_OFFSET, ASAR_JSON_OFFSET + headerJsonSize));
  const plistPaths = [];

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
      } else if (entry.isFile() && entry.name === "Info.plist") {
        plistPaths.push(entryPath);
      }
    }
  }

  await walk(path.join(runtimeApp, "Contents"));

  let patched = 0;
  const integrityPattern = /(<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*<key>Resources\/app\.asar<\/key>\s*<dict>\s*<key>algorithm<\/key>\s*<string>SHA256<\/string>\s*<key>hash<\/key>\s*<string>)([a-f0-9]{64})(<\/string>)/g;
  for (const plistPath of plistPaths) {
    const content = await fs.readFile(plistPath, "utf8");
    const nextContent = content.replace(integrityPattern, `$1${nextHash}$3`);
    if (nextContent === content) {
      continue;
    }
    await fs.writeFile(plistPath, nextContent, "utf8");
    patched += 1;
  }

  return { patched, hash: nextHash };
}

async function patchMacInfoPlist(runtimeApp) {
  if (process.platform !== "darwin") {
    return { patched: 0, appName: MAC_RUNTIME_APP_NAME, bundleIdentifier: MAC_RUNTIME_BUNDLE_IDENTIFIER };
  }

  const plistPath = path.join(runtimeApp, "Contents", "Info.plist");
  if (!(await pathExists(plistPath))) {
    return { patched: 0, appName: MAC_RUNTIME_APP_NAME, bundleIdentifier: MAC_RUNTIME_BUNDLE_IDENTIFIER };
  }

  const replacements = {
    CFBundleIdentifier: MAC_RUNTIME_BUNDLE_IDENTIFIER,
    CFBundleName: MAC_RUNTIME_APP_NAME,
    CFBundleDisplayName: MAC_RUNTIME_APP_NAME
  };
  let content = await fs.readFile(plistPath, "utf8");
  let patched = 0;
  for (const [key, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`(<key>${key}<\\/key>\\s*<string>)([^<]*)(<\\/string>)`);
    content = content.replace(pattern, (match, prefix, previous, suffix) => {
      if (previous === value) {
        return match;
      }
      patched += 1;
      return `${prefix}${value}${suffix}`;
    });
  }
  if (patched > 0) {
    await fs.writeFile(plistPath, content, "utf8");
  }
  return { patched, appName: MAC_RUNTIME_APP_NAME, bundleIdentifier: MAC_RUNTIME_BUNDLE_IDENTIFIER };
}

async function patchPlistStringValues(plistPath, replacements) {
  if (!(await pathExists(plistPath))) {
    return 0;
  }

  let content = await fs.readFile(plistPath, "utf8");
  let patched = 0;
  for (const [key, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`(<key>${key}<\\/key>\\s*<string>)([^<]*)(<\\/string>)`);
    content = content.replace(pattern, (match, prefix, previous, suffix) => {
      if (previous === value) {
        return match;
      }
      patched += 1;
      return `${prefix}${value}${suffix}`;
    });
  }
  if (patched > 0) {
    await fs.writeFile(plistPath, content, "utf8");
  }
  return patched;
}

async function patchMacHelperApps(runtimeApp) {
  const frameworksDir = path.join(runtimeApp, "Contents", "Frameworks");
  const helpers = [
    { suffix: "", identifier: `${MAC_RUNTIME_BUNDLE_IDENTIFIER}.helper` },
    { suffix: " (Renderer)", identifier: `${MAC_RUNTIME_BUNDLE_IDENTIFIER}.helper.renderer` },
    { suffix: " (GPU)", identifier: `${MAC_RUNTIME_BUNDLE_IDENTIFIER}.helper.gpu` },
    { suffix: " (Plugin)", identifier: `${MAC_RUNTIME_BUNDLE_IDENTIFIER}.helper.plugin` }
  ];
  let renamedApps = 0;
  let renamedExecutables = 0;
  let plistPatched = 0;

  for (const helper of helpers) {
    const oldBaseName = `Claude Helper${helper.suffix}`;
    const newBaseName = `${MAC_RUNTIME_APP_NAME} Helper${helper.suffix}`;
    const oldApp = path.join(frameworksDir, `${oldBaseName}.app`);
    const newApp = path.join(frameworksDir, `${newBaseName}.app`);

    if ((await pathExists(oldApp)) && !(await pathExists(newApp))) {
      await fs.rename(oldApp, newApp);
      renamedApps += 1;
    }

    const helperApp = (await pathExists(newApp)) ? newApp : oldApp;
    if (!(await pathExists(helperApp))) {
      continue;
    }

    const macosDir = path.join(helperApp, "Contents", "MacOS");
    const oldExe = path.join(macosDir, oldBaseName);
    const newExe = path.join(macosDir, newBaseName);
    if ((await pathExists(oldExe)) && !(await pathExists(newExe))) {
      await fs.rename(oldExe, newExe);
      renamedExecutables += 1;
    }

    plistPatched += await patchPlistStringValues(path.join(helperApp, "Contents", "Info.plist"), {
      CFBundleExecutable: newBaseName,
      CFBundleName: newBaseName,
      CFBundleDisplayName: newBaseName,
      CFBundleIdentifier: helper.identifier
    });
  }

  return { renamedApps, renamedExecutables, plistPatched };
}

async function patchMacPackageMetadata(resourcesDir) {
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!(await pathExists(asarPath))) {
    return { patched: 0 };
  }

  return patchAsarFile(asarPath, [
    {
      file: "package.json",
      transform: (content) => {
        const manifest = JSON.parse(content);
        manifest.name = "claude-ultra";
        manifest.productName = MAC_RUNTIME_APP_NAME;
        return `${JSON.stringify(manifest, null, 2)}\n`;
      }
    }
  ]);
}

async function patchMacRuntimeIdentity(runtimeApp, resourcesDir) {
  const plistStats = await patchMacInfoPlist(runtimeApp);
  const helperStats = await patchMacHelperApps(runtimeApp);
  const packageStats = await patchMacPackageMetadata(resourcesDir);
  return {
    version: MAC_RUNTIME_IDENTITY_VERSION,
    appName: MAC_RUNTIME_APP_NAME,
    bundleIdentifier: MAC_RUNTIME_BUNDLE_IDENTIFIER,
    plistPatched: plistStats.patched,
    helperStats,
    packagePatched: packageStats.patched
  };
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
  const base = process.platform === "darwin"
    ? path.join(process.env.HOME || process.cwd(), "Library", "Application Support")
    : (process.env.LOCALAPPDATA || process.env.TEMP || process.cwd());
  const safeVersion = String(app.version || "unknown").replace(/[^\w.-]+/g, "_");
  return path.join(base, "ClaudeCNOverlay", "runtime", `${safeVersion}-electron-${ELECTRON_VERSION}`);
}

function macRuntimeRootFor(app) {
  const base = path.join(process.env.HOME || process.cwd(), "Library", "Application Support");
  const safeVersion = String(app.version || "unknown").replace(/[^\w.-]+/g, "_");
  return path.join(base, "ClaudeCNOverlay", "runtime", `${safeVersion}-mac`);
}

async function findRuntimeZip(rootDir) {
  const candidates = [
    path.join(rootDir, "vendor", RUNTIME_ZIP),
    path.join(path.dirname(process.execPath), "vendor", RUNTIME_ZIP),
    path.join(process.cwd(), "vendor", RUNTIME_ZIP)
  ];

  const invalidCandidates = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      try {
        await assertRuntimeZipFile(candidate);
        return candidate;
      } catch (error) {
        invalidCandidates.push(`${candidate}: ${error.message}`);
      }
    }
  }

  if (invalidCandidates.length > 0) {
    throw new Error(`Electron runtime zip is invalid or incomplete. ${invalidCandidates.join(" | ")}`);
  }

  throw new Error(`缺少便携 Electron 运行时资源：${candidates.join(" 或 ")}`);
}

async function assertRuntimeZipFile(zipPath) {
  const stat = await fs.stat(zipPath);
  if (stat.size < 50 * 1024 * 1024) {
    throw new Error(`Electron runtime zip is incomplete: ${zipPath} is only ${stat.size} bytes. Make sure Git LFS assets were downloaded, or use a complete release package.`);
  }
  const handle = await fs.open(zipPath, "r");
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, header.length, 0);
    if (header[0] !== 0x50 || header[1] !== 0x4b) {
      throw new Error(`Electron runtime zip is invalid: ${zipPath} is not a ZIP file. Make sure Git LFS assets were downloaded, or use a complete release package.`);
    }
  } finally {
    await handle.close();
  }
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

  let lastError = null;
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      return { patched: 1, iconPath };
    } catch (error) {
      lastError = error;
      if (attempt === 5) {
        throw error;
      }
      await sleep(300 * (attempt + 1));
    }
  }

  throw lastError;
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

function buildBaiduTranslateBridgePreloadPatch() {
  return `
;/* ${PRELOAD_PATCH_MARKER} */
try {
  if (!globalThis.__CLAUDE_ULTRA_BAIDU_BRIDGE_PRELOAD__) {
    const { contextBridge, ipcRenderer } = require("electron");
    const ultraSettingsKey = "__claude_ultra_features__";
    const requestMessage = "__CLAUDE_ULTRA_BAIDU_TRANSLATE_REQUEST__";
    const responseMessage = "__CLAUDE_ULTRA_BAIDU_TRANSLATE_RESPONSE__";
    const readBaiduTranslateConfig = (payload) => {
      let settings = {};
      try {
        settings = JSON.parse(localStorage.getItem(ultraSettingsKey) || "{}") || {};
      } catch {}
      const configValue = settings.baiduTranslate && typeof settings.baiduTranslate === "object"
        ? settings.baiduTranslate
        : {};
      return {
        appId: String(payload?.appId || configValue.appId || settings.baiduTranslateAppId || "").trim(),
        secretKey: String(payload?.secretKey || configValue.secretKey || settings.baiduTranslateSecretKey || "").trim()
      };
    };
    const invokeTranslate = (payload = {}) => {
      const config = readBaiduTranslateConfig(payload);
      return ipcRenderer.invoke("__claude_ultra_baidu_translate__", {
        text: payload.text,
        appId: config.appId,
        secretKey: config.secretKey
      });
    };
    const bridge = {
      translate(payload) {
        return invokeTranslate(payload);
      }
    };
    globalThis.__CLAUDE_ULTRA_BAIDU_BRIDGE_PRELOAD__ = true;
    globalThis.__CLAUDE_ULTRA_BAIDU_BRIDGE__ = bridge;
    window.addEventListener("message", async (event) => {
      const data = event?.data;
      if (event.source !== window || !data || data.source !== requestMessage || !data.id) {
        return;
      }
      try {
        const translated = await invokeTranslate(data.payload || {});
        window.postMessage({ source: responseMessage, id: data.id, ok: true, translated }, "*");
      } catch (error) {
        window.postMessage({
          source: responseMessage,
          id: data.id,
          ok: false,
          error: String(error?.message || error || "Baidu Translate failed.")
        }, "*");
      }
    });
    contextBridge.exposeInMainWorld("__CLAUDE_ULTRA_BAIDU_BRIDGE__", bridge);
  }
} catch (error) {
  try { console.warn("[claude-cn] baidu translate bridge preload failed", error); } catch {}
}
`;
}

export function buildMainProcessPatch(injectionSource) {
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
  const { app, ipcMain, net } = require("electron");
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const https = require("node:https");
  const os = require("node:os");
  const path = require("node:path");
  const source = ${JSON.stringify(evaluatedSource)};
  const defaultStatusDir = (() => {
    try {
      return path.join(app.getPath("userData"), "ClaudeCNOverlay");
    } catch {
      const base = process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : path.join(os.homedir(), ".claude-cn-overlay");
      return path.join(base, "ClaudeCNOverlay");
    }
  })();
  const statusDir = process.env.CLAUDE_CN_STATUS_DIR || defaultStatusDir;
  const statusPath = path.join(statusDir, "claude-cn-injection-status.json");
  const lastStatusPath = path.join(statusDir, "claude-cn-injection-last.json");
  const writeStatus = (status) => {
    try {
      fs.mkdirSync(statusDir, { recursive: true });
      const payload = { at: new Date().toISOString(), ...status };
      fs.writeFileSync(lastStatusPath, JSON.stringify(payload, null, 2));
      if (payload.result && (payload.result.hasOverlay || payload.result.zhCount > 0 || payload.result.textSample)) {
        fs.writeFileSync(statusPath, JSON.stringify(payload, null, 2));
      }
    } catch {}
  };
  const baiduTranslateOrigin = "https://fanyi-api.baidu.com";
  const baiduTranslateEndpoint = baiduTranslateOrigin + "/api/trans/vip/translate";
  const baiduHttpJson = (url) => new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Claude-Ultra/1.0"
      },
      timeout: 15000
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error("Baidu Translate HTTP " + response.statusCode));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error("Baidu Translate returned invalid JSON."));
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("Baidu Translate request timed out."));
    });
    request.on("error", reject);
  });
  const baiduResponseJson = async (response) => {
    if (!response.ok) {
      throw new Error("Baidu Translate HTTP " + response.status);
    }
    return response.json();
  };
  const baiduTranslateJson = async (url) => {
    const failures = [];
    if (typeof fetch === "function") {
      try {
        return await baiduResponseJson(await fetch(url, { method: "GET" }));
      } catch (error) {
        failures.push("fetch: " + String(error?.message || error));
      }
    }
    if (net?.fetch) {
      try {
        return await baiduResponseJson(await net.fetch(url, { method: "GET" }));
      } catch (error) {
        failures.push("net.fetch: " + String(error?.message || error));
      }
    }
    try {
      return await baiduHttpJson(url);
    } catch (error) {
      failures.push("https: " + String(error?.message || error));
      throw new Error(failures.join("; ") || "Baidu Translate request failed.");
    }
  };
  const installBaiduTranslateIpcBridge = () => {
    try {
      if (globalThis.__CLAUDE_ULTRA_BAIDU_TRANSLATE_IPC_BRIDGE__) return;
      globalThis.__CLAUDE_ULTRA_BAIDU_TRANSLATE_IPC_BRIDGE__ = true;
      ipcMain.handle("__claude_ultra_baidu_translate__", async (_event, payload) => {
        const appId = String(payload?.appId || "").trim();
        const secretKey = String(payload?.secretKey || "").trim();
        const query = String(payload?.text || "").trim().slice(0, 5000);
        if (!appId || !secretKey) {
          throw new Error("Baidu Translate API is not configured.");
        }
        if (!query) {
          return query;
        }
        const salt = String(Date.now()) + String(Math.floor(Math.random() * 100000));
        const sign = crypto.createHash("md5").update(appId + query + salt + secretKey, "utf8").digest("hex");
        const params = new URLSearchParams({
          q: query,
          from: "auto",
          to: "zh",
          appid: appId,
          salt,
          sign
        });
        const result = await baiduTranslateJson(baiduTranslateEndpoint + "?" + params.toString());
        if (result?.error_code) {
          throw new Error(result.error_msg || ("Baidu Translate error " + result.error_code));
        }
        const lines = Array.isArray(result?.trans_result)
          ? result.trans_result.map((item) => item?.dst).filter(Boolean)
          : [];
        if (lines.length === 0) {
          throw new Error("Baidu Translate returned no result.");
        }
        return lines.join("\\n");
      });
      writeStatus({ reason: "baidu-translate-ipc-installed" });
    } catch (error) {
      writeStatus({ reason: "baidu-translate-ipc-failed", error: String(error) });
    }
  };
  const installBaiduTranslateCorsPatch = () => {
    try {
      if (globalThis.__CLAUDE_ULTRA_BAIDU_TRANSLATE_CORS_PATCH__) return;
      const { session } = require("electron");
      const webRequest = session?.defaultSession?.webRequest;
      if (!webRequest?.onHeadersReceived) return;
      globalThis.__CLAUDE_ULTRA_BAIDU_TRANSLATE_CORS_PATCH__ = true;
      const allowBaiduInCsp = (value) => {
        const directives = String(value || "").split(";").map((part) => part.trim()).filter(Boolean);
        const index = directives.findIndex((part) => part.toLowerCase().startsWith("connect-src"));
        if (index >= 0) {
          const pieces = directives[index].split(/\s+/).filter(Boolean);
          if (!pieces.includes(baiduTranslateOrigin)) {
            pieces.push(baiduTranslateOrigin);
          }
          directives[index] = pieces.join(" ");
        } else {
          directives.push("connect-src 'self' https: data: blob: " + baiduTranslateOrigin);
        }
        return directives.join("; ");
      };
      webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
        const responseHeaders = { ...(details.responseHeaders || {}) };
        const setHeader = (name, value) => {
          const existing = Object.keys(responseHeaders).find((key) => key.toLowerCase() === name.toLowerCase()) || name;
          responseHeaders[existing] = [value];
        };
        const patchCspHeader = (name) => {
          const existing = Object.keys(responseHeaders).find((key) => key.toLowerCase() === name.toLowerCase());
          if (!existing) return;
          const values = Array.isArray(responseHeaders[existing]) ? responseHeaders[existing] : [String(responseHeaders[existing])];
          responseHeaders[existing] = values.map(allowBaiduInCsp);
        };
        patchCspHeader("Content-Security-Policy");
        patchCspHeader("Content-Security-Policy-Report-Only");
        if (String(details.url || "").startsWith(baiduTranslateOrigin + "/")) {
          setHeader("Access-Control-Allow-Origin", "*");
          setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
          setHeader("Access-Control-Allow-Headers", "*");
        }
        callback({ responseHeaders });
      });
      writeStatus({ reason: "baidu-translate-network-installed" });
    } catch (error) {
      writeStatus({ reason: "baidu-translate-network-failed", error: String(error) });
    }
  };
  installBaiduTranslateIpcBridge();
  try {
    if (app.isReady?.()) {
      installBaiduTranslateCorsPatch();
    } else {
      app.whenReady?.().then(installBaiduTranslateCorsPatch).catch((error) => {
        writeStatus({ reason: "baidu-translate-network-ready-failed", error: String(error) });
      });
    }
  } catch {}
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
  const bridgeAppend = buildBaiduTranslateBridgePreloadPatch();
  const bridgeAndInjectionAppend = `${bridgeAppend}${append}`;
  return patchAsarFile(asarPath, [
    { file: ".vite/build/index.pre.js", append: bridgeAppend, marker: PRELOAD_PATCH_MARKER },
    { file: ".vite/build/mainView.js", append: bridgeAndInjectionAppend, marker: PRELOAD_PATCH_MARKER },
    { file: ".vite/build/mainWindow.js", append: bridgeAndInjectionAppend, marker: PRELOAD_PATCH_MARKER }
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

export function patchGatewayUrlValidation(content) {
  const protocolValidationPattern = /(const\{protocol:([A-Za-z_$][\w$]*)(?:,[^}]*)?\}=new URL\([^)]+\);)return (?:\2==="https:"\?!0:!![A-Za-z_$][\w$]*\.allowLoopbackHttp&&\2==="http:"&&[A-Za-z_$][\w$]*\.has\([A-Za-z_$][\w$]*\)|\2==="https:"\|\|\2==="http:"|\2==="https:")/g;
  let nextContent = content.replace(
    protocolValidationPattern,
    (_match, prefix) => `${prefix}return !0`
  );
  nextContent = nextContent.replace(
    /const ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>\2\.protocol==="https:"\|\|\2\.protocol==="http:"&&\2\.hostname==="127\.0\.0\.1"/g,
    (_match, functionName, urlName) => `const ${functionName}=${urlName}=>!0`
  );
  nextContent = nextContent.replace(
    /const ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.protocol==="http:"&&\2\.hostname==="127\.0\.0\.1";if\(\2\.protocol!=="https:"&&!\1\)throw new Error\("[^"]*Oidc issuer must be https"\);/g,
    (_match, loopbackName) => `const ${loopbackName}=!0;`
  );
  nextContent = nextContent.replace(
    /,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.protocol==="http:"&&\2\.hostname==="127\.0\.0\.1";if\(\2\.protocol!=="https:"&&!\1\)throw new Error\("[^"]*Oidc issuer must be https"\);/g,
    (_match, loopbackName) => `,${loopbackName}=!0;`
  );
  nextContent = nextContent.replace(
    /if\(![A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\)throw new Error\("authorizationUrl must use https \(or http on 127\.0\.0\.1\)"\);/g,
    ""
  );
  nextContent = nextContent.replace(
    /if\(![A-Za-z_$][\w$]*\(new URL\(([^)]+)\)\)\)throw new Error\("tokenUrl must use https \(or http on 127\.0\.0\.1\)"\);?/g,
    (_match, tokenUrlExpression) => `new URL(${tokenUrlExpression});`
  );
  nextContent = nextContent.replace(
    /if\(!\(\(([A-Za-z_$][\w$]*)==null\?void 0:\1\.protocol\)==="https:"\|\|[A-Za-z_$][\w$]*&&\(\1==null\?void 0:\1\.protocol\)==="http:"&&\1\.hostname==="127\.0\.0\.1"\)\)throw new Error\(`OIDC discovery returned non-https \$\{([A-Za-z_$][\w$]*)\}`\);/g,
    (_match, urlName, endpointName) => `if(!${urlName})throw new Error(\`OIDC discovery returned invalid \${${endpointName}}\`);`
  );
  nextContent = nextContent.replace(
    /message:[A-Za-z_$][\w$]*\.allowLoopbackHttp\?"must use https \(or http on loopback\)":"must use https"/g,
    'message:"invalid url"'
  );
  nextContent = nextContent.replace(
    /message:"must use http or https"/g,
    'message:"invalid url"'
  );
  nextContent = nextContent.replace(
    /message:"must use https"/g,
    'message:"invalid url"'
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

function patchMacVirtualizationEntitlementCheck(content) {
  const entitlementPattern = /if\((\w+)==="entitlement_missing"\)return\{status:"unsupported",reason:[^;]+?unsupportedCode:"virtualization_entitlement_missing"\};/g;
  return content.replace(
    entitlementPattern,
    (_match, resultName) => `if(${resultName}==="entitlement_missing")return{status:"supported"};`
  );
}

function patchMacSharedConfigWrites(content) {
  const configWritePattern = /function u8\((\w+)\)\{return qJe\.runExclusive\(async\(\)=>\{const (\w+)=sF\(\);try\{await _r\(\2,\1\),S\.info\("Config file written"\)\}catch\((\w+)\)\{S\.error\("Error reading or parsing config file: %o",\3\);return\}\}\)\}/;
  return content.replace(
    configWritePattern,
    (_match, configName) => `function u8(${configName}){return qJe.runExclusive(async()=>{S.info("Shared config is read-only; skipped config write")})}`
  );
}

export function patchMacDesktopUserAgent(content) {
  const userAgentPattern = /((?:vI|qI)\(\)&&\((\w+)\.app\.userAgentFallback=`\$\{\2\.app\.userAgentFallback\} MSIX`\);)([A-Za-z_$][\w$]*\(\);)/;
  return content.replace(
    userAgentPattern,
    (_match, prefix, electronName, suffix) => `${prefix}${electronName}.app.userAgentFallback+=\` Claude/\${${electronName}.app.getVersion()}\`;${suffix}`
  );
}

export function patchUltraLocalBridge(content) {
  let nextContent = content.replace(
    /start\((\w+)\)\{return ([A-Za-z_$][\w$]*)\.ipcRenderer\.invoke\("([^"]+_claude\.web_\$_LocalAgentModeSessions_\$_start)",\1\)\}/g,
    (_match, infoName, electronName, channelName) => (
      `start(${infoName}){return ${electronName}.ipcRenderer.invoke("${channelName}",self._u1?.(${infoName})||${infoName})}`
    )
  );
  nextContent = nextContent.replace(
    /setModel\((\w+),(\w+)\)\{return ([A-Za-z_$][\w$]*)\.ipcRenderer\.invoke\("([^"]+_claude\.web_\$_LocalAgentModeSessions_\$_setModel)",\1,\2\)\}/g,
    (_match, sessionName, modelName, electronName, channelName) => (
      `setModel(${sessionName},${modelName}){return ${electronName}.ipcRenderer.invoke("${channelName}",${sessionName},self._uM?.(${modelName})||${modelName})}`
    )
  );
  if (Buffer.byteLength(nextContent, "utf8") > Buffer.byteLength(content, "utf8")) {
    const withoutSourceMap = nextContent.replace(/\n?\/\/# sourceMappingURL=[^\n]*\.map\s*$/, "");
    if (Buffer.byteLength(withoutSourceMap, "utf8") <= Buffer.byteLength(content, "utf8")) {
      return withoutSourceMap;
    }
    const withoutInjectedCss = withoutSourceMap.replace(/;[A-Za-z_$][\w$]*\|\|[A-Za-z_$][\w$]*\.webFrame\.insertCSS\(`[\s\S]*?`,\{cssOrigin:"author"\}\);?\s*$/, "");
    if (Buffer.byteLength(withoutInjectedCss, "utf8") <= Buffer.byteLength(content, "utf8")) {
      return withoutInjectedCss;
    }
  }
  return nextContent;
}

export function applyCodeOrgDisabledGatePatch(content) {
  if (
    !content.includes("baku_enabled")
    || !content.includes("/code/disabled")
    || content.includes(CODE_ORG_DISABLED_GATE_PATCH_MARKER)
  ) {
    return { content, changed: false, count: 0 };
  }

  const disabledGatePattern = /(,[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\("baku_enabled"\),([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\),)([A-Za-z_$][\w$]*)=!1===\2,(?=\{onboardingPage:)/g;
  const result = replaceWithCount(content, disabledGatePattern, (_match, prefix, _availabilityName, disabledName) => (
    `${prefix}${disabledName}=false,`
  ));

  if (result.count === 0) {
    return { content, changed: false, count: 0 };
  }

  return {
    content: `${result.content}\n;window.__${CODE_ORG_DISABLED_GATE_PATCH_MARKER}__=true;\n`,
    changed: true,
    count: result.count
  };
}

async function patchCodeOrgDisabledGate(resourcesDir) {
  const ionDistDir = path.join(resourcesDir, "ion-dist");
  if (!(await pathExists(ionDistDir))) {
    return { patched: 0, rules: [] };
  }

  let patched = 0;
  let replacements = 0;

  for (const filePath of await findJavaScriptFiles(ionDistDir)) {
    const content = await fs.readFile(filePath, "utf8");
    const result = applyCodeOrgDisabledGatePatch(content);
    if (!result.changed) {
      continue;
    }

    await fs.writeFile(filePath, result.content, "utf8");
    patched += 1;
    replacements += result.count;
  }

  return {
    patched,
    replacements,
    rules: patched > 0 ? ["code-org-disabled-gate"] : []
  };
}

async function patchIonDistGatewayUrlValidation(resourcesDir) {
  const ionDistDir = path.join(resourcesDir, "ion-dist");
  if (!(await pathExists(ionDistDir))) {
    return { patched: 0, rules: [] };
  }

  let patched = 0;
  for (const filePath of await findJavaScriptFiles(ionDistDir)) {
    const content = await fs.readFile(filePath, "utf8");
    const nextContent = patchGatewayUrlValidation(content);
    if (nextContent === content) {
      continue;
    }

    await fs.writeFile(filePath, nextContent, "utf8");
    patched += 1;
  }

  return {
    patched,
    rules: patched > 0 ? ["gateway-url-validation"] : []
  };
}

async function patchPortableCompatibility(resourcesDir) {
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!(await pathExists(asarPath))) {
    return { patched: 0 };
  }

  const result = await patchAsarFile(asarPath, [
    {
      file: ".vite/build/index.js",
      transform: (content) => patchUltraLocalBridge(patchGatewayUrlValidation(patchMacDesktopUserAgent(patchMacSharedConfigWrites(patchMacVirtualizationEntitlementCheck(patchCoworkMsixCheck(patchGatewayHealthModelSelector(content))))))),
      inPlace: true
    },
    {
      file: ".vite/build/index.pre.js",
      transform: (content) => patchGatewayUrlValidation(patchMacVirtualizationEntitlementCheck(content)),
      inPlace: true
    },
    {
      file: ".vite/build/mainView.js",
      transform: (content) => patchUltraLocalBridge(patchMacVirtualizationEntitlementCheck(content)),
      inPlace: true
    },
    {
      file: ".vite/build/mainWindow.js",
      transform: (content) => patchUltraLocalBridge(patchMacVirtualizationEntitlementCheck(content)),
      inPlace: true
    }
  ]);
  const codeGateStats = await patchCodeOrgDisabledGate(resourcesDir);
  const urlValidationStats = await patchIonDistGatewayUrlValidation(resourcesDir);
  return {
    ...result,
    patched: result.patched + codeGateStats.patched + urlValidationStats.patched,
    codeGateStats,
    urlValidationStats,
    version: PORTABLE_COMPATIBILITY_PATCH_VERSION
  };
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
  const nextContent = typeof replacement === "function"
    ? content.replace(pattern, (...args) => {
      count += 1;
      return replacement(...args);
    })
    : content.replace(pattern, (...args) => {
      count += 1;
      const captures = args.slice(1, -2);
      return replacement.replace(/\$(\d+)/g, (match, indexText) => {
        const capture = captures[Number(indexText) - 1];
        return capture === undefined ? match : capture;
      });
    });

  return { content: nextContent, count };
}

function assertNoMaxEffortReplacementLeaks(content, filePath) {
  const leakedPlaceholder = /\$\d\.(?:filter|success|data)|===\$\d|&&!\$\d|\|\|\$\d/.exec(content);
  if (leakedPlaceholder) {
    throw new Error(`Max 思考值补丁生成了无效占位符 ${leakedPlaceholder[0]}：${filePath}`);
  }
}

export function applyMaxEffortPatchRules(content) {
  const matchedRules = [];
  const stringRules = [
    {
      name: "legacy-max-support",
      needle: 'return!(!s.includes("opus-4-6")&&!s.includes("opus-4-7"))||!!t&&!(s.includes("haiku")||s.includes("sonnet")||s.includes("opus"))',
      replacement: "return!0"
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
    assertNoMaxEffortReplacementLeaks(content, filePath);
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
  const injectionHash = options.injectionSource ? sha256(Buffer.from(options.injectionSource, "utf8")) : null;

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
        injectionHash,
        mainProcessPatchMarker: MAIN_PROCESS_PATCH_MARKER,
        preloadPatchMarker: PRELOAD_PATCH_MARKER,
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
    preloadStats,
    injectionHash
  };
}

export async function prepareMacPortableRuntime(rootDir, app, dictionary, options = {}) {
  if (process.platform !== "darwin") {
    throw new Error("macOS 便携运行时只能在 macOS 上准备。");
  }
  if (!app?.installLocation || !app.installLocation.endsWith(".app")) {
    throw new Error("缺少 Claude.app 路径，无法准备 macOS 便携运行时。");
  }

  const runtimeDir = macRuntimeRootFor(app);
  const runtimeApp = path.join(runtimeDir, `${MAC_RUNTIME_APP_NAME}.app`);
  const runtimeExe = path.join(runtimeApp, "Contents", "MacOS", "Claude");
  const resourcesDir = path.join(runtimeApp, "Contents", "Resources");
  const userDataDir = path.join(runtimeDir, "user-data");
  const statusPath = path.join(runtimeDir, "claude-cn-runtime.json");
  const previousStatus = await readJsonIfExists(statusPath);
  const injectionHash = options.injectionSource ? sha256(Buffer.from(options.injectionSource, "utf8")) : null;

  if ((await pathExists(runtimeExe)) && isCompleteMacRuntimeStatus(previousStatus, injectionHash)) {
    const transientCleanupStats = await removeMacBundleTransientFiles(runtimeApp);
    const signingStats = transientCleanupStats.removed > 0
      ? await signMacApp(runtimeApp)
      : previousStatus.signingStats || { signed: false };
    return {
      runtimeDir,
      runtimeApp,
      runtimeExe,
      resourcesDir,
      userDataDir,
      iconStats: { patched: 0, iconPath: path.join(resourcesDir, "electron.icns") },
      localeStats: previousStatus.localeStats || { patched: 0, translated: 0, total: 0 },
      effortStats: previousStatus.effortStats || { patched: 0, rules: [] },
      nativeLanguageStats: previousStatus.nativeLanguageStats || { patched: 0 },
      compatibilityStats: previousStatus.compatibilityStats || { patched: 0 },
      mainProcessStats: previousStatus.mainProcessStats || { patched: 0 },
      preloadStats: previousStatus.preloadStats || { patched: 0 },
      identityStats: previousStatus.identityStats || {
        version: MAC_RUNTIME_IDENTITY_VERSION,
        appName: MAC_RUNTIME_APP_NAME,
        bundleIdentifier: MAC_RUNTIME_BUNDLE_IDENTIFIER
      },
      asarIntegrityStats: previousStatus.asarIntegrityStats || { patched: 0 },
      signingStats,
      transientCleanupStats,
      injectionHash
    };
  }

  if (!(await pathExists(runtimeExe)) || !isCompleteMacRuntimeStatus(previousStatus, injectionHash)) {
    await fs.rm(runtimeApp, { recursive: true, force: true });
    await fs.rm(statusPath, { force: true });
    await fs.mkdir(runtimeDir, { recursive: true });
    await retryBusyFileOperation(() => fs.cp(app.installLocation, runtimeApp, {
      recursive: true,
      force: true,
      verbatimSymlinks: true
    }));
  }

  const localeStats = await patchLocale(resourcesDir, app, dictionary, options.locale || "zh-CN");
  const effortStats = reusePreviousStats(await patchMaxEffortSupport(resourcesDir), previousStatus?.effortStats);
  const nativeLanguageStats = reusePreviousStats(await patchNativeLanguageList(resourcesDir, options.locale || "zh-CN"), previousStatus?.nativeLanguageStats);
  const compatibilityStats = reusePreviousStats(await patchPortableCompatibility(resourcesDir), previousStatus?.compatibilityStats);
  const mainProcessStats = reusePreviousStats(await patchMainProcess(resourcesDir, options.injectionSource), previousStatus?.mainProcessStats);
  const preloadStats = reusePreviousStats(await patchPreloadScripts(resourcesDir, options.injectionSource), previousStatus?.preloadStats);
  const identityStats = await patchMacRuntimeIdentity(runtimeApp, resourcesDir);
  const transientCleanupStats = await removeMacBundleTransientFiles(runtimeApp);
  const asarIntegrityStats = await updateMacAsarIntegrity(runtimeApp);
  const signingStats = await signMacApp(runtimeApp);

  await fs.writeFile(
    statusPath,
    `${JSON.stringify(
      {
        sourcePackage: app.packageFullName,
        sourceVersion: app.version,
        platform: "darwin",
        runtimeApp,
        injectionHash,
        mainProcessPatchMarker: MAIN_PROCESS_PATCH_MARKER,
        preloadPatchMarker: PRELOAD_PATCH_MARKER,
        localeStats,
        effortStats,
        nativeLanguageStats,
        compatibilityStats,
        mainProcessStats,
        preloadStats,
        identityStats,
        transientCleanupStats,
        asarIntegrityStats,
        signingStats
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    runtimeDir,
    runtimeApp,
    runtimeExe,
    resourcesDir,
    userDataDir,
    iconStats: { patched: 0, iconPath: path.join(resourcesDir, "electron.icns") },
    localeStats,
    effortStats,
    nativeLanguageStats,
    compatibilityStats,
    mainProcessStats,
    preloadStats,
    identityStats,
    transientCleanupStats,
    asarIntegrityStats,
    signingStats,
    injectionHash
  };
}
