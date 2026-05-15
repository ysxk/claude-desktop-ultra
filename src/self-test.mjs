import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { detectClaude } from "./adapters/claude-desktop.mjs";
import { buildInjectionSource } from "./injection-source.mjs";
import { loadProfile } from "./locale.mjs";
import { applyMaxEffortPatchRules, prepareMacPortableRuntime, preparePortableRuntime } from "./portable-runtime.mjs";
import { syncThirdPartyModels } from "./third-party-models.mjs";

const TEST_MODEL = "deepseek-v4-flash";
const execFileAsync = promisify(execFile);

async function pathExists(filePath) {
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

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

async function findMaxEffortPlaceholderLeaks(resourcesDir) {
  const ionDistDir = path.join(resourcesDir, "ion-dist");
  const leaks = [];

  for (const filePath of await findJavaScriptFiles(ionDistDir)) {
    const content = await fs.readFile(filePath, "utf8");
    const match = /\$\d\.(?:filter|success|data)|===\$\d|&&!\$\d|\|\|\$\d/.exec(content);
    if (match) {
      leaks.push(`${path.basename(filePath)}:${match[0]}`);
    }
  }

  return leaks;
}

async function findModelMenuSectionReversalLeaks(resourcesDir) {
  const ionDistDir = path.join(resourcesDir, "ion-dist");
  const leaks = [];

  for (const filePath of await findJavaScriptFiles(ionDistDir)) {
    const content = await fs.readFile(filePath, "utf8");
    if (content.includes("items:iM,extraSections:[...($??iM),{key:\"models\"")) {
      leaks.push(path.basename(filePath));
    }
  }

  return leaks;
}

async function verifyMacCodeSignature(appPath) {
  if (process.platform !== "darwin") {
    return { ok: false, detail: "not-macos" };
  }

  try {
    await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
      maxBuffer: 1024 * 1024
    });
    return { ok: true, detail: appPath };
  } catch (error) {
    return {
      ok: false,
      detail: error.stderr?.trim() || error.stdout?.trim() || error.message
    };
  }
}

async function startFakeGateway() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: [
          { id: "claude-3-5-sonnet" },
          { id: TEST_MODEL },
          { id: "text-embedding-3-large" }
        ]
      }));
      return;
    }

    if (request.url === "/v1/messages") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const payload = JSON.parse(body || "{}");
      requests.push({
        authorization: request.headers.authorization || null,
        model: payload.model || null
      });

      if (payload.model === TEST_MODEL) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "msg_self_test",
          type: "message",
          role: "assistant",
          model: payload.model,
          content: [{ type: "text", text: "ok" }]
        }));
        return;
      }

      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "blocked in self test" } }));
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function createRecorder(logger) {
  const results = [];

  return {
    check(name, condition, detail = "") {
      const ok = Boolean(condition);
      results.push({ name, ok, detail });
      const message = `${ok ? "[OK]" : "[FAIL]"} ${name}${detail ? `：${detail}` : ""}`;
      if (ok) {
        logger.info(message);
      } else {
        logger.warn(message);
      }
    },
    get failed() {
      return results.filter((result) => !result.ok);
    },
    get results() {
      return results;
    }
  };
}

async function validateModelConfig(rootDir, expectedModel) {
  const metaPath = path.join(rootDir, "configLibrary", "_meta.json");
  const desktopConfigPath = path.join(rootDir, "claude_desktop_config.json");
  const meta = await readJson(metaPath);
  const configPath = path.join(rootDir, "configLibrary", `${meta.appliedId}.json`);
  const config = await readJson(configPath);
  const desktopConfig = await readJson(desktopConfigPath);

  return {
    metaPath,
    configPath,
    desktopConfigPath,
    meta,
    config,
    desktopConfig,
    firstModel: config.inferenceModels?.[0]?.name,
    expectedModel
  };
}

async function testBlankModelSync(recorder, gateway) {
  const rootDir = await makeTempDir("claude-ultra-blank-");
  try {
    const result = await syncThirdPartyModels({
      rootDir,
      gatewayBaseUrl: gateway.baseUrl,
      gatewayApiKey: "self-test-key",
      models: TEST_MODEL,
      modelProbeLimit: 5,
      modelProbeTimeoutMs: 2000,
      gatewayTimeoutMs: 2000
    });
    const config = await validateModelConfig(rootDir, TEST_MODEL);

    recorder.check("空白电脑会创建 _meta.json", /^[a-f0-9-]{36}$/i.test(config.meta.appliedId), config.metaPath);
    recorder.check("空白电脑会切换 deploymentMode=3p", config.desktopConfig.deploymentMode === "3p", config.desktopConfigPath);
    recorder.check("第三方模型列表首位是 deepseek-v4-flash", config.firstModel === TEST_MODEL, config.configPath);
    recorder.check("模型校验限制已关闭", config.config.unstableDisableModelVerification === true);
    recorder.check("Gateway 探测使用 deepseek-v4-flash", result.verifiedModel === TEST_MODEL);
    recorder.check("Gateway 探测携带 Bearer Key", gateway.requests.some((request) => request.authorization === "Bearer self-test-key"));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function testLegacyModelMigration(recorder, gateway) {
  const rootDir = await makeTempDir("claude-ultra-legacy-");
  try {
    const libraryDir = path.join(rootDir, "configLibrary");
    await fs.mkdir(libraryDir, { recursive: true });
    await fs.writeFile(
      path.join(libraryDir, "default.json"),
      `\uFEFF${JSON.stringify({
        inferenceProvider: "gateway",
        inferenceGatewayBaseUrl: gateway.baseUrl,
        inferenceGatewayApiKey: "legacy-key",
        inferenceModels: [{ name: TEST_MODEL, labelOverride: "Deepseek V4 Flash" }],
        unstableDisableModelVerification: true
      }, null, 2)}\n`,
      "utf8"
    );

    const result = await syncThirdPartyModels({
      rootDir,
      probeModels: false,
      gatewayTimeoutMs: 2000
    });
    const config = await validateModelConfig(rootDir, TEST_MODEL);

    recorder.check("旧版 default.json 会迁移到 UUID 配置", result.legacyConfigMigrated === true, config.configPath);
    recorder.check("旧版迁移后模型仍是 deepseek-v4-flash", config.firstModel === TEST_MODEL);
    recorder.check("旧版迁移后 deploymentMode=3p", config.desktopConfig.deploymentMode === "3p");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function testEmptyConfigDoesNotActivate(recorder) {
  const rootDir = await makeTempDir("claude-ultra-empty-");
  try {
    const result = await syncThirdPartyModels({
      rootDir,
      probeModels: false,
      gatewayTimeoutMs: 2000
    });
    recorder.check("无 Gateway 配置时不会误切 3P", result.deploymentMode === null);
    recorder.check("无 Gateway 配置时不会创建配置索引", !(await pathExists(path.join(rootDir, "configLibrary", "_meta.json"))));
    recorder.check("无 Gateway 配置时不会写模型配置", !(await pathExists(result.configPath)));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

function testInjectionSkipsEditableText(recorder) {
  const source = buildInjectionSource({
    dictionary: { Send: "发送" },
    profile: {
      locale: "zh-CN",
      fallbackLocale: "en-US",
      translateAttributes: ["aria-label", "title", "placeholder", "alt"],
      skipTextSelectors: [
        "textarea",
        "input",
        "[contenteditable]:not([contenteditable=\"false\"])",
        "[role=\"textbox\"]"
      ]
    },
    launchLocale: "zh-CN",
    localeOverride: true
  });

  recorder.check(
    "汉化注入会跳过可编辑输入区",
    source.includes("isEditableElement")
      && source.includes("[contenteditable]:not([contenteditable=\"false\"]),[role=\"textbox\"]")
  );
  recorder.check(
    "汉化注入会采纳 React 动态更新文本",
    source.includes("shouldAdoptCurrentValue")
      && source.includes("current !== original && current !== renderedOriginal")
  );
}

function testMaxEffortPatchKeepsModelMenuPrimary(recorder) {
  const fixture = [
    'return!(!s.includes("opus-4-6")&&!s.includes("opus-4-7"))||!!t&&!(s.includes("haiku")||s.includes("sonnet")||s.includes("opus"))',
    "const menu={items:O.numberedModelItems,extraSections:$,disabled:0===n.length||o};"
  ].join(";");
  const result = applyMaxEffortPatchRules(fixture);

  recorder.check("Max 补丁不会反转模型菜单主列表", result.content.includes("items:O.numberedModelItems,extraSections:$"));
  recorder.check("Max 补丁不会把模型列表塞进空主菜单", !result.content.includes("items:iM,extraSections"));
}

async function testPortableRuntime(recorder, rootDir, flags = {}) {
  const app = await detectClaude();
  recorder.check("已检测到 Claude Desktop", Boolean(app), app ? `${app.kind} ${app.version || "unknown"}` : "");
  if (!app) {
    return;
  }

  const { profile, dictionary } = await loadProfile(rootDir, flags.profile);
  const locale = flags.locale || flags.lang || profile.locale || "zh-CN";
  const injectionSource = buildInjectionSource({
    profile,
    dictionary,
    launchLocale: locale,
    localeOverride: Boolean(flags.locale || flags.lang || profile.localeOverride)
  });
  const isMacRuntime = app.kind === "mac";
  const runtime = isMacRuntime
    ? await prepareMacPortableRuntime(rootDir, app, dictionary, {
      injectionSource,
      locale
    })
    : await preparePortableRuntime(rootDir, app, dictionary, {
    injectionSource,
    locale
  });
  const zhLocalePath = path.join(runtime.resourcesDir, `${locale}.json`);
  const enLocalePath = path.join(runtime.resourcesDir, "en-US.json");
  const runtimeStatusPath = path.join(runtime.runtimeDir, "claude-cn-runtime.json");
  const zhLocaleContent = await fs.readFile(zhLocalePath, "utf8");
  const runtimeStatus = await readJson(runtimeStatusPath);

  recorder.check(isMacRuntime ? "macOS 便携运行时可执行文件可用" : "便携运行时 exe 可用", await pathExists(runtime.runtimeExe), runtime.runtimeExe);
  recorder.check("中文 locale 已写入", /[\u4e00-\u9fff]/.test(zhLocaleContent), zhLocalePath);
  recorder.check("英文 locale 保留", await pathExists(enLocalePath), enLocalePath);
  recorder.check("语言设置包含 zh-CN 入口", runtime.nativeLanguageStats.patched > 0);
  recorder.check("Max 思考值补丁命中", runtime.effortStats.patched > 0, runtime.effortStats.rules?.join(", ") || "");
  const maxEffortLeaks = await findMaxEffortPlaceholderLeaks(runtime.resourcesDir);
  recorder.check("Max 思考值补丁没有残留 $1/$2 占位符", maxEffortLeaks.length === 0, maxEffortLeaks.join(", "));
  const modelMenuReversalLeaks = await findModelMenuSectionReversalLeaks(runtime.resourcesDir);
  recorder.check("模型菜单仍使用 Claude 原生主列表", modelMenuReversalLeaks.length === 0, modelMenuReversalLeaks.join(", "));
  recorder.check("运行时状态记录 Max 规则", Array.isArray(runtimeStatus.effortStats?.rules) && runtimeStatus.effortStats.rules.length > 0);
  recorder.check("主进程汉化注入已写入", runtime.mainProcessStats.patched > 0);
  recorder.check("preload 汉化注入已写入", runtime.preloadStats.patched > 0);
  recorder.check("便携兼容补丁已写入", runtime.compatibilityStats.patched > 0);

  if (isMacRuntime) {
    const staleStatusFiles = [
      path.join(runtime.runtimeApp, "Contents", "claude-cn-injection-status.json"),
      path.join(runtime.runtimeApp, "Contents", "claude-cn-injection-last.json")
    ];
    const staleStatusExists = (await Promise.all(staleStatusFiles.map(pathExists))).some(Boolean);
    const macSignature = await verifyMacCodeSignature(runtime.runtimeApp);
    recorder.check("macOS 注入状态不会污染 .app 包", !staleStatusExists, staleStatusFiles.join(", "));
    recorder.check("macOS app.asar 完整性已更新", Boolean(runtime.asarIntegrityStats?.hash), runtime.asarIntegrityStats?.hash || "");
    recorder.check("macOS app 已重新签名", runtime.signingStats?.signed === true, runtime.signingStats?.identity || "");
    recorder.check("macOS codesign 校验通过", macSignature.ok, macSignature.detail);
  }
}

export async function runWindowsSelfTest({ rootDir, flags = {}, logger = console } = {}) {
  const recorder = createRecorder(logger);
  const gateway = await startFakeGateway();
  const testName = flags.skipRuntime
    ? "基础自检"
    : process.platform === "darwin"
      ? "macOS 自检"
      : process.platform === "win32"
        ? "Windows 自检"
        : "自检";

  try {
    logger.info(`${testName}开始，测试模型：${TEST_MODEL}`);
    testInjectionSkipsEditableText(recorder);
    testMaxEffortPatchKeepsModelMenuPrimary(recorder);
    await testEmptyConfigDoesNotActivate(recorder);
    await testBlankModelSync(recorder, gateway);
    await testLegacyModelMigration(recorder, gateway);
    if (!flags.skipRuntime) {
      await testPortableRuntime(recorder, rootDir, flags);
    }
  } finally {
    await gateway.close();
  }

  if (recorder.failed.length > 0) {
    const failedNames = recorder.failed.map((result) => result.name).join("；");
    throw new Error(`${testName}未通过：${failedNames}`);
  }

  logger.info(`${testName}全部通过。`);
  return {
    ok: true,
    model: TEST_MODEL,
    results: recorder.results
  };
}
