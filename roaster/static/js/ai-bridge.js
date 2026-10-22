(() => {
  // node_modules/@tauri-apps/api/external/tslib/tslib.es6.js
  function __classPrivateFieldGet(receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
  }
  function __classPrivateFieldSet(receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
  }

  // node_modules/@tauri-apps/api/core.js
  var _Channel_onmessage;
  var _Channel_nextMessageIndex;
  var _Channel_pendingMessages;
  var _Channel_messageEndIndex;
  var _Resource_rid;
  var SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";
  function transformCallback(callback, once = false) {
    return window.__TAURI_INTERNALS__.transformCallback(callback, once);
  }
  var Channel = class {
    constructor(onmessage) {
      _Channel_onmessage.set(this, void 0);
      _Channel_nextMessageIndex.set(this, 0);
      _Channel_pendingMessages.set(this, []);
      _Channel_messageEndIndex.set(this, void 0);
      __classPrivateFieldSet(this, _Channel_onmessage, onmessage || (() => {
      }), "f");
      this.id = transformCallback((rawMessage) => {
        const index = rawMessage.index;
        if ("end" in rawMessage) {
          if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
            this.cleanupCallback();
          } else {
            __classPrivateFieldSet(this, _Channel_messageEndIndex, index, "f");
          }
          return;
        }
        const message = rawMessage.message;
        if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
          __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message);
          __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
          while (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") in __classPrivateFieldGet(this, _Channel_pendingMessages, "f")) {
            const message2 = __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
            __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message2);
            delete __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
            __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
          }
          if (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") === __classPrivateFieldGet(this, _Channel_messageEndIndex, "f")) {
            this.cleanupCallback();
          }
        } else {
          __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[index] = message;
        }
      });
    }
    cleanupCallback() {
      window.__TAURI_INTERNALS__.unregisterCallback(this.id);
    }
    set onmessage(handler) {
      __classPrivateFieldSet(this, _Channel_onmessage, handler, "f");
    }
    get onmessage() {
      return __classPrivateFieldGet(this, _Channel_onmessage, "f");
    }
    [(_Channel_onmessage = /* @__PURE__ */ new WeakMap(), _Channel_nextMessageIndex = /* @__PURE__ */ new WeakMap(), _Channel_pendingMessages = /* @__PURE__ */ new WeakMap(), _Channel_messageEndIndex = /* @__PURE__ */ new WeakMap(), SERIALIZE_TO_IPC_FN)]() {
      return `__CHANNEL__:${this.id}`;
    }
    toJSON() {
      return this[SERIALIZE_TO_IPC_FN]();
    }
  };
  async function invoke(cmd, args = {}, options) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args, options);
  }
  _Resource_rid = /* @__PURE__ */ new WeakMap();

  // node_modules/@tauri-apps/api/event.js
  var TauriEvent;
  (function(TauriEvent2) {
    TauriEvent2["WINDOW_RESIZED"] = "tauri://resize";
    TauriEvent2["WINDOW_MOVED"] = "tauri://move";
    TauriEvent2["WINDOW_CLOSE_REQUESTED"] = "tauri://close-requested";
    TauriEvent2["WINDOW_DESTROYED"] = "tauri://destroyed";
    TauriEvent2["WINDOW_FOCUS"] = "tauri://focus";
    TauriEvent2["WINDOW_BLUR"] = "tauri://blur";
    TauriEvent2["WINDOW_SCALE_FACTOR_CHANGED"] = "tauri://scale-change";
    TauriEvent2["WINDOW_THEME_CHANGED"] = "tauri://theme-changed";
    TauriEvent2["WINDOW_CREATED"] = "tauri://window-created";
    TauriEvent2["WINDOW_SUSPENDED"] = "tauri://suspended";
    TauriEvent2["WINDOW_RESUMED"] = "tauri://resumed";
    TauriEvent2["WEBVIEW_CREATED"] = "tauri://webview-created";
    TauriEvent2["DRAG_ENTER"] = "tauri://drag-enter";
    TauriEvent2["DRAG_OVER"] = "tauri://drag-over";
    TauriEvent2["DRAG_DROP"] = "tauri://drag-drop";
    TauriEvent2["DRAG_LEAVE"] = "tauri://drag-leave";
  })(TauriEvent || (TauriEvent = {}));
  async function _unlisten(event, eventId) {
    window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId);
    await invoke("plugin:event|unlisten", {
      event,
      eventId
    });
  }
  async function listen(event, handler, options) {
    var _a;
    const target = typeof (options === null || options === void 0 ? void 0 : options.target) === "string" ? { kind: "AnyLabel", label: options.target } : (_a = options === null || options === void 0 ? void 0 : options.target) !== null && _a !== void 0 ? _a : { kind: "Any" };
    return invoke("plugin:event|listen", {
      event,
      target,
      handler: transformCallback(handler)
    }).then((eventId) => {
      return async () => _unlisten(event, eventId);
    });
  }

  // ai/bridge.mjs
  window.RoasterNativeAI = { invoke, listen };
  var native = !!window.__TAURI_INTERNALS__;
  var selected = { kind: native ? "local" : "backend", backend: location.origin };
  var socket = null;
  var reconnect = null;
  var disposed = false;
  var cursor = 0;
  var subscribers = /* @__PURE__ */ new Set();
  var emit = (event) => {
    for (const callback of subscribers) {
      try {
        callback(event);
      } catch {
      }
    }
  };
  var response = async (result) => {
    const value = await result.json();
    if (!result.ok) throw Error(typeof value.detail === "string" ? value.detail : "AI \u8BF7\u6C42\u5931\u8D25");
    return value;
  };
  var webRequest = (path, options = {}) => fetch("/api/v1/ai" + path, { credentials: "same-origin", ...options }).then(response);
  function connectWeb() {
    if (native || disposed || !subscribers.size || socket) return;
    const url = new URL("/api/v1/ai/ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("after", String(cursor));
    socket = new WebSocket(url);
    socket.onmessage = (message) => {
      let batch;
      try {
        batch = JSON.parse(message.data);
      } catch {
        return;
      }
      cursor = batch.cursor ?? cursor;
      if (batch.replay_required) emit({ id: "host", type: "replay_required", data: {} });
      for (const event of batch.events || []) emit(event);
    };
    socket.onclose = (event) => {
      socket = null;
      if (event.code === 4401) {
        emit({ id: "host", type: "pairing_required", data: { message: "AI \u914D\u5BF9\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u914D\u5BF9" } });
        return;
      }
      if (!disposed && subscribers.size) reconnect = setTimeout(connectWeb, 1500);
    };
  }
  var nativeUnlisten = null;
  if (native) listen("roaster-ai-service", (event) => emit(event.payload)).then((unlisten) => {
    nativeUnlisten = unlisten;
  });
  window.RoasterAITransport = {
    native,
    get host() {
      return { ...selected };
    },
    async setHost(value) {
      if (native) await invoke("ai_remote_stop");
      selected = { kind: value.kind, backend: value.backend || location.origin };
      cursor = 0;
      if (socket) {
        socket.onclose = null;
        socket.close();
        socket = null;
      }
      clearTimeout(reconnect);
      connectWeb();
    },
    request(method, params = {}) {
      if (native) return selected.kind === "local" ? invoke("ai_rpc", { method, params }) : invoke("ai_remote_rpc", { backend: selected.backend, method, params });
      return webRequest("/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, params }) });
    },
    listen(callback) {
      subscribers.add(callback);
      connectWeb();
      return () => {
        subscribers.delete(callback);
        if (!subscribers.size && socket) {
          socket.onclose = null;
          socket.close();
          socket = null;
        }
      };
    },
    status() {
      return native ? selected.kind === "local" ? Promise.resolve({ available: true, paired: true, host: "local" }) : invoke("ai_remote_status", { backend: selected.backend }) : webRequest("/status");
    },
    async pair(code, name) {
      const result = native ? await invoke("ai_remote_pair", { backend: selected.backend, code, name }) : await webRequest("/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name }) });
      connectWeb();
      return result;
    },
    clients() {
      return native ? invoke("ai_remote_clients", { backend: selected.backend }) : webRequest("/clients");
    },
    revoke(id) {
      return native ? invoke("ai_remote_revoke", { backend: selected.backend, id }) : webRequest("/clients/" + encodeURIComponent(id), { method: "DELETE" });
    },
    dispose() {
      disposed = true;
      clearTimeout(reconnect);
      socket?.close();
      nativeUnlisten?.();
      subscribers.clear();
    }
  };
})();
