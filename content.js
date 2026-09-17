/**
 * Content script — DOM-only page operations.
 * Receives commands from the background service worker via chrome.runtime messaging.
 */

(function () {
  if (window.__edge_nm_content_loaded) {
    return;
  }
  window.__edge_nm_content_loaded = true;

  function ok(result) {
    return { ok: true, result };
  }

  function err(code, message) {
    return { ok: false, error: { code, message } };
  }

  function qs(selector, root) {
    const el = (root || document).querySelector(selector);
    if (!el) {
      const e = new Error(`Selector not found: ${selector}`);
      e.code = "SELECTOR_NOT_FOUND";
      throw e;
    }
    return el;
  }

  function waitForSelector(selector, timeoutMs, root) {
    const timeout = timeoutMs == null ? 10000 : Number(timeoutMs);
    const scope = root || document;
    return new Promise((resolve, reject) => {
      const existing = scope.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }
      const observer = new MutationObserver(() => {
        const el = scope.querySelector(selector);
        if (el) {
          cleanup();
          resolve(el);
        }
      });
      const timer = setTimeout(() => {
        cleanup();
        const e = new Error(`Timeout waiting for selector: ${selector} (${timeout}ms)`);
        e.code = "SELECTOR_TIMEOUT";
        reject(e);
      }, timeout);

      function cleanup() {
        clearTimeout(timer);
        observer.disconnect();
      }

      observer.observe(scope.documentElement || scope, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    });
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function handle(action, params) {
    params = params || {};
    switch (action) {
      case "dom.click": {
        const el = params.wait
          ? await waitForSelector(params.selector, params.timeout_ms)
          : qs(params.selector);
        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return { clicked: true, selector: params.selector };
      }

      case "dom.type": {
        const el = params.wait
          ? await waitForSelector(params.selector, params.timeout_ms)
          : qs(params.selector);
        el.focus();
        if (params.clear !== false) {
          setNativeValue(el, "");
        }
        const text = params.text == null ? "" : String(params.text);
        if (params.as_keys) {
          for (const ch of text) {
            el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
            setNativeValue(el, (el.value || "") + ch);
            el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
          }
        } else {
          const base = params.clear === false ? (el.value || "") : "";
          setNativeValue(el, base + text);
        }
        return { typed: true, length: text.length, selector: params.selector };
      }

      case "dom.wait": {
        const el = await waitForSelector(params.selector, params.timeout_ms);
        return {
          found: true,
          selector: params.selector,
          tag: el.tagName.toLowerCase(),
        };
      }

      case "dom.exists": {
        const el = document.querySelector(params.selector);
        return { exists: !!el, selector: params.selector };
      }

      case "dom.get_text": {
        const el = qs(params.selector);
        const text = (el.innerText != null ? el.innerText : el.textContent || "").trim();
        return { text, selector: params.selector };
      }

      case "dom.get_value": {
        const el = qs(params.selector);
        return { value: el.value != null ? el.value : null, selector: params.selector };
      }

      case "dom.set_value": {
        const el = qs(params.selector);
        setNativeValue(el, params.value == null ? "" : String(params.value));
        return { set: true, selector: params.selector };
      }

      case "dom.select": {
        const el = qs(params.selector);
        if (!(el instanceof HTMLSelectElement)) {
          return err("INVALID_PARAMS", "dom.select requires a <select> element");
        }
        if (params.value != null) {
          el.value = String(params.value);
        } else if (params.index != null) {
          el.selectedIndex = Number(params.index);
        } else if (params.label != null) {
          const opt = Array.from(el.options).find((o) => o.text === params.label);
          if (!opt) {
            return err("SELECTOR_NOT_FOUND", `No option with label: ${params.label}`);
          }
          el.value = opt.value;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { selected: el.value, selector: params.selector };
      }

      case "dom.query": {
        const nodes = Array.from(document.querySelectorAll(params.selector));
        const limit = params.limit == null ? 20 : Number(params.limit);
        return {
          count: nodes.length,
          elements: nodes.slice(0, limit).map((el, i) => ({
            index: i,
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            text: ((el.innerText || el.textContent || "").trim()).slice(0, 200),
            href: el.href || null,
          })),
        };
      }

      case "dom.scroll": {
        if (params.selector) {
          const el = qs(params.selector);
          el.scrollIntoView({
            block: params.block || "center",
            inline: params.inline || "nearest",
          });
          return { scrolled: "element", selector: params.selector };
        }
        const x = params.x != null ? Number(params.x) : window.scrollX;
        const y = params.y != null ? Number(params.y) : window.scrollY;
        window.scrollTo(x, y);
        return { scrolled: "window", x, y };
      }

      case "dom.eval": {
        return err(
          "INVALID_ACTION",
          "dom.eval is blocked by extension CSP (no unsafe-eval). Use dom.click_each_paginate."
        );
      }

      case "dom.click_each": {
        const selector = params.selector;
        if (!selector) {
          return err("INVALID_PARAMS", "dom.click_each requires selector");
        }
        const interval = params.interval_ms == null ? 500 : Number(params.interval_ms);
        const nodes = Array.from(document.querySelectorAll(selector));
        for (let i = 0; i < nodes.length; i++) {
          nodes[i].scrollIntoView({ block: "center", inline: "center" });
          nodes[i].click();
          if (i < nodes.length - 1 && interval > 0) {
            await new Promise((r) => setTimeout(r, interval));
          }
        }
        return { clicked: nodes.length, selector, interval_ms: interval };
      }
case "dom.click_each_paginate": {
  const itemSelector = params.item_selector || params.selector;
  if (!itemSelector) {
    return err("INVALID_PARAMS", "dom.click_each_paginate requires item_selector");
  }
  const nextSelector = params.next_selector || ".page-link.next";
  const interval = params.interval_ms == null ? 500 : Number(params.interval_ms);
  const maxPages = params.max_pages == null ? 500 : Number(params.max_pages);
  const doScroll = params.scroll_bottom !== false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function canGoNext() {
    const el = document.querySelector(nextSelector);
    if (!el) return false;
    if (el.classList.contains("disabled")) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    if (el.hasAttribute("disabled")) return false;
    const li = el.closest("li");
    if (li && (li.classList.contains("disabled") || li.classList.contains("inactive"))) return false;
    const parent = el.parentElement;
    if (parent && parent.classList.contains("disabled")) return false;
    return true;
  }

  async function humanScrollToBottom() {
    const stepPx = Math.max(400, Math.floor(window.innerHeight * 0.7));
    let guard = 0;
    let lastTop = -1;
    while (guard < 80) {
      const maxScroll = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
      const top = window.scrollY || document.documentElement.scrollTop || 0;
      if (top + window.innerHeight >= maxScroll - 8) break;
      if (top === lastTop) break;
      lastTop = top;
      window.scrollBy({ top: stepPx, left: 0, behavior: "smooth" });
      await sleep(280 + Math.floor(Math.random() * 180));
      guard += 1;
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    await sleep(500);
    await sleep(300 + Math.floor(Math.random() * 400));
  }

  async function clickItemsOnPage() {
    if (doScroll) await humanScrollToBottom();
    const elements = Array.from(document.querySelectorAll(itemSelector));
    for (let i = 0; i < elements.length; i++) {
      elements[i].scrollIntoView({ block: "center", inline: "center" });
      await sleep(80);
      elements[i].click();
      if (i < elements.length - 1) await sleep(interval);
    }
    return elements.length;
  }

  async function waitItems(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (document.querySelectorAll(itemSelector).length > 0) {
        return document.querySelectorAll(itemSelector).length;
      }
      await sleep(300);
    }
    return document.querySelectorAll(itemSelector).length;
  }

  const summary = { pages: 0, clicks: 0, stopped_reason: "" };
  while (summary.pages < maxPages) {
    summary.pages += 1;
    await waitItems(15000);
    const n = await clickItemsOnPage();
    summary.clicks += n;

    if (!canGoNext()) {
      summary.stopped_reason = "next_unavailable";
      break;
    }

    const beforeHref = location.href;
    const beforeCount = document.querySelectorAll(itemSelector).length;
    const nxt = document.querySelector(nextSelector);
    if (nxt) {
      nxt.scrollIntoView({ block: "center", inline: "center" });
      await sleep(200);
      nxt.click();
    }

    let changed = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if (location.href !== beforeHref || document.querySelectorAll(itemSelector).length !== beforeCount) {
        changed = true;
        break;
      }
      if (!canGoNext() && i > 4) break;
    }
    window.scrollTo(0, 0);
    await sleep(800);
    if (!changed && !canGoNext()) {
      summary.stopped_reason = "next_click_no_change";
      break;
    }
  }
  if (!summary.stopped_reason) summary.stopped_reason = "max_pages";
  return summary;
}




      default:
        return err("INVALID_ACTION", `Content script cannot handle: ${action}`);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.action) {
      return false;
    }
    Promise.resolve()
      .then(() => handle(message.action, message.params))
      .then((result) => {
        // handle may return err() object already
        if (result && result.ok === false) {
          sendResponse(result);
        } else if (result && result.ok === true) {
          sendResponse(result);
        } else {
          sendResponse(ok(result));
        }
      })
      .catch((e) => {
        sendResponse(err(e.code || "CONTENT_SCRIPT_ERROR", e.message || String(e)));
      });
    return true; // async
  });
})();
