import fs from "node:fs/promises";
import path from "node:path";

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

function normalizeDictionaryFile(entry) {
  if (typeof entry === "string") {
    return { path: entry, audit: "official" };
  }
  return entry;
}

export async function loadProfile(rootDir, profilePath) {
  const resolvedProfilePath = profilePath
    ? path.resolve(profilePath)
    : path.join(rootDir, "profiles", "zh-CN.json");
  const profile = await readJson(resolvedProfilePath);
  const profileDir = path.dirname(resolvedProfilePath);
  const dictionary = {};
  const auditDictionary = {};

  for (const rawEntry of profile.dictionaryFiles || []) {
    const entry = normalizeDictionaryFile(rawEntry);
    const dictionaryPath = path.resolve(profileDir, entry.path);
    const loaded = await readJson(dictionaryPath);
    Object.assign(dictionary, loaded);
    if (entry.audit === "official") {
      Object.assign(auditDictionary, loaded);
    }
  }

  if (profile.dictionary) {
    Object.assign(dictionary, profile.dictionary);
    Object.assign(auditDictionary, profile.dictionary);
  }

  return {
    profile,
    profilePath: resolvedProfilePath,
    dictionary,
    auditDictionary
  };
}

export async function readEnglishLocale(app) {
  const localePath = path.join(app.resourcesDir, "en-US.json");
  const locale = await readJson(localePath);
  return {
    localePath,
    locale
  };
}

export function auditLocale(englishLocale, auditDictionary) {
  const sourceValues = [...new Set(Object.values(englishLocale).filter((value) => typeof value === "string"))];
  const translated = sourceValues.filter((value) => Object.prototype.hasOwnProperty.call(auditDictionary, value));
  const missing = sourceValues.filter((value) => !Object.prototype.hasOwnProperty.call(auditDictionary, value));
  const stale = Object.keys(auditDictionary).filter((value) => !sourceValues.includes(value));

  return {
    total: sourceValues.length,
    translated,
    missing,
    stale
  };
}

export async function writeMissingTemplate(rootDir, app, missing) {
  const generatedDir = path.join(rootDir, "generated");
  await fs.mkdir(generatedDir, { recursive: true });
  const safeVersion = (app.version || "unknown").replace(/[^\w.-]+/g, "_");
  const outputPath = path.join(generatedDir, `missing-${safeVersion}.zh-CN.template.json`);
  const template = Object.fromEntries(missing.map((value) => [value, ""]));
  await fs.writeFile(outputPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  return outputPath;
}

