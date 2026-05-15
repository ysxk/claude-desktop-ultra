import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const appName = "Claude ultra";
const appBundle = path.join(distDir, `${appName}.app`);
const contentsDir = path.join(appBundle, "Contents");
const macosDir = path.join(contentsDir, "MacOS");
const resourcesDir = path.join(contentsDir, "Resources");
const embeddedAppDir = path.join(resourcesDir, "app");
const dmgPath = path.join(distDir, `Claude-ultra-macos-${os.arch()}.dmg`);
const dmgStagingDir = path.join(distDir, "dmg-staging");
const dmgMountPoint = path.join(distDir, "dmg-mount");
const readWriteDmgPath = path.join(distDir, `Claude-ultra-macos-${os.arch()}-rw.dmg`);

const nodePath = process.execPath;
const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
const appVersion = packageJson.version || "0.0.0";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      stdio: "inherit",
      ...options
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
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

async function copyProjectFiles() {
  const entries = [
    "bin",
    "src",
    "profiles",
    "locales",
    "config",
    "assets",
    "docs",
    "plugin.json",
    "package.json",
    "README.md"
  ];

  await fs.mkdir(embeddedAppDir, { recursive: true });
  for (const entry of entries) {
    const source = path.join(rootDir, entry);
    if (!(await pathExists(source))) {
      continue;
    }
    await fs.cp(source, path.join(embeddedAppDir, entry), { recursive: true, force: true });
  }
}

async function createIcns() {
  const pngPath = path.join(rootDir, "assets", "ClaudeCN.png");
  const iconsetDir = path.join(distDir, "Claude-ultra.iconset");
  const icnsPath = path.join(resourcesDir, "Claude-ultra.icns");
  if (!(await pathExists(pngPath))) {
    return null;
  }

  await fs.rm(iconsetDir, { recursive: true, force: true });
  await fs.mkdir(iconsetDir, { recursive: true });
  const sizes = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"]
  ];

  for (const [size, name] of sizes) {
    await run("sips", ["-z", String(size), String(size), pngPath, "--out", path.join(iconsetDir, name)]);
  }
  await run("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath]);
  await fs.rm(iconsetDir, { recursive: true, force: true });
  return icnsPath;
}

async function writeLauncher() {
  const launcherPath = path.join(macosDir, appName);
  const content = `#!/bin/sh
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$DIR/../Resources/node" "$DIR/../Resources/app/bin/claude-cn.mjs" launch "$@"
`;
  await fs.writeFile(launcherPath, content, { mode: 0o755 });
  await fs.chmod(launcherPath, 0o755);
}

async function writeInfoPlist(hasIcon) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Claude ultra</string>
  <key>CFBundleIdentifier</key>
  <string>com.claudeultra.app</string>
  <key>CFBundleName</key>
  <string>Claude ultra</string>
  <key>CFBundleDisplayName</key>
  <string>Claude ultra</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${appVersion}</string>
  <key>CFBundleVersion</key>
  <string>${appVersion}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  ${hasIcon ? "<key>CFBundleIconFile</key>\n  <string>Claude-ultra</string>" : ""}
</dict>
</plist>
`;
  await fs.writeFile(path.join(contentsDir, "Info.plist"), plist, "utf8");
}

async function detachDmg() {
  try {
    await run("hdiutil", ["detach", dmgMountPoint]);
  } catch {
    await run("hdiutil", ["detach", "-force", dmgMountPoint]);
  }
}

async function createDmgStaging() {
  await fs.rm(dmgStagingDir, { recursive: true, force: true });
  await fs.mkdir(dmgStagingDir, { recursive: true });
  await fs.cp(appBundle, path.join(dmgStagingDir, `${appName}.app`), {
    recursive: true,
    force: true,
    verbatimSymlinks: true
  });
}

async function createApplicationsAlias() {
  const script = `
tell application "Finder"
  set dmgFolder to POSIX file "${dmgMountPoint}" as alias
  if exists item "Applications" of dmgFolder then
    delete item "Applications" of dmgFolder
  end if
  make new alias file to POSIX file "/Applications" at dmgFolder with properties {name:"Applications"}
end tell
`;

  try {
    await run("osascript", ["-e", script]);
  } catch (error) {
    console.warn(`[build-dmg] Finder alias could not be created; falling back to a symlink: ${error.message}`);
    await fs.symlink("/Applications", path.join(dmgMountPoint, "Applications"));
  }
}

async function applyDmgFinderLayout() {
  const script = `
tell application "Finder"
  set dmgFolder to POSIX file "${dmgMountPoint}" as alias
  open dmgFolder
  set dmgWindow to container window of dmgFolder
  set current view of dmgWindow to icon view
  try
    set toolbar visible of dmgWindow to false
  end try
  try
    set statusbar visible of dmgWindow to false
  end try
  try
    set bounds of dmgWindow to {120, 120, 660, 420}
  end try
  set viewOptions to the icon view options of dmgWindow
  set arrangement of viewOptions to not arranged
  set icon size of viewOptions to 96
  try
    set position of item "${appName}.app" of dmgFolder to {170, 155}
  end try
  try
    set position of item "Applications" of dmgFolder to {420, 155}
  end try
  try
    close dmgWindow
  end try
  open dmgFolder
  update dmgFolder without registering applications
  delay 1
end tell
`;

  try {
    await run("osascript", ["-e", script]);
  } catch (error) {
    console.warn(`[build-dmg] Finder layout could not be applied: ${error.message}`);
  }
}

async function createInstallerDmg() {
  await fs.rm(dmgPath, { force: true });
  await fs.rm(readWriteDmgPath, { force: true });
  await fs.rm(dmgMountPoint, { recursive: true, force: true });
  await fs.mkdir(dmgMountPoint, { recursive: true });
  await createDmgStaging();

  await run("hdiutil", [
    "create",
    "-volname",
    appName,
    "-fs",
    "HFS+",
    "-srcfolder",
    dmgStagingDir,
    "-ov",
    "-format",
    "UDRW",
    readWriteDmgPath
  ]);

  await run("hdiutil", [
    "attach",
    readWriteDmgPath,
    "-readwrite",
    "-noverify",
    "-noautoopen",
    "-mountpoint",
    dmgMountPoint
  ]);

  try {
    await createApplicationsAlias();
    await applyDmgFinderLayout();
  } finally {
    await detachDmg();
  }

  await run("hdiutil", [
    "convert",
    readWriteDmgPath,
    "-format",
    "UDZO",
    "-imagekey",
    "zlib-level=9",
    "-o",
    dmgPath
  ]);
  await run("codesign", ["--force", "--sign", "-", dmgPath]);

  await fs.rm(readWriteDmgPath, { force: true });
  await fs.rm(dmgStagingDir, { recursive: true, force: true });
  await fs.rm(dmgMountPoint, { recursive: true, force: true });
}

await fs.mkdir(distDir, { recursive: true });
await fs.rm(appBundle, { recursive: true, force: true });
await fs.rm(dmgPath, { force: true });
await fs.rm(readWriteDmgPath, { force: true });
await fs.mkdir(macosDir, { recursive: true });
await fs.mkdir(resourcesDir, { recursive: true });

await fs.copyFile(nodePath, path.join(resourcesDir, "node"));
await fs.chmod(path.join(resourcesDir, "node"), 0o755);
await copyProjectFiles();
const iconPath = await createIcns();
await writeLauncher();
await writeInfoPlist(Boolean(iconPath));
await run("codesign", ["--force", "--deep", "--sign", "-", appBundle]);
await createInstallerDmg();

console.log(JSON.stringify({ appBundle, dmgPath }, null, 2));
