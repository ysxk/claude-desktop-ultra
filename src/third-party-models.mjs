import fs from "node:fs/promises";
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
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

function claude3pRoot() {
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

  const appliedId = meta?.appliedId || "default";
  const configPath = path.join(libraryDir, `${appliedId}.json`);
  return { rootDir, libraryDir, metaPath, configPath, appliedId, meta };
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
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: gatewayHeaders(config)
  });
  if (!response.ok) {
    throw new Error(`Gateway /v1/models 返回 ${response.status} ${response.statusText}`);
  }

  const models = normalizeModels(await response.json());
  return options.includeNonChatModels ? models : models.filter(isChatLikeModel);
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

export async function syncThirdPartyModels(options = {}) {
  const paths = await getAppliedConfigPath(options.rootDir);
  let config = {};
  if (await pathExists(paths.configPath)) {
    config = await readJson(paths.configPath);
  }

  const fetchedModels = await fetchGatewayModels(config, options);
  const requestedModels = Array.isArray(options.models) ? options.models : [];
  const existingModels = configuredModelNames(config);
  const discoveredModels = [...new Set([...requestedModels, ...fetchedModels, ...existingModels])].filter(Boolean);
  const orderedModels = orderModelsForGateway(discoveredModels);
  const probeResult = await findWorkingGatewayModel(config, orderedModels, {
    ...options,
    probeModels: options.probeModels !== false
  });
  const models = promoteModel(orderedModels, probeResult.model);

  if (models.length === 0) {
    return {
      changed: false,
      configPath: paths.configPath,
      provider: config.inferenceProvider,
      modelCount: 0,
      models: [],
      verifiedModel: null,
      probeSkipped: probeResult.skipped || null,
      probeFailures: probeResult.failures || []
    };
  }

  const nextConfig = {
    ...config,
    inferenceModels: models.map(modelEntry),
    unstableDisableModelVerification: true
  };

  const previous = JSON.stringify(config);
  const next = JSON.stringify(nextConfig);
  if (previous !== next && await pathExists(paths.configPath)) {
    await fs.copyFile(paths.configPath, `${paths.configPath}.bak-${timestamp()}`);
  }
  if (previous !== next) {
    await writeJson(paths.configPath, nextConfig);
  }

  return {
    changed: previous !== next,
    configPath: paths.configPath,
    provider: nextConfig.inferenceProvider,
    modelCount: models.length,
    models,
    verifiedModel: probeResult.model || null,
    probeSkipped: probeResult.skipped || null,
    probeFailures: probeResult.failures || []
  };
}
