import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { detectClaude } from "./adapters/claude-desktop.mjs";
import { buildInjectionSource } from "./injection-source.mjs";
import { loadProfile } from "./locale.mjs";
import {
  applyCodeOrgDisabledGatePatch,
  applyMaxEffortPatchRules,
  buildMainProcessPatch,
  patchGatewayUrlValidation,
  patchMacDesktopUserAgent,
  patchUltraLocalBridge,
  prepareMacPortableRuntime,
  preparePortableRuntime
} from "./portable-runtime.mjs";
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

async function startFakeGateway({
  models = [
    { id: "claude-3-5-sonnet" },
    { id: TEST_MODEL },
    { id: "text-embedding-3-large" }
  ],
  workingModel = TEST_MODEL
} = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: models }));
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

      if (payload.model === workingModel) {
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

async function testGatewayModelRefreshReplacesStaleModels(recorder) {
  const gateway = await startFakeGateway({
    models: [
      { id: "gpt-new-chat" },
      { id: "qwen-new-chat" },
      { id: "text-embedding-3-large" }
    ]
  });
  const rootDir = await makeTempDir("claude-ultra-refresh-");
  try {
    const appliedId = "11111111-1111-4111-8111-111111111111";
    const libraryDir = path.join(rootDir, "configLibrary");
    await fs.mkdir(libraryDir, { recursive: true });
    await fs.writeFile(
      path.join(libraryDir, "_meta.json"),
      `${JSON.stringify({
        appliedId,
        entries: [{ id: appliedId, name: "Claude ultra" }]
      }, null, 2)}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(libraryDir, `${appliedId}.json`),
      `${JSON.stringify({
        inferenceProvider: "gateway",
        inferenceGatewayBaseUrl: "http://127.0.0.1:1",
        inferenceGatewayApiKey: "old-key",
        inferenceModels: [{ name: "old-site-only", labelOverride: "Old Site Only" }],
        unstableDisableModelVerification: true
      }, null, 2)}\n`,
      "utf8"
    );

    await syncThirdPartyModels({
      rootDir,
      gatewayBaseUrl: gateway.baseUrl,
      gatewayApiKey: "new-key",
      probeModels: false,
      gatewayTimeoutMs: 2000
    });
    const config = await validateModelConfig(rootDir);
    const modelNames = config.config.inferenceModels?.map((model) => model.name) || [];

    recorder.check("新 Gateway 模型会替换旧模型列表", modelNames.includes("gpt-new-chat") && modelNames.includes("qwen-new-chat"), modelNames.join(", "));
    recorder.check("旧 Gateway 独有模型会被删除", !modelNames.includes("old-site-only"), modelNames.join(", "));
  } finally {
    await gateway.close();
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

function testUltraRuntimeApi(recorder) {
  const source = buildInjectionSource({
    dictionary: {},
    profile: {
      locale: "zh-CN",
      fallbackLocale: "en-US",
      translateAttributes: [],
      skipTextSelectors: []
    },
    launchLocale: "zh-CN",
    localeOverride: true
  });

  const storage = new Map();
  class TestElement {
    nodeType = 1;
    lang = "";
    childElementCount = 0;
    tagName = "HTML";
    setAttribute() {}
    hasAttribute() {
      return false;
    }
    getAttribute() {
      return null;
    }
    closest() {
      return null;
    }
  }
  class TestHTMLElement extends TestElement {}
  class TestInputElement extends TestHTMLElement {
    type = "text";
    value = "";
  }
  class TestTextAreaElement extends TestHTMLElement {}
  const documentElement = new TestElement();
  const documentStub = {
    readyState: "complete",
    documentElement,
    body: null,
    title: "",
    querySelectorAll: () => [],
    getElementById: () => null,
    createTreeWalker: () => ({ nextNode: () => null }),
    addEventListener() {}
  };
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    addEventListener: globalThis.addEventListener,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    MutationObserver: globalThis.MutationObserver,
    Node: globalThis.Node,
    NodeFilter: globalThis.NodeFilter,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    localStorageDescriptor: Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  };

  try {
    globalThis.window = globalThis;
    globalThis.document = documentStub;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
      }
    });
    globalThis.location = { href: "https://claude.ai/" };
    globalThis.history = {
      pushState() {},
      replaceState() {}
    };
    globalThis.addEventListener = () => {};
    globalThis.fetch = () => Promise.resolve(new Response("{}"));
    globalThis.setTimeout = (callback) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0;
    };
    globalThis.clearTimeout = () => {};
    globalThis.MutationObserver = class {
      observe() {}
    };
    globalThis.Node = {
      TEXT_NODE: 3,
      ELEMENT_NODE: 1,
      DOCUMENT_NODE: 9,
      DOCUMENT_FRAGMENT_NODE: 11
    };
    globalThis.NodeFilter = {
      SHOW_ELEMENT: 1,
      SHOW_TEXT: 4
    };
    globalThis.Element = TestElement;
    globalThis.HTMLElement = TestHTMLElement;
    globalThis.HTMLInputElement = TestInputElement;
    globalThis.HTMLTextAreaElement = TestTextAreaElement;

    new Function(source)();
    const api = globalThis.__CLAUDE_ULTRA__;
    recorder.check("Ultra API 已暴露", Boolean(api?.prepareMessagesRequestInit && api?.modelWithOneMillionContext));
    recorder.check("1M 默认关闭时不改模型", api.modelWithOneMillionContext(TEST_MODEL) === TEST_MODEL);

    storage.set("__claude_ultra_features__", JSON.stringify({ oneMillionContext: true }));
    recorder.check("1M 开启后本地模型标记追加 [1m]", api.modelWithOneMillionContext(TEST_MODEL) === `${TEST_MODEL}[1m]`);
    recorder.check("1M 不改 default 模型", api.modelWithOneMillionContext("default") === "default");

    const localSession = api.prepareLocalSessionInfo({ model: TEST_MODEL, message: "hi" });
    recorder.check("本地 session start 会携带 [1m] 标记", localSession.model === `${TEST_MODEL}[1m]`);

    const init = api.prepareMessagesRequestInit("https://gateway.example/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `${TEST_MODEL}[1m]`,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }]
      })
    });
    const payload = JSON.parse(init.body);
    const headers = new Headers(init.headers);
    recorder.check("Messages 请求会剥离 model 后缀", payload.model === TEST_MODEL);
    recorder.check(
      "Messages 请求会追加 1M beta header",
      headers.get("anthropic-beta")?.split(",").map((value) => value.trim()).includes("context-1m-2025-08-07")
    );
  } finally {
    delete globalThis.__CLAUDE_ULTRA__;
    delete globalThis.__CLAUDE_ULTRA_PREPARE_MODEL__;
    delete globalThis.__CLAUDE_ULTRA_PREPARE_LOCAL_SESSION__;
    delete globalThis.__CLAUDE_ULTRA_PREPARE_MESSAGES_REQUEST__;
    delete globalThis._cuM;
    delete globalThis._cu1;
    delete globalThis._uM;
    delete globalThis._u1;
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    if (previous.localStorageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", previous.localStorageDescriptor);
    } else {
      delete globalThis.localStorage;
    }
    globalThis.location = previous.location;
    globalThis.history = previous.history;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.fetch = previous.fetch;
    globalThis.setTimeout = previous.setTimeout;
    globalThis.clearTimeout = previous.clearTimeout;
    globalThis.MutationObserver = previous.MutationObserver;
    globalThis.Node = previous.Node;
    globalThis.NodeFilter = previous.NodeFilter;
    globalThis.Element = previous.Element;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.HTMLInputElement = previous.HTMLInputElement;
    globalThis.HTMLTextAreaElement = previous.HTMLTextAreaElement;
  }
}

function testUltraMenuI18n(recorder) {
  const source = buildInjectionSource({
    dictionary: {},
    profile: {
      locale: "zh-CN",
      fallbackLocale: "en-US",
      translateAttributes: [],
      skipTextSelectors: []
    },
    launchLocale: "zh-CN",
    localeOverride: true
  });

  recorder.check(
    "Ultra 菜单包含中文 i18n 文案",
    source.includes("1M 上下文") && source.includes("Ultra：已启用 1M 上下文")
  );
  recorder.check(
    "Ultra 菜单保留英文 fallback 文案",
    source.includes("1M context") && source.includes("Ultra: 1M context enabled")
  );
  recorder.check(
    "Ultra 菜单文案跟随当前 locale",
    source.includes("state.currentLocale || readCurrentLocale()") && source.includes('startsWith("zh")')
  );
}

function testUltraMenuPrefersComposerAddButton(recorder) {
  const runtimeSource = buildInjectionSource({
    dictionary: {},
    profile: {
      locale: "zh-CN",
      fallbackLocale: "en-US",
      translateAttributes: [],
      skipTextSelectors: []
    },
    launchLocale: "zh-CN",
    localeOverride: true
  });
  const runtime = runtimeSource.match(/;\(([\s\S]+)\)\(/)?.[1] || "";
  const source = runtime.slice(
    runtime.indexOf("const findAttachmentButton"),
    runtime.indexOf("const buttonBaseStyle")
  );
  const helperSource = [
    "const buttonSelector = \"button,[role='button'],[role='combobox'],[aria-label],[title]\";",
    "const exactAddButtonName = (name) => { const normalized = String(name || \"\").replace(/\\s+/g, \" \").trim(); return normalized === \"+\" || /(?:^|\\s)(?:add|添加)(?:\\s|$)/i.test(normalized); };",
    "const permissionModeButtonName = (name) => (/accept edit|accept edits|接受编辑|permission|permissions|权限|计划模式|plan mode|bypass|ask/i.test(String(name || \"\")));",
    "const rectCenterY = (rect) => rect.top + (rect.height / 2);",
    "const sameButtonRow = (left, right) => Math.abs(rectCenterY(left) - rectCenterY(right)) <= Math.max(10, Math.min(left.height, right.height) * 0.7);",
    "const isComposerTextbox = (element) => element?.isTextbox === true && Boolean(visibleRect(element));"
  ].join("");
  const factory = new Function("visibleRect", "buttonName", "return (() => {" + helperSource + source + "; return findAttachmentButton; })();");
  const ultraMenuId = "claude-ultra-menu";
  const ultraPanelId = "claude-ultra-panel";
  const textbox = {
    isTextbox: true,
    rect: { width: 780, height: 46, top: 120, bottom: 166 },
    getBoundingClientRect() {
      return this.rect;
    }
  };

  const buttons = [
    { name: "本地", text: "本地", rect: { width: 54, height: 32, top: 52, bottom: 84, left: 0, right: 54 } },
    { name: "选择文件夹…", text: "选择文件夹…", rect: { width: 104, height: 32, top: 52, bottom: 84, left: 62, right: 166 } },
    { name: "接受编辑", text: "接受编辑", rect: { width: 68, height: 32, top: 182, bottom: 214, left: 0, right: 68 } },
    { name: "Add", title: "Add attachments", text: "", rect: { width: 32, height: 32, top: 182, bottom: 214, left: 76, right: 108 } },
    { name: "GLM 5 · Medium", text: "GLM 5 · Medium", rect: { width: 116, height: 32, top: 182, bottom: 214, left: 680, right: 796 } }
  ];
  for (const button of buttons) {
    button.id = "";
    button.closest = (selector) => selector === `#${ultraPanelId}` ? null : null;
    button.getBoundingClientRect = () => button.rect;
    button.querySelector = () => null;
    button.getAttribute = (name) => {
      if (name === "aria-label") {
        return button.name;
      }
      if (name === "title") {
        return button.title || null;
      }
      return null;
    };
    button.textContent = button.text;
  }
  const root = {
    querySelectorAll: (selector) => selector === "button,[role='button'],[role='combobox'],[aria-label],[title]" ? buttons : [textbox]
  };
  const findAttachmentButton = factory(
    (element) => element.rect,
    (button) => [button.getAttribute("aria-label"), button.textContent].filter(Boolean).join(" ").trim()
  );

  globalThis.ultraMenuId = ultraMenuId;
  globalThis.ultraPanelId = ultraPanelId;
  recorder.check("Ultra 菜单优先挂到输入框下方 Add 按钮右侧", findAttachmentButton(root) === buttons[3]);
  recorder.check(
    "Ultra 菜单已存在时仍会移动到目标 Add 后方",
    runtime.includes("root.previousElementSibling !== attachmentButton")
      && runtime.includes('attachmentButton.insertAdjacentElement("afterend", root)')
  );
  delete globalThis.ultraMenuId;
  delete globalThis.ultraPanelId;
}

function testUltraMenuStableInteraction(recorder) {
  const source = buildInjectionSource({
    dictionary: {},
    profile: {
      locale: "zh-CN",
      fallbackLocale: "en-US",
      translateAttributes: [],
      skipTextSelectors: []
    },
    launchLocale: "zh-CN",
    localeOverride: true
  });

  recorder.check(
    "Ultra menu filters overlay-only mutation records",
    source.includes("externalRecords = records.filter((record) => !isOverlayMutationRecord(record))")
      && source.includes("externalRecords.length === 0")
  );
  recorder.check(
    "Ultra panel keeps checkbox DOM stable after first build",
    source.includes("const syncUltraPanelControls")
      && source.includes("if (!syncUltraPanelControls(panel))")
      && source.includes("buildUltraPanelContents(panel)")
  );
  recorder.check(
    "Ultra panel row click toggles state without depending only on checkbox change",
    source.includes('row.addEventListener("click"')
      && source.includes("toggleFeature()")
      && source.includes('input.addEventListener("keydown"')
  );
  recorder.check(
    "Ultra outside-click listener uses the current root button",
    source.includes("state.ultraRoot?.contains(event.target)")
  );
  recorder.check(
    "1M 开启后 Ultra 按钮不再额外变色",
    !source.includes('button.style.borderColor = "#e2a37a"')
      && !source.includes('button.style.background = "#fff1e8"')
      && !source.includes('button.style.color = "#7a3516"')
  );
}

function testBaiduSkillDescriptionTranslation(recorder) {
  const source = buildInjectionSource({
    dictionary: {},
    profile: {
      locale: "zh-CN",
      fallbackLocale: "en-US",
      translateAttributes: [],
      skipTextSelectors: []
    },
    launchLocale: "zh-CN",
    localeOverride: true
  });

  recorder.check(
    "Ultra 菜单包含百度翻译 API 配置项",
    source.includes("baiduTranslate")
      && source.includes("data-ultra-baidu-app-id")
      && source.includes("data-ultra-baidu-secret-key")
  );
  recorder.check(
    "百度翻译配置区会折叠成下拉面板",
    source.includes("data-ultra-baidu-toggle")
      && source.includes("data-ultra-baidu-content")
      && source.includes("data-ultra-baidu-chevron")
  );
  recorder.check(
    "百度翻译配置包含技能简介自动翻译开关",
    source.includes("autoTranslate")
      && source.includes("data-ultra-baidu-auto")
      && source.includes("isBaiduAutoTranslateEnabled")
  );
  recorder.check(
    "百度翻译请求会用 App ID、salt 和密钥生成 MD5 签名",
    source.includes("https://fanyi-api.baidu.com/api/trans/vip/translate")
      && source.includes("md5Hex(`${config.appId}${query}${salt}${config.secretKey}`)")
  );
  recorder.check(
    "技能简介翻译按钮定位到 DescriptionRow 的简介正文",
    source.includes("p.whitespace-pre-wrap")
      && source.includes("skillDescriptionTargetFromHeading")
      && source.includes("data-claude-ultra-skill-description")
  );
  recorder.check(
    "技能简介自动翻译会处理聊天 / 菜单的悬停介绍",
    source.includes("findSlashSkillHoverDescriptionTargets")
      && source.includes("isLikelySlashSkillMenu")
      && source.includes("visibleSlashSkillFilterElements")
      && source.includes("visibleSlashSkillFilterSurfaces")
      && source.includes("visibleSlashSkillHoverTooltips")
      && source.includes("slashSkillContextVisible")
      && source.includes("hasSlashTooltipClassContext")
      && source.includes("slashSkillDescriptionPattern")
      && source.includes("slashSkillFullDescriptionTarget")
      && source.includes("isSlashSkillHoverTextPosition")
      && source.includes("rect.left >= menuRect.right - 18")
      && source.includes("[class*='line-clamp']")
      && source.includes("[class*='bg-always-black']")
      && source.includes("[class*='pointer-events-none']")
      && source.includes("new Set(visibleSlashSkillHoverTooltips())")
      && !source.includes("[role='textbox'],[placeholder],[aria-label],div,span,p")
      && source.includes("^\\([^)]+\\)\\s+[A-Za-z]")
  );
  recorder.check(
    "技能简介自动翻译会缓存悬停简介译文并暴露无密钥调试信息",
    source.includes("__claude_ultra_baidu_skill_cache__")
      && source.includes("__claude_ultra_baidu_skill_debug__")
      && source.includes("cachedSkillTranslation")
      && source.includes("rememberSkillTranslation")
      && source.includes("recordSkillTranslateDebug")
      && source.includes("debugSkillDescriptions")
      && source.includes("lastTranslateDebug")
      && source.includes("hasBaiduConfig")
      && source.includes("__CLAUDE_ULTRA_BAIDU_BRIDGE__")
      && source.includes("translateWithBaiduWindowBridge")
      && source.includes("__CLAUDE_ULTRA_BAIDU_TRANSLATE_REQUEST__")
      && source.includes("baidu-direct-bridge-failed")
      && source.includes("baidu-renderer-fetch-failed")
  );
  recorder.check(
    "技能简介自动翻译开启后不显示手动按钮",
    source.includes("const autoTranslate = isBaiduAutoTranslateEnabled();")
      && source.includes("autoTranslateSkillDescriptionTarget(target);")
      && source.includes("button.remove();")
      && source.includes("ensureSkillDescriptionTranslateButton(target);")
  );

  const mainPatch = buildMainProcessPatch(source);
  recorder.check(
    "百度翻译请求会在 Ultra 运行时补齐 CORS 响应头",
    mainPatch.includes("https://fanyi-api.baidu.com")
      && mainPatch.includes("ipcMain.handle(\"__claude_ultra_baidu_translate__\"")
      && mainPatch.includes("createHash(\"md5\")")
      && mainPatch.includes("require(\"node:https\")")
      && mainPatch.includes("net.fetch")
      && mainPatch.includes("baiduTranslateJson")
      && mainPatch.includes("Access-Control-Allow-Origin")
      && mainPatch.includes("Content-Security-Policy")
      && mainPatch.includes("connect-src")
      && mainPatch.includes("onHeadersReceived")
  );
}

function testUltraLocalBridgePatch(recorder) {
  const fixture = [
    'start(e){return abc.ipcRenderer.invoke("123_claude.web_$_LocalAgentModeSessions_$_start",e)}',
    'setModel(e,A){return abc.ipcRenderer.invoke("123_claude.web_$_LocalAgentModeSessions_$_setModel",e,A)}'
  ].join(";");
  const patched = patchUltraLocalBridge(fixture);

  recorder.check("Ultra bridge 会包装 start 入参", patched.includes("self._u1?.(e)||e"));
  recorder.check("Ultra bridge 会包装 setModel 入参", patched.includes("self._uM?.(A)||A"));
}

function testGatewayUrlValidationPatch(recorder) {
  const fixture = [
    'function jVe(e={}){return s8(A=>A,Kr().trim().url().refine(A=>{try{const{protocol:t,hostname:i}=new URL(A);return t==="https:"?!0:!!e.allowLoopbackHttp&&t==="http:"&&VVe.has(i)}catch{return!1}},{message:e.allowLoopbackHttp?"must use https (or http on loopback)":"must use https"}))}',
    'function aY(t={}){return p_(e=>e,De().trim().url().refine(e=>{try{const{protocol:n,hostname:r}=new URL(e);return n==="https:"?!0:!!t.allowLoopbackHttp&&n==="http:"&&iY.has(r)}catch{return!1}},{message:t.allowLoopbackHttp?"must use https (or http on loopback)":"must use https"}))}',
    'function S6(e){return Kr().trim().url().refine(A=>{try{const{protocol:r}=new URL(A);return r==="https:"}catch{return!1}},{message:"must use https"})}',
    'function patchedBefore(e){return Kr().trim().url().refine(A=>{try{const{protocol:q,hostname:h}=new URL(A);return q==="https:"||q==="http:"}catch{return!1}},{message:"must use http or https"})}',
    'async function oauth(e){const A=u=>u.protocol==="https:"||u.protocol==="http:"&&u.hostname==="127.0.0.1",t=new URL(e.authorizationUrl);if(!A(t))throw new Error("authorizationUrl must use https (or http on 127.0.0.1)");if(!A(new URL(e.tokenUrl)))throw new Error("tokenUrl must use https (or http on 127.0.0.1)")}',
    'async function issuer(e){const A=new URL(e.issuer),t=A.protocol==="http:"&&A.hostname==="127.0.0.1";if(A.protocol!=="https:"&&!t)throw new Error("inferenceGatewayOidc issuer must be https");return t}',
    'function discovery(o,t){for(const[s,a]of[["authorization_endpoint",o.authorization_endpoint],["token_endpoint",o.token_endpoint]]){let g;try{g=new URL(a)}catch{g=void 0}if(!((g==null?void 0:g.protocol)==="https:"||t&&(g==null?void 0:g.protocol)==="http:"&&g.hostname==="127.0.0.1"))throw new Error(`OIDC discovery returned non-https ${s}`);}}'
  ].join(";");
  const patched = patchGatewayUrlValidation(fixture);

  recorder.check("Gateway URL 校验不再限制协议", patched.includes("new URL(A);return !0"));
  recorder.check("Gateway preload URL 校验不再限制协议", patched.includes("new URL(e);return !0"));
  recorder.check("Gateway 严格 https 校验会被放开", patched.includes("const{protocol:r}=new URL(A);return !0"));
  recorder.check("Gateway 旧版 http/https 补丁会继续放开", patched.includes("const{protocol:q,hostname:h}=new URL(A);return !0"));
  recorder.check("Gateway OAuth endpoint 校验不再限制到 https 或 127.0.0.1", patched.includes("const A=u=>!0"));
  recorder.check("Gateway OIDC issuer 校验不再限制到 https 或 127.0.0.1", patched.includes("const A=new URL(e.issuer),t=!0;return t"));
  recorder.check("Gateway OIDC discovery 校验不再限制到 https 或 127.0.0.1", patched.includes("if(!g)throw new Error(`OIDC discovery returned invalid ${s}`);"));
  recorder.check("Gateway URL 校验不再限制到 https 或 loopback", !patched.includes("allowLoopbackHttp&&") && !patched.includes("http on loopback") && !patched.includes("must use https") && !patched.includes('hostname==="127.0.0.1"') && !patched.includes('==="https:"||'));
}

function testCodeOrgDisabledGatePatch(recorder) {
  const fixture = 'function yj({children:t}){const e=rt(),r=p(),n=d(),o=!y(),a=G(),u=$(),c=i("baku_enabled"),l=V(),s=!1===l,{onboardingPage:f,isLoading:h,hasError:v,environments:m,hasRunnerPools:b,refetch:g}=nj(),w=m&&m.length>0||b,O=n?.startsWith("/code/onboarding"),x="/code/family"===n,j=n?.startsWith("/code/disabled"),S=n?.startsWith("/code/share/"),P=n?.startsWith("/code/security"),E=n?.startsWith("/code/session_")||n?.startsWith("/code/cse_"),A=H.useMemo(()=>n?.startsWith("/code")||n?.startsWith("/claude-ship")?S?null:P?`/security${window.location.search}`:c&&n?.startsWith("/claude-ship")?s?"/code/disabled":a?null:"/upgrade":u||void 0===l?"loading":s?j?null:"/code/disabled":j&&!s?"/code":a?O?v?"error":null===f?"/code":null:E?null:h?"loading":v?"error":w?x?"/code":null:x?null:"/code/family":x?null:o?"https://claude.com/product/claude-code":"https://claude.com/product/claude-code?reason=no_org_access":null,[a,n,o,w,u,c,h,v,f,O,x,S,P,E,j,l,s]);return A}';
  const result = applyCodeOrgDisabledGatePatch(fixture);

  recorder.check("Claude Code org-admin 禁用门禁会被识别", result.count === 1);
  recorder.check("Claude Code org-admin 禁用门禁会被本地关闭", result.content.includes("l=V(),s=false,{onboardingPage"));
}

function testMacDesktopUserAgentPatch(recorder) {
  const legacyFixture = 'vI()&&(Q.app.userAgentFallback=`${Q.app.userAgentFallback} MSIX`);xfr();';
  const currentFixture = 'qI()&&(cA.app.userAgentFallback=`${cA.app.userAgentFallback} MSIX`);bkr();';
  const legacyPatched = patchMacDesktopUserAgent(legacyFixture);
  const currentPatched = patchMacDesktopUserAgent(currentFixture);

  recorder.check("macOS 旧版桌面 UA 补丁会追加 Claude 标识", legacyPatched.includes('Q.app.userAgentFallback+=` Claude/${Q.app.getVersion()}`;xfr();'));
  recorder.check("macOS 新版桌面 UA 补丁会追加 Claude 标识", currentPatched.includes('cA.app.userAgentFallback+=` Claude/${cA.app.getVersion()}`;bkr();'));
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
  recorder.check("运行时状态记录注入 hash 和补丁标记", typeof runtimeStatus.injectionHash === "string" && runtimeStatus.injectionHash.length === 64 && Boolean(runtimeStatus.mainProcessPatchMarker) && Boolean(runtimeStatus.preloadPatchMarker));
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
    testUltraRuntimeApi(recorder);
    testUltraMenuI18n(recorder);
    testUltraMenuPrefersComposerAddButton(recorder);
    testUltraMenuStableInteraction(recorder);
    testBaiduSkillDescriptionTranslation(recorder);
    testUltraLocalBridgePatch(recorder);
    testGatewayUrlValidationPatch(recorder);
    testCodeOrgDisabledGatePatch(recorder);
    testMacDesktopUserAgentPatch(recorder);
    testMaxEffortPatchKeepsModelMenuPrimary(recorder);
    await testEmptyConfigDoesNotActivate(recorder);
    await testBlankModelSync(recorder, gateway);
    await testLegacyModelMigration(recorder, gateway);
    await testGatewayModelRefreshReplacesStaleModels(recorder);
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
