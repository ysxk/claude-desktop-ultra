import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runPowerShell(script) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }
  );
  return stdout.trim();
}

function expandWindowsEnv(candidate) {
  return candidate.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? "");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content.replace(/^\uFEFF/, ""));
}

async function detectMacClaude() {
  const candidates = [
    process.env.CLAUDE_DESKTOP_APP_PATH,
    "/Applications/Claude.app",
    path.join(os.homedir(), "Applications", "Claude.app")
  ].filter(Boolean);

  for (const appPath of candidates) {
    const executable = path.join(appPath, "Contents", "MacOS", "Claude");
    const resourcesDir = path.join(appPath, "Contents", "Resources");
    if (!(await fileExists(executable)) || !(await fileExists(resourcesDir))) {
      continue;
    }

    let version = null;
    try {
      const plist = await readJson(path.join(resourcesDir, "app.asar.unpacked", "package.json"));
      version = plist.version || null;
    } catch {
      try {
        const info = await fs.readFile(path.join(appPath, "Contents", "Info.plist"), "utf8");
        version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(info)?.[1] || null;
      } catch {
        version = null;
      }
    }

    return {
      kind: "mac",
      name: "Claude",
      packageFullName: null,
      version,
      installLocation: appPath,
      executable,
      resourcesDir
    };
  }

  return null;
}

export async function detectClaude() {
  if (process.platform === "darwin") {
    return detectMacClaude();
  }

  if (process.platform !== "win32") {
    return null;
  }

  const script = `
$ErrorActionPreference = "SilentlyContinue"
$pkg = Get-AppxPackage -Name Claude | Sort-Object {[version]$_.Version} -Descending | Select-Object -First 1
if ($pkg) {
  $exe = Join-Path $pkg.InstallLocation "app\\Claude.exe"
  $res = Join-Path $pkg.InstallLocation "app\\resources"
  [pscustomobject]@{
    kind = "msix"
    name = $pkg.Name
    packageFullName = $pkg.PackageFullName
    packageFamilyName = $pkg.PackageFamilyName
    appUserModelId = "$($pkg.PackageFamilyName)!Claude"
    version = "$($pkg.Version)"
    installLocation = $pkg.InstallLocation
    executable = $exe
    resourcesDir = $res
  } | ConvertTo-Json -Compress
}
`;

  try {
    const output = await runPowerShell(script);
    if (output) {
      const app = JSON.parse(output);
      if (await fileExists(app.executable)) {
        return app;
      }
    }
  } catch {
    // Fall through to classic installer detection.
  }

  const classicCandidates = [
    "%LOCALAPPDATA%\\Programs\\Claude\\Claude.exe",
    "%PROGRAMFILES%\\Claude\\Claude.exe",
    "%PROGRAMFILES(X86)%\\Claude\\Claude.exe"
  ].map(expandWindowsEnv);

  for (const executable of classicCandidates) {
    if (!(await fileExists(executable))) {
      continue;
    }

    const installLocation = path.dirname(executable);
    return {
      kind: "classic",
      name: "Claude",
      packageFullName: null,
      version: null,
      installLocation,
      executable,
      resourcesDir: path.join(installLocation, "resources")
    };
  }

  return null;
}

export async function isClaudeRunning() {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-x", "Claude"], { maxBuffer: 1024 * 1024 });
      return Boolean(stdout.trim());
    } catch {
      return false;
    }
  }

  if (process.platform !== "win32") {
    return false;
  }

  const script = `
$ErrorActionPreference = "SilentlyContinue"
Get-Process -Name Claude | Select-Object -First 1 -ExpandProperty Id
`;
  try {
    return Boolean(await runPowerShell(script));
  } catch {
    return false;
  }
}

export async function activateMsixClaude(app, args = "") {
  if (!app?.appUserModelId) {
    throw new Error("缺少 MSIX AppUserModelId，无法通过系统入口启动 Claude。");
  }

  const script = `
$ErrorActionPreference = "Stop"
$code = @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager
{
    IntPtr ActivateApplication([In] string appUserModelId, [In] string arguments, [In] ActivateOptions options, [Out] out uint processId);
    IntPtr ActivateForFile([In] string appUserModelId, [In] IntPtr itemArray, [In] string verb, [Out] out uint processId);
    IntPtr ActivateForProtocol([In] string appUserModelId, [In] IntPtr itemArray, [Out] out uint processId);
}

[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}

[Flags]
enum ActivateOptions
{
    None = 0x00000000,
    DesignMode = 0x00000001,
    NoErrorUI = 0x00000002,
    NoSplashScreen = 0x00000004
}

public static class ClaudeMsixActivator
{
    public static uint Activate(string appUserModelId, string arguments)
    {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        uint processId;
        var hr = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.None, out processId);
        if (hr != IntPtr.Zero)
        {
            Marshal.ThrowExceptionForHR(hr.ToInt32());
        }
        return processId;
    }
}
'@
Add-Type -TypeDefinition $code
$processId = [ClaudeMsixActivator]::Activate(${JSON.stringify(app.appUserModelId)}, ${JSON.stringify(args)})
$processId
`;

  const output = await runPowerShell(script);
  return Number(output);
}
