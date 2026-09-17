/**
 * Background service worker.
 * Maintains Native Messaging port to the Python host and routes commands by tabId.
 */

const HOST_NAME = "com.example.edge_nm";
const RECONNECT_MS = 2000;

let port = null;
let reconnectTimer = null;
let hostReady = false;
let lastDisconnect = null;
let connectAttempt = 0;
let lastHostMessageAt = null;

function log(...args) {
  console.log("[edge_nm]", ...args);
}

function connectNative() {
  if (port) {
    try {
      port.disconnect();
    } catch (_) {
      /* ignore */
    }
    port = null;
  }
  connectAttempt += 1;
  log("connectNative attempt", connectAttempt, "host=", HOST_NAME, "extensionId=", chrome.runtime.id);
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    lastDisconnect = {
      at: new Date().toISOString(),
      message: String(err),
      attempt: connectAttempt,
      phase: "connectNative_throw",
    };
    log("connectNative failed:", err);
    scheduleReconnect();
    return;
  }

  hostReady = false;
  lastHostMessageAt = null;
  log("Native Messaging port opened (attempt", connectAttempt + ")");

  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    const message = (err && err.message) || "(no lastError message)";
    lastDisconnect = {
      at: new Date().toISOString(),
      message,
      attempt: connectAttempt,
      hostReadyBefore: hostReady,
      lastHostMessageAt,
      hint:
        "Host stderr is not shown here. Check %LOCALAPPDATA%\\edge_nm\\host.log and launcher.log",
    };
    log("Native port disconnected:", message);
    log("Disconnect detail:", JSON.stringify(lastDisconnect));
    port = null;
    hostReady = false;
    scheduleReconnect();
  });

  // Handshake so the host marks the bridge connected
  postToHost({
    id: cryptoRandomId(),
    action: "hello",
    params: { extension: "edge_nm", version: "0.1.0" },
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, RECONNECT_MS);
}

function postToHost(message) {
  if (!port) {
    log("Cannot post — no native port");
    return false;
  }
  try {
    port.postMessage(message);
    return true;
  } catch (err) {
    log("postMessage failed:", err);
    return false;
  }
}

function cryptoRandomId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function onHostMessage(message) {
  lastHostMessageAt = new Date().toISOString();
  log("host message:", JSON.stringify(message).slice(0, 500));
  // Host readiness announcement (no reply needed beyond logging)
  if (message && message.action === "host.ready") {
    hostReady = true;
    log("Host ready on control port", message.params && message.params.control_port);
    return;
  }

  // Reply to hello/ping handled by host; if host echoes success, mark ready
  if (message && message.ok === true && message.result && message.result.host === "edge_nm") {
    hostReady = true;
    return;
  }

  // Command from host (forwarded from CLI)
  if (!message || !message.action || message.ok !== undefined) {
    return;
  }

  const reqId = message.id || cryptoRandomId();
  try {
    const result = await dispatch(message.action, message.params || {});
    postToHost({ id: reqId, ok: true, result });
  } catch (err) {
    const code = err.code || "INTERNAL_ERROR";
    const msg = err.message || String(err);
    postToHost({
      id: reqId,
      ok: false,
      error: { code, message: msg },
    });
  }
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function ensureTab(tabId) {
  if (tabId === undefined || tabId === null) {
    throw fail("INVALID_PARAMS", "Missing required param: tabId");
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    throw fail("TAB_NOT_FOUND", `No tab with tabId=${tabId}`);
  }
}

async function sendToContent(tabId, payload) {
  await ensureTab(tabId);
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (err) {
    // Content script may not be injected yet (e.g. chrome:// pages fail; others need inject)
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
    } catch (injectErr) {
      throw fail(
        "CONTENT_SCRIPT_ERROR",
        `Cannot inject content script into tab ${tabId}: ${injectErr.message || injectErr}. ` +
          "Restricted pages (edge://, chrome://, Web Store) cannot be automated via DOM.",
      );
    }
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (err2) {
      throw fail(
        "CONTENT_SCRIPT_ERROR",
        `Content script not responding in tab ${tabId}: ${err2.message || err2}`,
      );
    }
  }
}

async function dispatch(action, params) {
  switch (action) {
    case "ping":
    case "hello":
      return { pong: true, hostReady, extensionId: chrome.runtime.id };

    case "tabs.list": {
      const query = params.query || {};
      const tabs = await chrome.tabs.query(query);
      return {
        tabs: tabs.map((t) => ({
          tabId: t.id,
          windowId: t.windowId,
          url: t.url,
          title: t.title,
          active: t.active,
          status: t.status,
        })),
      };
    }

    case "tab.get": {
      const tab = await ensureTab(params.tabId);
      return {
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        status: tab.status,
      };
    }

    case "tab.focus": {
      const tab = await ensureTab(params.tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      return { tabId: tab.id, focused: true };
    }

    case "tab.create": {
      const createProps = { url: params.url || "about:blank", active: params.active !== false };
      const tab = await chrome.tabs.create(createProps);
      if (params.wait_complete) {
        await waitTabComplete(tab.id, params.timeout_ms || 30000);
      }
      return { tabId: tab.id, url: tab.url, windowId: tab.windowId };
    }

    case "tab.close": {
      await ensureTab(params.tabId);
      await chrome.tabs.remove(params.tabId);
      return { closed: true, tabId: params.tabId };
    }

    case "navigate": {
      const tab = await ensureTab(params.tabId);
      await chrome.tabs.update(tab.id, { url: params.url });
      if (params.wait_complete !== false) {
        await waitTabComplete(tab.id, params.timeout_ms || 30000);
      }
      const updated = await chrome.tabs.get(tab.id);
      return { tabId: tab.id, url: updated.url, status: updated.status };
    }

    case "dom.click":
    case "dom.type":
    case "dom.wait":
    case "dom.get_text":
    case "dom.query":
    case "dom.scroll":
    case "dom.exists":
    case "dom.get_value":
    case "dom.set_value":
    case "dom.select":
    case "dom.eval":
    case "dom.click_each":
    case "dom.click_each_paginate": {
      const response = await sendToContent(params.tabId, { action, params });
      if (!response) {
        throw fail("CONTENT_SCRIPT_ERROR", "Empty response from content script");
      }
      if (response.ok === false) {
        throw fail(response.error?.code || "CONTENT_SCRIPT_ERROR", response.error?.message || "DOM action failed");
      }
      return response.result;
    }

    default:
      throw fail("INVALID_ACTION", `Unknown action: ${action}`);
  }
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    function cleanup() {
      chrome.tabs.onUpdated.removeListener(listener);
    }

    function listener(updatedId, changeInfo) {
      if (updatedId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        cleanup();
        resolve();
      }
    }).catch((err) => {
      cleanup();
      reject(fail("TAB_NOT_FOUND", err.message || String(err)));
    });

    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        cleanup();
        reject(fail("TIMEOUT", `Tab ${tabId} did not reach complete within ${timeoutMs}ms`));
      }
    }, 200);
  });
}

// Popup / external ping
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "status") {
    sendResponse({
      connected: !!port,
      hostReady,
      extensionId: chrome.runtime.id,
      hostName: HOST_NAME,
      connectAttempt,
      lastDisconnect,
      lastHostMessageAt,
      logHint: "%LOCALAPPDATA%\\edge_nm\\host.log",
    });
    return true;
  }
  return false;
});

connectNative();
log("Service worker started, extensionId=", chrome.runtime.id);
