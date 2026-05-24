import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isUuid(value) {
  return typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

function claude3pRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude-3p");
  }

  const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd();
  return path.join(base, "Claude-3p");
}

async function getAppliedConfigPath(rootDir = claude3pRoot()) {
  const libraryDir = path.join(rootDir, "configLibrary");
  const metaPath = path.join(libraryDir, "_meta.json");
  let meta = null;

  if (await pathExists(metaPath)) {
    meta = await readJson(metaPath);
  }

  const appliedId = isUuid(meta?.appliedId) ? meta.appliedId : crypto.randomUUID();
  const configPath = path.join(libraryDir, `${appliedId}.json`);
  const legacyConfigPath = path.join(libraryDir, "default.json");
  return { rootDir, libraryDir, metaPath, configPath, legacyConfigPath, appliedId, meta };
}

async function ensureAppliedMeta(paths) {
  const entryName = "Claude ultra";
  const entries = Array.isArray(paths.meta?.entries)
    ? paths.meta.entries.filter((entry) => entry && isUuid(entry.id))
    : [];
  const hasAppliedEntry = entries.some((entry) => entry.id === paths.appliedId);
  const nextMeta = {
    ...paths.meta,
    appliedId: paths.appliedId,
    entries: hasAppliedEntry ? entries : [...entries, { id: paths.appliedId, name: entryName }]
  };
  const previous = JSON.stringify(paths.meta || {});
  const next = JSON.stringify(nextMeta);
  if (previous !== next) {
    await writeJson(paths.metaPath, nextMeta);
  }
  paths.meta = nextMeta;
  return { changed: previous !== next, meta: nextMeta };
}

async function ensureDeploymentMode(rootDir) {
  const configPath = path.join(rootDir, "claude_desktop_config.json");
  let config = {};
  const existed = await pathExists(configPath);
  if (existed) {
    try {
      config = await readJson(configPath);
    } catch {
      config = {};
    }
  }

  const nextConfig = {
    ...config,
    deploymentMode: "3p"
  };
  const previous = JSON.stringify(config);
  const next = JSON.stringify(nextConfig);
  if (previous !== next && existed) {
    await fs.copyFile(configPath, `${configPath}.bak-${timestamp()}`);
  }
  if (previous !== next) {
    await writeJson(configPath, nextConfig);
  }

  return {
    path: configPath,
    changed: previous !== next,
    previousMode: config.deploymentMode || null,
    mode: nextConfig.deploymentMode
  };
}

function authHeaders(config) {
  const apiKey = config.inferenceGatewayApiKey;
  if (!apiKey) {
    return {};
  }

  const scheme = config.inferenceGatewayAuthScheme || "bearer";
  if (scheme === "x-api-key") {
    return { "x-api-key": apiKey };
  }
  return { authorization: `Bearer ${apiKey}` };
}

function extraGatewayHeaders(config) {
  const headers = config.inferenceGatewayHeaders;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name, value]) => typeof name === "string" && name.trim() && typeof value === "string" && value.trim())
  );
}

function gatewayHeaders(config) {
  return {
    ...extraGatewayHeaders(config),
    ...authHeaders(config)
  };
}

function gatewayBaseUrl(config) {
  return String(config.inferenceGatewayBaseUrl || "").replace(/\/+$/, "");
}

function parseModelList(value) {
  if (Array.isArray(value)) {
    return value.flatMap(parseModelList);
  }
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(/[\n,;]+/g)
    .map((model) => model.trim())
    .filter(Boolean);
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim());
}

function configOverridesFromOptions(options = {}) {
  const gatewayBaseUrl = firstNonEmpty(
    options.gatewayBaseUrl,
    process.env.CLAUDE_ULTRA_GATEWAY_BASE_URL,
    process.env.CLAUDE_3P_GATEWAY_BASE_URL
  );
  const gatewayApiKey = firstNonEmpty(
    options.gatewayApiKey,
    process.env.CLAUDE_ULTRA_GATEWAY_API_KEY,
    process.env.CLAUDE_3P_GATEWAY_API_KEY
  );
  const gatewayAuthScheme = firstNonEmpty(
    options.gatewayAuthScheme,
    process.env.CLAUDE_ULTRA_GATEWAY_AUTH_SCHEME,
    process.env.CLAUDE_3P_GATEWAY_AUTH_SCHEME
  );
  const inferenceProvider = firstNonEmpty(
    options.inferenceProvider,
    gatewayBaseUrl ? "gateway" : null
  );
  const overrides = {};

  if (inferenceProvider) {
    overrides.inferenceProvider = inferenceProvider;
  }
  if (gatewayBaseUrl) {
    overrides.inferenceGatewayBaseUrl = gatewayBaseUrl;
  }
  if (gatewayApiKey) {
    overrides.inferenceGatewayApiKey = gatewayApiKey;
  }
  if (gatewayAuthScheme) {
    overrides.inferenceGatewayAuthScheme = gatewayAuthScheme;
  }

  return overrides;
}

function diagnoseConfig(config, paths, configExists, legacyConfigMigrated) {
  const missingFields = [];
  if (config.inferenceProvider !== "gateway") {
    missingFields.push("inferenceProvider=gateway");
  }
  if (!config.inferenceGatewayBaseUrl) {
    missingFields.push("inferenceGatewayBaseUrl");
  }
  if (!config.inferenceGatewayApiKey && config.inferenceGatewayAuthScheme !== "sso") {
    missingFields.push("inferenceGatewayApiKey");
  }

  return {
    rootDir: paths.rootDir,
    libraryDir: paths.libraryDir,
    metaPath: paths.metaPath,
    appliedId: paths.appliedId,
    configExists,
    legacyConfigPath: paths.legacyConfigPath,
    legacyConfigMigrated,
    metaExists: Boolean(paths.meta),
    validAppliedId: isUuid(paths.meta?.appliedId),
    entryCount: Array.isArray(paths.meta?.entries) ? paths.meta.entries.length : 0,
    missingFields
  };
}

function normalizeModels(payload) {
  const rawModels = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  return [...new Set(
    rawModels
      .map((model) => {
        if (typeof model === "string") {
          return model;
        }
        return model?.id || model?.name || model?.model;
      })
      .filter((model) => typeof model === "string" && model.trim())
      .map((model) => model.trim())
  )];
}

function isChatLikeModel(model) {
  return !/(^|[-_/])(image|embedding|tts|audio|whisper)([-_/]|$)/i.test(model);
}

function configuredModelNames(config) {
  if (!Array.isArray(config.inferenceModels)) {
    return [];
  }

  return config.inferenceModels
    .map((model) => typeof model === "string" ? model : model?.name)
    .filter((model) => typeof model === "string" && model.trim())
    .map((model) => model.trim());
}

function modelPreference(model) {
  const normalized = String(model).toLowerCase();
  if (/(^|[-_/])(image|embedding|tts|audio|whisper)([-_/]|$)/.test(normalized)) {
    return 100;
  }
  if (/(^|[-_/])(gpt|gemini|deepseek|qwen|glm|kimi|moonshot|doubao|ernie|mistral|llama|yi)([-_/0-9.]|$)/.test(normalized)) {
    return 0;
  }
  if (/^claude([-/]|$)|(^|[-_/])(haiku|sonnet|opus)([-_/]|$)/.test(normalized)) {
    return 20;
  }
  return 10;
}

function orderModelsForGateway(models) {
  return models
    .map((model, index) => ({ model, index, preference: modelPreference(model) }))
    .sort((left, right) => left.preference - right.preference || left.index - right.index)
    .map((entry) => entry.model);
}

async function fetchGatewayModels(config, options = {}) {
  if (config.inferenceProvider !== "gateway") {
    return [];
  }
  if (!config.inferenceGatewayBaseUrl) {
    return [];
  }

  const baseUrl = gatewayBaseUrl(config);
  const timeoutMs = Number(options.gatewayTimeoutMs) || 8000;
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: gatewayHeaders(config),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Gateway /v1/models 返回 ${response.status} ${response.statusText}`);
  }

  const models = normalizeModels(await response.json());
  return options.includeNonChatModels ? models : models.filter(isChatLikeModel);
}

function canFetchGatewayModels(config) {
  return config.inferenceProvider === "gateway" && Boolean(config.inferenceGatewayBaseUrl);
}

function canProbeGateway(config) {
  return config.inferenceProvider === "gateway"
    && Boolean(config.inferenceGatewayBaseUrl)
    && Boolean(config.inferenceGatewayApiKey)
    && config.inferenceGatewayAuthScheme !== "sso";
}

async function probeGatewayModel(config, model, options = {}) {
  const timeoutMs = Number(options.modelProbeTimeoutMs) || 5000;
  const response = await fetch(`${gatewayBaseUrl(config)}/v1/messages`, {
    method: "POST",
    headers: {
      ...gatewayHeaders(config),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "." }]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (response.ok) {
    return { ok: true, model, status: response.status };
  }

  const responseBody = (await response.text().catch(() => "")).slice(0, 300);
  return {
    ok: false,
    model,
    status: response.status,
    statusText: response.statusText,
    responseBody
  };
}

async function findWorkingGatewayModel(config, models, options = {}) {
  if (!options.probeModels) {
    return { skipped: "disabled" };
  }
  if (!canProbeGateway(config)) {
    return { skipped: "missing-static-gateway-credential" };
  }

  const limit = Math.max(1, Math.min(Number(options.modelProbeLimit) || 8, models.length));
  const failures = [];
  for (const model of models.slice(0, limit)) {
    try {
      const result = await probeGatewayModel(config, model, options);
      if (result.ok) {
        return { model, failures };
      }
      failures.push(result);
      if (result.status === 401 || result.status === 403) {
        break;
      }
    } catch (error) {
      failures.push({
        model,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { failures };
}

function promoteModel(models, preferredModel) {
  if (!preferredModel || !models.includes(preferredModel)) {
    return models;
  }

  return [preferredModel, ...models.filter((model) => model !== preferredModel)];
}

function displayLabel(model) {
  return model
    .replace(/^zai-org\//, "")
    .split(/[-_/]+/g)
    .filter(Boolean)
    .map((part) => {
      if (/^(gpt|glm|api|ai|vm|mcp)$/i.test(part)) {
        return part.toUpperCase();
      }
      if (/^\d+(\.\d+)*$/.test(part)) {
        return part;
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function modelEntry(model) {
  return {
    name: model,
    labelOverride: displayLabel(model)
  };
}

function isGeneratedModelEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }

  const keys = Object.keys(entry);
  return keys.length === 2
    && keys.includes("name")
    && keys.includes("labelOverride")
    && typeof entry.name === "string"
    && entry.labelOverride === displayLabel(entry.name);
}

function hasGeneratedModelList(config) {
  return Array.isArray(config.inferenceModels)
    && config.inferenceModels.length > 0
    && config.inferenceModels.every(isGeneratedModelEntry);
}

export async function syncThirdPartyModels(options = {}) {
  const paths = await getAppliedConfigPath(options.rootDir);
  const configExists = await pathExists(paths.configPath);
  const legacyConfigExists = !configExists && await pathExists(paths.legacyConfigPath);
  let legacyConfigMigrated = false;
  let config = {};
  if (configExists) {
    config = await readJson(paths.configPath);
  } else if (legacyConfigExists) {
    config = await readJson(paths.legacyConfigPath);
    legacyConfigMigrated = true;
  }
  config = {
    ...config,
    ...configOverridesFromOptions(options)
  };

  let fetchedModels = [];
  let fetchError = null;
  const shouldFetchGatewayModels = canFetchGatewayModels(config);
  let fetchedGatewayModels = false;
  try {
    fetchedModels = await fetchGatewayModels(config, options);
    fetchedGatewayModels = shouldFetchGatewayModels;
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
  }

  const requestedModels = parseModelList(
    options.models
      ?? options.model
      ?? process.env.CLAUDE_ULTRA_MODELS
      ?? process.env.CLAUDE_3P_MODELS
  );
  const existingModels = configuredModelNames(config);
  const shouldPreferDynamicGatewayModels = configExists
    && !legacyConfigMigrated
    && requestedModels.length === 0
    && options.persistDiscoveredModels !== true
    && canFetchGatewayModels(config);
  const shouldUseExistingModels = requestedModels.length === 0
    && !fetchedGatewayModels
    && !shouldPreferDynamicGatewayModels;
  const discoveredModels = [...new Set([
    ...requestedModels,
    ...fetchedModels,
    ...(shouldUseExistingModels ? existingModels : [])
  ])].filter(Boolean);
  const orderedModels = orderModelsForGateway(discoveredModels);
  const hasThirdPartyConnection = Boolean(
    config.inferenceProvider
      || config.inferenceGatewayBaseUrl
      || config.inferenceGatewayApiKey
      || config.inferenceGatewayAuthScheme === "sso"
  );
  const shouldActivateThirdParty = hasThirdPartyConnection || fetchedModels.length > 0;
  const metaResult = shouldActivateThirdParty
    ? await ensureAppliedMeta(paths)
    : { changed: false, meta: paths.meta };
  const deploymentMode = shouldActivateThirdParty
    ? await ensureDeploymentMode(paths.rootDir)
    : null;
  const diagnostic = diagnoseConfig(config, paths, configExists || legacyConfigMigrated, legacyConfigMigrated);
  const probeResult = await findWorkingGatewayModel(config, orderedModels, {
    ...options,
    probeModels: options.probeModels !== false
  });
  const models = promoteModel(orderedModels, probeResult.model);
  const existingGeneratedModelList = hasGeneratedModelList(config);
  const buildNextConfig = () => {
    const nextConfig = {
      ...config,
      unstableDisableModelVerification: true
    };

    if (shouldPreferDynamicGatewayModels) {
      if (existingGeneratedModelList) {
        delete nextConfig.inferenceModels;
      }
      return nextConfig;
    }

    if (models.length > 0) {
      nextConfig.inferenceModels = models.map(modelEntry);
    } else if (fetchedGatewayModels || requestedModels.length > 0) {
      nextConfig.inferenceModels = [];
    }

    return nextConfig;
  };
  const modelListMode = shouldPreferDynamicGatewayModels
    ? existingGeneratedModelList
      ? "dynamic-cleared-generated"
      : Array.isArray(config.inferenceModels)
        ? "preserved-existing"
        : "dynamic"
    : "static";

  if (models.length === 0) {
    let configChanged = false;
    if (shouldActivateThirdParty) {
      const nextConfig = buildNextConfig();
      const previous = JSON.stringify(config);
      const next = JSON.stringify(nextConfig);
      const shouldWriteConfig = previous !== next || legacyConfigMigrated || !(await pathExists(paths.configPath));
      if (shouldWriteConfig && await pathExists(paths.configPath)) {
        await fs.copyFile(paths.configPath, `${paths.configPath}.bak-${timestamp()}`);
      }
      if (shouldWriteConfig) {
        await writeJson(paths.configPath, nextConfig);
      }
      configChanged = shouldWriteConfig;
    }

    return {
      changed: configChanged || metaResult.changed || Boolean(deploymentMode?.changed),
      configPath: paths.configPath,
      provider: config.inferenceProvider,
      modelCount: 0,
      models: [],
      verifiedModel: null,
      probeSkipped: probeResult.skipped || null,
      probeFailures: probeResult.failures || [],
      fetchError,
      modelListMode,
      metaChanged: metaResult.changed,
      deploymentMode,
      ...diagnostic
    };
  }

  const nextConfig = buildNextConfig();

  const previous = JSON.stringify(config);
  const next = JSON.stringify(nextConfig);
  const shouldWriteConfig = previous !== next || legacyConfigMigrated || !(await pathExists(paths.configPath));
  if (shouldWriteConfig && await pathExists(paths.configPath)) {
    await fs.copyFile(paths.configPath, `${paths.configPath}.bak-${timestamp()}`);
  }
  if (shouldWriteConfig) {
    await writeJson(paths.configPath, nextConfig);
  }

  return {
    changed: shouldWriteConfig,
    configPath: paths.configPath,
    provider: nextConfig.inferenceProvider,
    modelCount: models.length,
    models,
    verifiedModel: probeResult.model || null,
    probeSkipped: probeResult.skipped || null,
    probeFailures: probeResult.failures || [],
    fetchError,
    modelListMode,
    metaChanged: metaResult.changed,
    deploymentMode,
    ...diagnostic
  };
}
