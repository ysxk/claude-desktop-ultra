const childProcess = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

if (process.env.CLAUDE_CN_PKG_ICON_HOOK_CHILD !== "1") {
  const iconPath = process.env.CLAUDE_CN_PKG_ICON;
  const workDir = process.env.CLAUDE_CN_PKG_ICON_WORKDIR;
  const patchScript = path.join(__dirname, "patch-pkg-base-icon.mjs");
  const originalLoad = Module._load;
  const patchedBySource = new Map();

  function shouldPatch(options, basePath) {
    return Boolean(
      iconPath &&
      workDir &&
      options?.platform === "win" &&
      options?.arch === "x64" &&
      typeof basePath === "string" &&
      path.isAbsolute(basePath) &&
      fs.existsSync(basePath)
    );
  }

  function patchBase(basePath) {
    const cached = patchedBySource.get(basePath);
    if (cached && fs.existsSync(cached)) {
      return cached;
    }

    const stdout = childProcess.execFileSync(process.execPath, [patchScript, basePath, iconPath, workDir], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CN_PKG_ICON_HOOK_CHILD: "1"
      }
    });
    const result = JSON.parse(stdout);
    patchedBySource.set(basePath, result.path);
    return result.path;
  }

  Module._load = function loadWithPkgIconHook(request, parent, isMain) {
    const loaded = originalLoad.apply(this, arguments);
    if (request !== "@yao-pkg/pkg-fetch" || loaded.__claudeCnIconHooked) {
      return loaded;
    }

    const originalNeed = loaded.need;
    loaded.need = async function needWithIcon(options) {
      const basePath = await originalNeed.apply(this, arguments);
      return shouldPatch(options, basePath) ? patchBase(basePath) : basePath;
    };
    loaded.__claudeCnIconHooked = true;
    return loaded;
  };
}
