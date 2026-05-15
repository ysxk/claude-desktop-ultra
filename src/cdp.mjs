import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function fetchJson(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForCdp(port, timeoutMs = 15000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch (error) {
      lastError = error;
      await delay(350);
    }
  }

  throw new Error(
    `无法连接 Claude DevTools 端口 ${port}。请确认 Claude 是由本插件启动，且没有旧实例正在运行。${lastError ? `最后错误：${lastError.message}` : ""}`
  );
}

export async function listTargets(port) {
  return fetchJson(`http://127.0.0.1:${port}/json/list`, 2000);
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    if (typeof WebSocket === "undefined") {
      throw new Error("当前 Node.js 没有内置 WebSocket；请使用 Node.js 22 或更高版本。");
    }

    this.socket = new WebSocket(this.webSocketUrl);

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`无法打开 CDP WebSocket：${this.webSocketUrl}`));
      };
      this.socket.addEventListener("open", onOpen);
      this.socket.addEventListener("error", onError);
    });

    this.socket.addEventListener("message", (event) => {
      const payload = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const message = JSON.parse(payload);
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }

      const { resolve, reject, timeout } = this.pending.get(message.id);
      clearTimeout(timeout);
      this.pending.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, 2500);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(payload);
    });
  }

  close() {
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(new Error("CDP 连接已关闭"));
    }
    this.pending.clear();
    this.socket?.close();
  }
}

function isInjectableTarget(target) {
  if (!target.webSocketDebuggerUrl) {
    return false;
  }
  if (target.url?.startsWith("devtools://")) {
    return false;
  }
  return ["page", "webview", "iframe", "background_page"].includes(target.type);
}

export async function injectIntoTarget(target, source) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();

  try {
    await client.send("Runtime.enable").catch(() => {});
    await client.send("Page.enable").catch(() => {});
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source }).catch(() => {});
    await client.send("Runtime.evaluate", {
      expression: source,
      awaitPromise: false,
      returnByValue: false
    });
  } finally {
    client.close();
  }
}

export async function watchAndInject({ port, source, intervalMs, logger }) {
  const injectedTargets = new Set();

  while (true) {
    let targets = [];
    try {
      targets = await listTargets(port);
    } catch (error) {
      logger.warn(`暂时无法读取 CDP targets：${error.message}`);
      await delay(intervalMs);
      continue;
    }

    for (const target of targets.filter(isInjectableTarget)) {
      const key = target.id ?? `${target.type}:${target.url}`;
      if (injectedTargets.has(key)) {
        continue;
      }

      try {
        await injectIntoTarget(target, source);
        injectedTargets.add(key);
        logger.info(`已注入：${target.type} ${target.title || target.url || key}`);
      } catch (error) {
        logger.warn(`注入失败：${target.title || target.url || key} - ${error.message}`);
      }
    }

    await delay(intervalMs);
  }
}

