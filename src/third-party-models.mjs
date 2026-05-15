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

async function fetchGatewayModels(config, options = {}) {
  if (config.inferenceProvider !== "gateway") {
    return [];
  }
  if (!config.inferenceGatewayBaseUrl) {
    return [];
  }

  const baseUrl = String(config.inferenceGatewayBaseUrl).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: authHeaders(config)
  });
  if (!response.ok) {
    throw new Error(`Gateway /v1/models 返回 ${response.status} ${response.statusText}`);
  }

  const models = normalizeModels(await response.json());
  return options.includeNonChatModels ? models : models.filter(isChatLikeModel);
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
  const models = [...new Set([...requestedModels, ...fetchedModels])].filter(Boolean);

  if (models.length === 0) {
    return {
      changed: false,
      configPath: paths.configPath,
      provider: config.inferenceProvider,
      modelCount: 0,
      models: []
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
    models
  };
}
