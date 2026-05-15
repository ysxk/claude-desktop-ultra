import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function injectedRuntime(config) {
  const globalKey = "__CLAUDE_ZH_CN_OVERLAY__";

  const createOverlay = () => {
    const state = {
      config,
      dictionary: new Map(),
      patterns: [],
      mutating: false,
      observer: null
    };

    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const compilePlaceholderPattern = (source, target) => {
      if (!source.includes("{") || source.includes("plural,")) {
        return null;
      }

      const literalText = source.replace(/\{[a-zA-Z0-9_]+\}/g, "");
      if (literalText.replace(/\s+/g, "").length < 4) {
        return null;
      }

      const names = [];
      const pattern = escapeRegExp(source).replace(/\\\{([a-zA-Z0-9_]+)\\\}/g, (_, name) => {
        names.push(name);
        return "(.+?)";
      });

      if (names.length === 0) {
        return null;
      }

      return {
        regex: new RegExp(`^${pattern}$`),
        render(match) {
          let rendered = target;
          names.forEach((name, index) => {
            rendered = rendered.replaceAll(`{${name}}`, match[index + 1]);
          });
          return rendered;
        }
      };
    };

    const update = (nextConfig) => {
      state.config = nextConfig;
      state.dictionary = new Map(Object.entries(nextConfig.dictionary || {}));
      state.patterns = Object.entries(nextConfig.dictionary || {})
        .map(([source, target]) => compilePlaceholderPattern(source, target))
        .filter(Boolean);
    };

    const withMutationPause = (fn) => {
      if (state.mutating) {
        return;
      }
      state.mutating = true;
      try {
        fn();
      } finally {
        setTimeout(() => {
          state.mutating = false;
        }, 0);
      }
    };

    const splitWhitespace = (value) => {
      const leading = value.match(/^\s*/)?.[0] ?? "";
      const trailing = value.match(/\s*$/)?.[0] ?? "";
      const body = value.slice(leading.length, value.length - trailing.length);
      return { leading, body, trailing };
    };

    const translate = (value) => {
      if (!value || typeof value !== "string") {
        return value;
      }
      if (/[\u4e00-\u9fff]/.test(value)) {
        return value;
      }

      const { leading, body, trailing } = splitWhitespace(value);
      if (!body) {
        return value;
      }

      const exact = state.dictionary.get(body);
      if (exact) {
        return `${leading}${exact}${trailing}`;
      }

      for (const pattern of state.patterns) {
        const match = body.match(pattern.regex);
        if (match) {
          return `${leading}${pattern.render(match)}${trailing}`;
        }
      }

      return value;
    };

    const skipSelector = () => state.config.skipTextSelectors?.join(",") || "";

    const isEditableElement = (element) => {
      if (!(element instanceof Element)) {
        return false;
      }
      if (element instanceof HTMLTextAreaElement) {
        return true;
      }
      if (element instanceof HTMLInputElement) {
        return !["button", "submit", "reset", "checkbox", "radio", "file", "image", "color", "range"].includes(element.type);
      }
      if (element.isContentEditable) {
        return true;
      }
      if (element.closest('[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) {
        return true;
      }
      return false;
    };

    const shouldSkipElement = (element) => {
      const selector = skipSelector();
      return isEditableElement(element) || Boolean(selector && element.closest(selector));
    };

    const shouldSkipTextNode = (node) => {
      const parent = node.parentElement;
      if (!parent) {
        return true;
      }
      return shouldSkipElement(parent);
    };

    const processTextNode = (node) => {
      if (shouldSkipTextNode(node)) {
        return;
      }
      const next = translate(node.nodeValue);
      if (next !== node.nodeValue) {
        node.nodeValue = next;
      }
    };

    const processElement = (element) => {
      if (!(element instanceof Element)) {
        return;
      }
      if (shouldSkipElement(element)) {
        return;
      }

      for (const attribute of state.config.translateAttributes || []) {
        if (!element.hasAttribute(attribute)) {
          continue;
        }
        const current = element.getAttribute(attribute);
        const next = translate(current);
        if (next !== current) {
          element.setAttribute(attribute, next);
        }
      }

      if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)) {
        const next = translate(element.value);
        if (next !== element.value) {
          element.value = next;
        }
      }
    };

    const processRootInternal = (root) => {
      if (root.nodeType === Node.TEXT_NODE) {
        processTextNode(root);
        return;
      }

      if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
        return;
      }

      if (root.nodeType === Node.ELEMENT_NODE) {
        processElement(root);
        if (root.shadowRoot) {
          processRootInternal(root.shadowRoot);
        }
      }

      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
      );

      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processElement(node);
          if (node.shadowRoot) {
            processRootInternal(node.shadowRoot);
          }
        } else if (node.nodeType === Node.TEXT_NODE) {
          processTextNode(node);
        }
      }

      document.title = translate(document.title);
    };

    const processRoot = (root) => {
      withMutationPause(() => processRootInternal(root));
    };

    const refresh = () => {
      if (document.documentElement) {
        processRoot(document.documentElement);
      }
    };

    const start = () => {
      update(config);
      refresh();

      state.observer = new MutationObserver((records) => {
        if (state.mutating) {
          return;
        }

        withMutationPause(() => {
          for (const record of records) {
            if (record.type === "characterData") {
              processRootInternal(record.target);
            } else if (record.type === "attributes") {
              processRootInternal(record.target);
            } else {
              for (const node of record.addedNodes) {
                processRootInternal(node);
              }
            }
          }
        });
      });

      state.observer.observe(document.documentElement || document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: state.config.translateAttributes || undefined
      });
    };

    return { update, refresh, start };
  };

  if (window[globalKey]) {
    window[globalKey].update(config);
    window[globalKey].refresh();
    return;
  }

  const overlay = createOverlay();
  window[globalKey] = overlay;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => overlay.start(), { once: true });
  } else {
    overlay.start();
  }
}

function loadInjectedRuntimeSource() {
  const runtimePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "injected-runtime.txt");
  try {
    return fs.readFileSync(runtimePath, "utf8").trim();
  } catch {
    const fallback = injectedRuntime.toString();
    if (fallback.includes("[native code]")) {
      throw new Error("无法读取汉化注入运行时代码。");
    }
    return fallback;
  }
}

export function buildInjectionSource({ dictionary, profile, launchLocale, localeOverride = false }) {
  const config = {
    locale: profile.locale,
    fallbackLocale: profile.fallbackLocale || "en-US",
    launchLocale: launchLocale || profile.locale,
    localeOverride,
    dictionary,
    translateAttributes: profile.translateAttributes,
    skipTextSelectors: profile.skipTextSelectors
  };

  return `;(${loadInjectedRuntimeSource()})(${JSON.stringify(config)});`;
}
