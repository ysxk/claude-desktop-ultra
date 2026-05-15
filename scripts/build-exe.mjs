import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const exePath = path.join(distDir, "ClaudeCN.exe");
const hookPath = path.join(rootDir, "scripts", "pkg-icon-hook.cjs");

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function quoteCmdArg(value) {
  const text = String(value);
  if (text.length === 0) {
    return "\"\"";
  }
  if (!/[\s"&|<>^]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const isWindowsCommandScript = process.platform === "win32" && command.endsWith(".cmd");
    const childCommand = isWindowsCommandScript ? (process.env.ComSpec || "cmd.exe") : command;
    const childArgs = isWindowsCommandScript
      ? ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")]
      : args;
    const child = spawn(childCommand, childArgs, {
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

function withIconHookEnv(workDir) {
  const hookOption = `--require=${hookPath}`;
  return {
    ...process.env,
    CLAUDE_CN_PKG_ICON: path.join(rootDir, "assets", "ClaudeCN.ico"),
    CLAUDE_CN_PKG_ICON_WORKDIR: workDir,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, hookOption].filter(Boolean).join(" ")
  };
}

await fs.mkdir(distDir, { recursive: true });
await run(process.execPath, [path.join(rootDir, "scripts", "generate-icon.mjs")]);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claude-cn-pkg-"));
try {
  await run(commandName("npx"), ["--yes", "@yao-pkg/pkg", ".", "--targets", "node22-win-x64", "--output", exePath], {
    env: withIconHookEnv(tempRoot)
  });
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
