/* ==========================================================================
   bridge.js — thin wrapper over the WebView2 postMessage transport.
   Exposes: ByteSize.invoke(type, payload) -> Promise, ByteSize.on(fn), ByteSize.hosted
   ========================================================================== */
(() => {
  "use strict";

  // On Android the host injects a ByteSizeNative JavaScript interface instead of
  // WebView2's chrome.webview. Adapt it to the same postMessage transport so the
  // rest of the shell (and every app) works unchanged on both platforms.
  function androidTransport() {
    const native = window.ByteSizeNative;
    if (!native || typeof native.post !== "function") {
      return null;
    }
    const handlers = new Set();
    window.__bytesizeDeliver = (payload) => {
      let message;
      if (typeof payload === "string") {
        try { message = JSON.parse(payload); } catch (e) { return; }
      } else {
        message = payload;
      }
      handlers.forEach((fn) => {
        try { fn({ data: message }); } catch (error) { console.error("bridge listener failed", error); }
      });
    };
    return {
      postMessage: (message) => { native.post(JSON.stringify(message)); },
      addEventListener: (type, fn) => { if (type === "message") handlers.add(fn); },
      removeEventListener: (type, fn) => { if (type === "message") handlers.delete(fn); },
    };
  }

  const transport = window.chrome && window.chrome.webview
    ? window.chrome.webview
    : androidTransport();
  const pending = new Map();
  const listeners = new Set();
  const TIMEOUT_MS = 15000;
  let seq = 0;

  function invoke(type, payload, timeoutMs) {
    if (!transport) {
      return Promise.reject(new Error("Native bridge unavailable outside the ByteSize OS host."));
    }

    const id = `c${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      transport.postMessage({ id, type, payload: payload ?? null });
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`Bridge timeout for "${type}".`));
        }
      }, timeoutMs || TIMEOUT_MS);
    });
  }

  if (transport) {
    transport.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) {
          resolve(message.data);
        } else {
          reject(new Error(message.error || "Command failed."));
        }
        return;
      }

      if (message.type) {
        listeners.forEach((fn) => {
          try {
            fn(message.type, message.payload);
          } catch (error) {
            console.error("bridge listener failed", error);
          }
        });
      }
    });
  }

  window.ByteSize = {
    hosted: Boolean(transport),
    invoke,
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();