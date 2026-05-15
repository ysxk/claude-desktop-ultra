import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { patchExecutableIcon } from "../src/portable-runtime.mjs";

const [, , sourcePath, iconPath, workDir] = process.argv;

if (!sourcePath || !iconPath || !workDir) {
  throw new Error("Usage: patch-pkg-base-icon.mjs <source-exe> <icon.ico> <work-dir>");
}

const hash = crypto.createHash("sha256").update(sourcePath).digest("hex").slice(0, 12);
const patchedPath = path.join(workDir, `${path.basename(sourcePath)}-${hash}.icon.exe`);

await fs.mkdir(workDir, { recursive: true });
await fs.copyFile(sourcePath, patchedPath);
await patchExecutableIcon(patchedPath, iconPath);

process.stdout.write(JSON.stringify({ path: patchedPath }));
