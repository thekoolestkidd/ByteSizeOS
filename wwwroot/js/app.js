/* ==========================================================================
   ByteSize OS — frontend (Family A)
   Window manager + dock + taskbar + start menu + built-in apps.
   Talks to the C# backend through ByteSize.invoke (see bridge.js).
   ========================================================================== */
(() => {
  "use strict";

  const { invoke } = ByteSize;

  /* ======================================================================
     Utilities
     ====================================================================== */
  const $ = (selector, root = document) => root.querySelector(selector);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  function fmtBytes(bytes) {
    if (!bytes || bytes < 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }

  const baseName = (path) => String(path ?? "").split(/[\\/]/).filter(Boolean).pop() || path || "";
  const extName = (name) => {
    const clean = baseName(name).toLowerCase();
    const dot = clean.lastIndexOf(".");
    return dot > 0 ? clean.slice(dot + 1) : "";
  };
  const joinPath = (dir, name) => `${String(dir || "/").replace(/\/+$/, "")}/${name}`;

  const TEXT_EXT = new Set([
    "txt", "md", "markdown", "json", "js", "mjs", "cjs", "css", "html", "htm", "xml",
    "csv", "tsv", "log", "ini", "cfg", "conf", "yaml", "yml", "cs", "vb", "c", "cpp",
    "h", "hpp", "java", "py", "rb", "go", "rs", "sh", "bat", "cmd", "ps1", "sql",
    "toml", "rst", "tex", "gitignore", "env", "props", "targets", "editorconfig",
  ]);

  const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

  const uid = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /* ======================================================================
     Persistence — per-system settings
     ---------------------------------------------------------------------
     Settings live in a single JSON document at /System/settings.json
     *inside the sandbox*, so two copies of ByteSize OS on the same computer
     keep completely independent settings. localStorage is only used as a
     fallback when the native host (and therefore the bridge) is unavailable,
     e.g. the headless preview, and as a one-time migration source.
     ====================================================================== */
  const STORE_KEYS = ["wallpaper", "font", "labels", "windowStyle", "theme", "dock", "customApps", "snakeBest", "tetrisBest", "studioLanguage", "studioCode", "zoom", "phoneHintSeen"];
  const Store = (() => {
    let data = {};
    let loaded = false;
    let saveTimer = null;

    function readLegacy() {
      const out = {};
      for (const key of STORE_KEYS) {
        try {
          const raw = localStorage.getItem(`bytesize.${key}`);
          if (raw != null) out[key] = JSON.parse(raw);
        } catch { /* ignore */ }
      }
      return out;
    }

    function writeLegacy() {
      for (const key of STORE_KEYS) {
        try {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            localStorage.setItem(`bytesize.${key}`, JSON.stringify(data[key]));
          } else {
            localStorage.removeItem(`bytesize.${key}`);
          }
        } catch { /* ignore */ }
      }
    }

    function scheduleSave() {
      if (!ByteSize.hosted) {
        writeLegacy();
        return;
      }
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          await invoke("settings.write", { content: JSON.stringify(data) });
        } catch (error) {
          console.error("Could not save settings:", error);
        }
      }, 250);
    }

    return {
      async load() {
        if (loaded) return;
        loaded = true;

        if (!ByteSize.hosted) {
          data = readLegacy();
          return;
        }

        try {
          const result = await invoke("settings.read");
          if (result && result.exists && result.content) {
            data = JSON.parse(result.content) || {};
          } else {
            // First run on this system: carry over any settings from the old
            // shared localStorage location, then persist them under /System.
            data = readLegacy();
            if (Object.keys(data).length) scheduleSave();
          }
        } catch (error) {
          console.error("Could not load settings:", error);
          data = readLegacy();
        }
      },
      get(key, fallback) {
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
      },
      set(key, value) {
        data[key] = value;
        scheduleSave();
      },
      remove(key) {
        delete data[key];
        scheduleSave();
      },
      flush() {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        if (!ByteSize.hosted) {
          writeLegacy();
          return;
        }
        try {
          invoke("settings.write", { content: JSON.stringify(data) });
        } catch { /* shutting down */ }
      },
    };
  })();

  /* ======================================================================
     Toasts
     ====================================================================== */
  const Toast = {
    show(message, kind = "info", timeout = 3400) {
      const host = $("#toasts");
      const node = el("div", `toast toast--${kind}`, message);
      host.appendChild(node);
      setTimeout(() => {
        node.style.transition = "opacity .25s ease";
        node.style.opacity = "0";
        setTimeout(() => node.remove(), 250);
      }, timeout);
    },
  };

  /* ======================================================================
     Modals (stackable) — used by prompts and the in-app file dialog
     ====================================================================== */
  const modalHost = $("#modal-host");
  let modalCount = 0;

  function openModal({ title, accent = "#4cc2ff", body }) {
    modalHost.hidden = false;
    modalCount += 1;

    const layer = el("div");
    layer.style.cssText = "position:absolute;inset:0;";

    const backdrop = el("div", "modal-backdrop");
    const modal = el("div", "modal");
    modal.style.setProperty("--modal-accent", accent);

    const bar = el("div", "modal__bar", title);
    const bodyEl = el("div", "modal__body");
    if (typeof body === "string") bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);

    const foot = el("div", "modal__foot");
    modal.append(bar, bodyEl, foot);
    layer.append(backdrop, modal);
    modalHost.appendChild(layer);

    const close = () => {
      layer.remove();
      modalCount = Math.max(0, modalCount - 1);
      if (modalCount === 0) modalHost.hidden = true;
    };

    return { modal, bodyEl, foot, close };
  }

  const Dialog = {
    prompt(title, value = "") {
      return new Promise((resolve) => {
        const wrap = el("div", "col");
        wrap.innerHTML = `<input class="field" />`;
        const input = wrap.querySelector("input");
        input.value = value;

        const { foot, close } = openModal({ title, accent: "#ffd000", body: wrap });
        const cancel = el("button", "btn", "Cancel");
        const ok = el("button", "btn btn--primary", "OK");

        cancel.onclick = () => { close(); resolve(null); };
        ok.onclick = () => { const v = input.value.trim(); close(); resolve(v || null); };
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") ok.click();
          else if (event.key === "Escape") cancel.click();
        });

        foot.append(cancel, ok);
        setTimeout(() => { input.focus(); input.select(); }, 30);
      });
    },
  };

  /* ======================================================================
     In-app file dialog (open / save) — backed by fs.list on the bridge
     ====================================================================== */
  const FileDialog = {
    show({ mode = "open", title = "Open", defaultName = "", startPath = null } = {}) {
      return new Promise((resolve) => {
        let cwd = null;
        const wrap = el("div", "col");
        wrap.innerHTML = `
          <div class="toolbar">
            <button class="btn" data-act="up" title="Up one level">⬆</button>
            <button class="btn" data-act="home" title="Home">🏠</button>
            <button class="btn" data-act="new" title="New folder">📁 New</button>
            <span class="spacer"></span>
            <span class="chip" data-count>—</span>
          </div>
          <div class="crumbs" data-crumbs></div>
          <div class="filelist" data-list style="max-height:230px;overflow:auto;border:3px solid var(--ink);border-radius:10px;padding:6px;background:#f4f8ff"></div>
          <div class="row"><span style="font-weight:700;white-space:nowrap">File name:</span><input class="field" data-name /></div>`;

        const nameInput = wrap.querySelector("[data-name]");
        nameInput.value = defaultName;
        const listEl = wrap.querySelector("[data-list]");
        const crumbsEl = wrap.querySelector("[data-crumbs]");
        const countEl = wrap.querySelector("[data-count]");

        const { foot, close } = openModal({
          title,
          accent: mode === "save" ? "#ff9f43" : "#4cc2ff",
          body: wrap,
        });

        const cancel = el("button", "btn", "Cancel");
        cancel.onclick = () => { close(); resolve(null); };

        const confirm = el("button", "btn btn--primary", mode === "save" ? "💾 Save" : "📂 Open");
        const doConfirm = () => {
          const name = nameInput.value.trim();
          if (!name) { Toast.show("Type a file name first.", "error"); return; }
          close();
          resolve(joinPath(cwd, name));
        };
        confirm.onclick = doConfirm;
        nameInput.addEventListener("keydown", (event) => { if (event.key === "Enter") doConfirm(); });
        foot.append(cancel, confirm);

        function renderCrumbs(path) {
          const parts = String(path).split("/").filter(Boolean);
          let acc = "";
          const crumbs = parts.map((part) => {
            acc = `${acc}/${part}`;
            return `<button data-path="${esc(acc)}">${esc(part)}</button>`;
          }).join('<span class="crumbs__sep">›</span>');
          crumbsEl.innerHTML = `<button data-path="">🏠 Home</button>` +
            (crumbs ? `<span class="crumbs__sep">›</span>${crumbs}` : "");
          crumbsEl.querySelectorAll("button").forEach((button) => {
            button.onclick = () => navigate(button.dataset.path || null);
          });
        }

        async function navigate(path) {
          try {
            const listing = await invoke("fs.list", { path });
            cwd = listing.path;
            renderCrumbs(listing.path);
            countEl.textContent = `${listing.count} items`;
            listEl.innerHTML = listing.entries.map((entry) => `
              <button class="file" data-path="${esc(entry.path)}" data-dir="${entry.isDirectory}">
                <span class="file__glyph">${entry.isDirectory ? "📁" : "📄"}</span>
                <span class="file__name">${esc(entry.name)}</span>
                <span class="file__size">${entry.isDirectory ? "" : fmtBytes(entry.size)}</span>
              </button>`).join("") || '<div class="muted">Empty folder.</div>';

            listEl.querySelectorAll(".file").forEach((row) => {
              row.onclick = () => {
                listEl.querySelectorAll(".file--selected").forEach((r) => r.classList.remove("file--selected"));
                row.classList.add("file--selected");
                if (row.dataset.dir !== "true") nameInput.value = baseName(row.dataset.path);
              };
              row.ondblclick = () => {
                if (row.dataset.dir === "true") navigate(row.dataset.path);
                else { nameInput.value = baseName(row.dataset.path); doConfirm(); }
              };
            });
          } catch (error) {
            listEl.innerHTML = `<div class="muted">${esc(error.message)}</div>`;
          }
        }

        wrap.querySelector('[data-act="up"]').onclick = () => {
          const parent = cwd && cwd !== "/" ? (cwd.replace(/\/[^/]*$/, "") || "/") : "/";
          navigate(parent);
        };
        wrap.querySelector('[data-act="home"]').onclick = () => navigate(null);
        wrap.querySelector('[data-act="new"]').onclick = async () => {
          const name = await Dialog.prompt("New folder name", "New Folder");
          if (!name) return;
          try {
            await invoke("fs.mkdir", { path: joinPath(cwd, name) });
            Toast.show(`Created "${name}"`, "good");
            navigate(cwd);
          } catch (error) {
            Toast.show(error.message, "error");
          }
        };

        navigate(startPath);
      });
    },
  };

  /* ======================================================================
     Window Manager
     ====================================================================== */
  const WM = (() => {
    const layer = $("#windows");
    const taskbarItems = $("#taskbar-items");
    const registry = new Map();
    let zCounter = 100;
    let cascade = 0;

    function syncTasks() {
      registry.forEach((rec) => {
        const active = !rec.minimized && rec.el.classList.contains("window--focused");
        rec.task.classList.toggle("task-button--active", active);
      });
    }

    function focus(rec) {
      registry.forEach((r) => r.el.classList.remove("window--focused"));
      rec.el.classList.add("window--focused");
      rec.el.style.zIndex = String(++zCounter);
      syncTasks();
    }

    function minimize(rec) {
      rec.minimized = true;
      rec.el.style.display = "none";
      syncTasks();
    }

    function restore(rec) {
      rec.minimized = false;
      rec.el.style.display = "";
      focus(rec);
    }

    function closeWindow(rec) {
      rec.el.remove();
      rec.task.remove();
      registry.delete(rec.key);
      try { rec.onClose?.(); } catch (error) { console.error(error); }
      syncTasks();
    }

    function toggleMaximize(rec) {
      if (rec.maximized) {
        Object.assign(rec.el.style, rec.prev);
        rec.el.classList.remove("window--maximized");
        rec.maximized = false;
        return;
      }
      rec.prev = {
        left: rec.el.style.left, top: rec.el.style.top,
        width: rec.el.style.width, height: rec.el.style.height,
      };
      Object.assign(rec.el.style, { left: "0px", top: "0px", width: "100%", height: "100%" });
      rec.el.classList.add("window--maximized");
      rec.maximized = true;
    }

    function enableDrag(rec) {
      const bar = rec.el.querySelector(".window__bar");
      bar.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest(".notches") || rec.maximized) return;
        focus(rec);
        bar.setPointerCapture(event.pointerId);
        const startX = event.clientX, startY = event.clientY;
        const startLeft = rec.el.offsetLeft, startTop = rec.el.offsetTop;
        let frame = 0;
        const move = (e) => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            const maxLeft = layer.clientWidth - rec.el.offsetWidth;
            const maxTop = layer.clientHeight - 46;
            rec.el.style.left = `${Math.min(Math.max(0, startLeft + e.clientX - startX), Math.max(0, maxLeft))}px`;
            rec.el.style.top = `${Math.min(Math.max(0, startTop + e.clientY - startY), Math.max(0, maxTop))}px`;
          });
        };
        const up = () => {
          cancelAnimationFrame(frame);
          bar.removeEventListener("pointermove", move);
          bar.removeEventListener("pointerup", up);
          bar.removeEventListener("pointercancel", up);
        };
        bar.addEventListener("pointermove", move);
        bar.addEventListener("pointerup", up);
        bar.addEventListener("pointercancel", up);
      });
    }

    function enableResize(rec) {
      const handle = rec.el.querySelector(".window__resize");
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || rec.maximized) return;
        event.stopPropagation();
        handle.setPointerCapture(event.pointerId);
        const startX = event.clientX, startY = event.clientY;
        const startW = rec.el.offsetWidth, startH = rec.el.offsetHeight;
        let frame = 0;
        const move = (e) => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            rec.el.style.width = `${Math.max(340, startW + e.clientX - startX)}px`;
            rec.el.style.height = `${Math.max(220, startH + e.clientY - startY)}px`;
          });
        };
        const up = () => {
          cancelAnimationFrame(frame);
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      });
    }

    // Apps may refuse to change size: `resizable: false` hides the resize grip
    // and the Maximize button. `api.setResizable(v)` flips it at runtime.
    function applyResizable(rec, on) {
      rec.resizable = on;
      rec.el.classList.toggle("window--fixed", !on);
      const max = rec.el.querySelector(".notch--max");
      if (max) max.style.display = on ? "" : "none";
      if (on && !rec.resizeWired) { enableResize(rec); rec.resizeWired = true; }
    }

    function open(spec) {
      if (spec.id && registry.has(spec.id)) {
        const existing = registry.get(spec.id);
        restore(existing);
        existing.api.onReopen?.(spec);
        return existing.api;
      }

      const width = spec.width || 760;
      const height = spec.height || 500;
      const step = (cascade++ % 6) * 26;
      const left = Math.max(10, Math.round((layer.clientWidth - width) / 2) + step - 60);
      const top = Math.max(10, Math.round((layer.clientHeight - height) / 2) + step - 60);

      const node = el("div", "window");
      node.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
      if (spec.accent) node.style.setProperty("--app-accent", spec.accent);
      node.innerHTML = `
        <header class="window__bar">
          <span class="window__icon"></span>
          <span class="window__title"></span>
          <div class="notches">
            <button class="notch notch--min" title="Minimize">−</button>
            <button class="notch notch--max" title="Maximize">□</button>
            <button class="notch notch--close" title="Close">✕</button>
          </div>
        </header>
        <div class="window__body"></div>
        <div class="window__resize"></div>`;

      const task = el("button", "task-button");
      if (spec.accent) task.style.setProperty("--task-accent", spec.accent);
      if (spec.icon && spec.icon.startsWith("data:")) {
        task.innerHTML = `<img src="${spec.icon}" style="vertical-align:middle;margin-right:4px"> ${spec.title || "Window"}`.trim();
      } else {
        task.textContent = `${spec.icon || ""} ${spec.title || "Window"}`.trim();
      }
      layer.appendChild(node);
      taskbarItems.appendChild(task);

      const rec = {
        key: spec.id || uid(),
        el: node, task,
        minimized: false, maximized: false, prev: null,
        resizable: spec.resizable !== false, resizeWired: false,
        onClose: spec.onClose,
      };

      const body = node.querySelector(".window__body");
      const api = {
        el: node,
        body,
        invoke,
        focus: () => focus(rec),
        close: () => closeWindow(rec),
        onClose: (fn) => { rec.onClose = fn; },
        onReopen: null,
        setResizable(value) { applyResizable(rec, value !== false); },
        setTitle(title) {
          node.querySelector(".window__title").textContent = title;
          if (spec.icon && spec.icon.startsWith("data:")) {
            task.innerHTML = `<img src="${spec.icon}" style="vertical-align:middle;margin-right:4px"> ${title}`.trim();
          } else {
            task.textContent = `${spec.icon || ""} ${title}`.trim();
          }
        },
      };
      rec.api = api;

      node.querySelector(".window__icon").innerHTML = spec.icon || "";
      node.querySelector(".window__title").textContent = spec.title || "Window";

      node.querySelector(".notch--min").onclick = () => minimize(rec);
      node.querySelector(".notch--max").onclick = () => { if (rec.resizable) toggleMaximize(rec); };
      node.querySelector(".notch--close").onclick = () => closeWindow(rec);
      task.onclick = () => {
        if (rec.minimized) restore(rec);
        else if (node.classList.contains("window--focused")) minimize(rec);
        else focus(rec);
      };
      node.addEventListener("pointerdown", () => focus(rec));

      enableDrag(rec);
      applyResizable(rec, rec.resizable);
      registry.set(rec.key, rec);

      if (typeof spec.render === "function") spec.render(body, api);
      restore(rec);
      return api;
    }

    return { open, close: (id) => { const rec = registry.get(id); if (rec) closeWindow(rec); } };
  })();

  /* ======================================================================
     Applications
     ====================================================================== */
  const Content = {};

  /* ---- File Manager ------------------------------------------------------ */
  Content.fileManager = {
    id: "files", title: "File Manager", icon: "📁", accent: "#4cc2ff",
    description: "Browse your machine",
    open(startPath) {
      WM.open({
        id: "files", title: "File Manager", icon: "📁", accent: "#4cc2ff",
        width: 820, height: 560,
        render(body, api) {
          body.innerHTML = `
            <div class="toolbar">
              <button class="btn" data-act="up">⬆ Up</button>
              <button class="btn" data-act="home">🏠 Home</button>
              <button class="btn" data-act="new">📁 New Folder</button>
              <button class="btn" data-act="refresh">🔄</button>
              <span class="spacer"></span>
              <span class="chip" data-count>—</span>
            </div>
            <div class="crumbs" data-crumbs></div>
            <div class="filelist" data-list></div>`;

          let cwd = startPath || null;
          const listEl = body.querySelector("[data-list]");
          const crumbsEl = body.querySelector("[data-crumbs]");
          const countEl = body.querySelector("[data-count]");

          function renderCrumbs(path) {
            const parts = String(path).split("/").filter(Boolean);
            let acc = "";
            const crumbs = parts.map((part) => {
              acc = `${acc}/${part}`;
              return `<button data-path="${esc(acc)}">${esc(part)}</button>`;
            }).join('<span class="crumbs__sep">›</span>');
            crumbsEl.innerHTML = `<button data-path="">🏠 Home</button>` +
              (crumbs ? `<span class="crumbs__sep">›</span>${crumbs}` : "");
            crumbsEl.querySelectorAll("button").forEach((button) => {
              button.onclick = () => navigate(button.dataset.path || null);
            });
          }

          function openEntry(path, isDirectory) {
            if (isDirectory) { navigate(path); return; }
            if (TEXT_EXT.has(extName(path))) {
              Content.notepad.open({ path });
            } else if (IMAGE_EXT.has(extName(path))) {
              Content.paint.open({ path });
            } else {
              Toast.show(`${baseName(path)} can't be opened inside ByteSize OS.`, "info");
            }
          }

          async function navigate(path) {
            try {
              const listing = await invoke("fs.list", { path });
              cwd = listing.path;
              api.setTitle(`File Manager — ${baseName(listing.path) || listing.path}`);
              countEl.textContent = `${listing.count} items`;
              renderCrumbs(listing.path);
              listEl.innerHTML = listing.entries.map((entry) => `
                <button class="file" data-path="${esc(entry.path)}" data-dir="${entry.isDirectory}">
                  <span class="file__glyph">${entry.isDirectory ? "📁" : "📄"}</span>
                  <span class="file__name">${esc(entry.name)}</span>
                  <span class="file__size">${entry.isDirectory ? "" : fmtBytes(entry.size)}</span>
                </button>`).join("") || '<div class="muted">This folder is empty.</div>';

              listEl.querySelectorAll(".file").forEach((row) => {
                row.onclick = () => {
                  listEl.querySelectorAll(".file--selected").forEach((r) => r.classList.remove("file--selected"));
                  row.classList.add("file--selected");
                };
                row.ondblclick = () => openEntry(row.dataset.path, row.dataset.dir === "true");
              });
            } catch (error) {
              listEl.innerHTML = `<div class="muted">${esc(error.message)}</div>`;
            }
          }

          body.querySelector('[data-act="up"]').onclick = () => {
            const parent = cwd && cwd !== "/" ? (cwd.replace(/\/[^/]*$/, "") || "/") : "/";
            navigate(parent);
          };
          body.querySelector('[data-act="home"]').onclick = () => navigate(null);
          body.querySelector('[data-act="refresh"]').onclick = () => navigate(cwd);
          body.querySelector('[data-act="new"]').onclick = async () => {
            const name = await Dialog.prompt("New folder name", "New Folder");
            if (!name) return;
            try {
              await invoke("fs.mkdir", { path: joinPath(cwd, name) });
              Toast.show(`Created "${name}"`, "good");
              navigate(cwd);
            } catch (error) {
              Toast.show(error.message, "error");
            }
          };

          navigate(cwd);
        },
      });
    },
  };

  /* ---- Notepad ----------------------------------------------------------- */
  Content.notepad = {
    id: "notepad", title: "Notepad", icon: "📝", accent: "#ffd000",
    description: "Type and save text files",
    open(args) {
      const requested = args && args.path;
      WM.open({
        id: "notepad", title: "Notepad", icon: "📝", accent: "#ffd000",
        width: 760, height: 540, path: requested,
        render(body, api) {
          body.innerHTML = `
            <div class="notepad">
              <div class="toolbar" style="margin:0;padding:10px 12px;border-bottom:3px solid var(--ink);background:#fff4c2;">
                <button class="btn" data-act="new">🆕 New</button>
                <button class="btn" data-act="open">📂 Open</button>
                <button class="btn" data-act="save">💾 Save</button>
                <button class="btn" data-act="saveas">📥 Save As</button>
              </div>
              <textarea class="notepad__area" spellcheck="false"></textarea>
              <div class="notepad__status">
                <span class="mono" data-path>untitled</span>
                <span class="spacer"></span>
                <span data-stats>0 chars · 1 line</span>
              </div>
            </div>`;

          const area = body.querySelector(".notepad__area");
          const pathLabel = body.querySelector("[data-path]");
          const stats = body.querySelector("[data-stats]");
          let currentPath = null;

          const refreshStats = () => {
            const text = area.value;
            stats.textContent = `${text.length} chars · ${text.split(/\n/).length} line(s)`;
          };
          const setPath = (path) => {
            currentPath = path;
            pathLabel.textContent = path || "untitled";
            api.setTitle(path ? `Notepad — ${baseName(path)}` : "Notepad");
          };

          api.loadPath = async (path) => {
            try {
              const file = await invoke("fs.readText", { path });
              area.value = file.content;
              setPath(file.path);
              refreshStats();
            } catch (error) {
              Toast.show(error.message, "error");
            }
          };

          async function save(asNew) {
            let target = asNew ? null : currentPath;
            if (!target) {
              target = await FileDialog.show({
                mode: "save", title: "Save as", defaultName: currentPath ? baseName(currentPath) : "untitled.txt",
              });
              if (!target) return;
              if (!/\.[a-z0-9]+$/i.test(target)) target += ".txt";
            }
            try {
              const result = await invoke("fs.writeText", { path: target, content: area.value });
              setPath(result.path);
              Toast.show(`Saved ${baseName(result.path)} (${fmtBytes(result.size)})`, "good");
            } catch (error) {
              Toast.show(error.message, "error");
            }
          }

          body.querySelector('[data-act="new"]').onclick = () => { area.value = ""; setPath(null); refreshStats(); area.focus(); };
          body.querySelector('[data-act="save"]').onclick = () => save(false);
          body.querySelector('[data-act="saveas"]').onclick = () => save(true);
          body.querySelector('[data-act="open"]').onclick = async () => {
            const path = await FileDialog.show({ mode: "open", title: "Open file" });
            if (path) api.loadPath(path);
          };

          area.addEventListener("input", refreshStats);
          area.addEventListener("pointerdown", (event) => event.stopPropagation());
          area.addEventListener("keydown", (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              save(false);
            }
          });

          api.onReopen = (spec) => { if (spec && spec.path) api.loadPath(spec.path); };

          setPath(null);
          if (requested) api.loadPath(requested);
          refreshStats();
        },
      });
    },
  };

  /* ---- Paint ------------------------------------------------------------- */
  Content.paint = {
    id: "paint", title: "Paint", icon: "🎨", accent: "#ff4757",
    description: "Draw, open images and zoom",
    open(args) {
      const requested = args && args.path;
      WM.open({
        id: "paint", title: "Paint", icon: "🎨", accent: "#ff4757",
        width: 1000, height: 700, path: requested,
        render(body, api) {
          const palette = ["#17181c", "#ff4757", "#ffd000", "#2ed573", "#4cc2ff", "#a55eea", "#ff9f43", "#ffffff"];
          body.innerHTML = `
            <div class="paint">
              <div class="paint__tools">
                <button class="btn btn--accent" data-tool="brush">🖌️ Brush</button>
                <button class="btn" data-tool="fill" title="Click a region to flood-fill it">🪣 Fill</button>
                <button class="btn" data-act="erase" title="Erase toggle: the brush erases and the Fill bucket erases a connected colour">🧽 Erase: Off</button>
                <span class="chip">Size <input type="range" min="1" max="42" value="7" data-size style="width:110px;vertical-align:middle" /></span>
                <div class="paint__swatches" data-swatches></div>
                <input type="color" class="paint__picker" data-picker value="#17181c" title="Custom colour" />
                <span class="paint__zoom">
                  <button class="btn" data-zoom-out title="Zoom out (Ctrl -)">➖</button>
                  <button class="btn paint__zoom-label" data-zoom-label title="Click to fit">100%</button>
                  <button class="btn" data-zoom-in title="Zoom in (Ctrl +)">➕</button>
                  <button class="btn" data-zoom="fit" title="Fit the canvas in the window">Fit</button>
                  <button class="btn" data-zoom="fill" title="Fill the window (crops)">Fill</button>
                  <button class="btn" data-zoom="100" title="Actual size (Ctrl 1)">1:1</button>
                </span>
                <span class="spacer"></span>
                <button class="btn" data-act="open" title="Open an image into the canvas">🖼️ Open…</button>
                <button class="btn" data-act="bg" title="Transparent background — saved PNG keeps its alpha">🫥 Transparent: Off</button>
                <button class="btn" data-act="resize">📐 Resize…</button>
                <button class="btn btn--danger" data-act="clear">🗑️ Clear</button>
                <button class="btn btn--primary" data-act="save">💾 Save PNG</button>
              </div>
              <div class="paint__resize" data-resize hidden>
                <b>Resize canvas</b>
                <input type="number" min="1" max="4096" value="820" data-rw />
                <span>×</span>
                <input type="number" min="1" max="4096" value="440" data-rh />
                <label><input type="checkbox" data-rscale checked /> Scale content</label>
                <button class="btn btn--accent" data-rapply>Apply</button>
                <button class="btn" data-rcancel>Cancel</button>
              </div>
              <div class="paint__stage" data-stage>
                <div class="paint__canvas-wrap" data-wrap>
                  <canvas width="820" height="440" tabindex="0"></canvas>
                </div>
              </div>
            </div>`;

          const canvas = body.querySelector("canvas");
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          const swatches = body.querySelector("[data-swatches]");
          const sizeInput = body.querySelector("[data-size]");
          const picker = body.querySelector("[data-picker]");
          const resizePanel = body.querySelector("[data-resize]");
          const rw = body.querySelector("[data-rw]");
          const rh = body.querySelector("[data-rh]");
          const rscale = body.querySelector("[data-rscale]");
          const eraseBtn = body.querySelector('[data-act="erase"]');
          const bgBtn = body.querySelector('[data-act="bg"]');
          const stage = body.querySelector("[data-stage]");
          const wrap = body.querySelector("[data-wrap]");
          const zoomLabel = body.querySelector("[data-zoom-label]");

          let tool = "brush";
          let erase = false;
          let transparentBg = false;
          let color = "#17181c";
          let drawing = false;
          let zoom = 1;
          let zoomMode = "fit"; // "fit" | "fill" | "manual"

          const hexToRgb = (hex) => {
            const value = String(hex).replace("#", "");
            const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
            const n = Number.parseInt(full, 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
          };

          function paintBase() {
            ctx.globalCompositeOperation = "source-over";
            if (transparentBg) {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
            } else {
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
            ctx.lineJoin = ctx.lineCap = "round";
          }

          function displayScale(scale, mode) {
            zoom = Math.max(0.05, Math.min(16, scale));
            zoomMode = mode;
            const w = Math.max(1, Math.round(canvas.width * zoom));
            const h = Math.max(1, Math.round(canvas.height * zoom));
            wrap.style.width = `${w}px`;
            wrap.style.height = `${h}px`;
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;
            zoomLabel.textContent = mode === "manual" ? `${Math.round(zoom * 100)}%` : (mode === "fill" ? "Fill" : "Fit");
            body.querySelectorAll("[data-zoom]").forEach((button) => {
              const active = (button.dataset.zoom === "fit" && mode === "fit")
                || (button.dataset.zoom === "fill" && mode === "fill")
                || (button.dataset.zoom === "100" && mode === "manual" && Math.abs(zoom - 1) < 0.001);
              button.classList.toggle("btn--accent", active);
            });
          }

          function fitScale(mode) {
            const availW = Math.max(1, stage.clientWidth - 12);
            const availH = Math.max(1, stage.clientHeight - 12);
            const sx = availW / canvas.width;
            const sy = availH / canvas.height;
            return mode === "fill" ? Math.max(sx, sy) : Math.min(sx, sy);
          }

          function zoomTo(mode) {
            if (mode === "manual") return;
            displayScale(fitScale(mode), mode);
          }

          function zoomBy(factor) {
            const base = zoomMode === "manual" ? zoom : fitScale(zoomMode);
            displayScale(base * factor, "manual");
          }

          function refreshZoom() {
            if (zoomMode === "manual") displayScale(zoom, "manual");
            else displayScale(fitScale(zoomMode), zoomMode);
          }

          function setTool(next) {
            tool = next;
            body.querySelectorAll("[data-tool]").forEach((button) => {
              button.classList.toggle("btn--accent", button.dataset.tool === next);
            });
          }

          function setErase(next) {
            erase = next;
            eraseBtn.classList.toggle("btn--accent", next);
            eraseBtn.textContent = `🧽 Erase: ${next ? "On" : "Off"}`;
          }

          function chooseColor(value) {
            color = value;
            picker.value = /^#[0-9a-f]{6}$/i.test(value) ? value : picker.value;
            body.querySelectorAll(".swatch").forEach((swatch) => {
              swatch.classList.toggle("swatch--active", swatch.dataset.color.toLowerCase() === value.toLowerCase());
            });
          }

          function setTransparent(next) {
            if (next === transparentBg) return;
            transparentBg = next;
            // Give the toggle an immediate, visible effect: drop the white paper
            // into transparent pixels (or flatten transparency back onto white).
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const d = image.data;
            if (next) {
              for (let i = 0; i < d.length; i += 4) {
                if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255 && d[i + 3] === 255) d[i + 3] = 0;
              }
            } else {
              for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] < 255) {
                  const a = d[i + 3] / 255;
                  d[i] = Math.round(d[i] * a + 255 * (1 - a));
                  d[i + 1] = Math.round(d[i + 1] * a + 255 * (1 - a));
                  d[i + 2] = Math.round(d[i + 2] * a + 255 * (1 - a));
                  d[i + 3] = 255;
                }
              }
            }
            ctx.putImageData(image, 0, 0);
            bgBtn.classList.toggle("btn--accent", next);
            bgBtn.textContent = `🫥 Transparent: ${next ? "On" : "Off"}`;
          }

          function currentFill() {
            if (!erase) { const [r, g, b] = hexToRgb(color); return [r, g, b, 255]; }
            return transparentBg ? [0, 0, 0, 0] : [255, 255, 255, 255];
          }

          function floodFill(sx, sy) {
            const w = canvas.width, h = canvas.height;
            if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
            const image = ctx.getImageData(0, 0, w, h);
            const d = image.data;
            const fill = currentFill();
            const at = (x, y) => (y * w + x) * 4;
            const start = at(sx, sy);
            const tr = d[start], tg = d[start + 1], tb = d[start + 2], ta = d[start + 3];
            if (tr === fill[0] && tg === fill[1] && tb === fill[2] && ta === fill[3]) return;
            const same = (i) => d[i] === tr && d[i + 1] === tg && d[i + 2] === tb && d[i + 3] === ta;
            const put = (i) => { d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = fill[3]; };
            const stack = [[sx, sy]];
            while (stack.length) {
              const [px, py] = stack.pop();
              let x = px, i = at(x, py);
              while (x >= 0 && same(i)) { x -= 1; i -= 4; }
              x += 1; i += 4;
              let spanAbove = false, spanBelow = false;
              while (x < w && same(i)) {
                put(i);
                if (py > 0) {
                  const up = i - w * 4;
                  if (!spanAbove && same(up)) { stack.push([x, py - 1]); spanAbove = true; }
                  else if (spanAbove && !same(up)) spanAbove = false;
                }
                if (py < h - 1) {
                  const down = i + w * 4;
                  if (!spanBelow && same(down)) { stack.push([x, py + 1]); spanBelow = true; }
                  else if (spanBelow && !same(down)) spanBelow = false;
                }
                x += 1; i += 4;
              }
            }
            ctx.putImageData(image, 0, 0);
          }

          function applyStrokeStyle() {
            if (erase) {
              if (transparentBg) {
                ctx.globalCompositeOperation = "destination-out";
                ctx.strokeStyle = "rgba(0,0,0,1)";
              } else {
                ctx.globalCompositeOperation = "source-over";
                ctx.strokeStyle = "#ffffff";
              }
            } else {
              ctx.globalCompositeOperation = "source-over";
              ctx.strokeStyle = color;
            }
            ctx.lineWidth = erase ? Number(sizeInput.value) * 2.4 : Number(sizeInput.value);
            ctx.lineJoin = ctx.lineCap = "round";
          }

          const point = (event) => {
            const rect = canvas.getBoundingClientRect();
            return {
              x: (event.clientX - rect.left) * (canvas.width / rect.width),
              y: (event.clientY - rect.top) * (canvas.height / rect.height),
            };
          };

          palette.forEach((value, index) => {
            const swatch = el("button", "swatch");
            swatch.dataset.color = value;
            swatch.style.background = value;
            if (index === 0) swatch.classList.add("swatch--active");
            swatch.onclick = () => { chooseColor(value); setTool("brush"); setErase(false); };
            swatches.appendChild(swatch);
          });
          picker.addEventListener("input", () => { chooseColor(picker.value); setTool("brush"); setErase(false); });

          body.querySelector('[data-tool="brush"]').onclick = () => setTool("brush");
          body.querySelector('[data-tool="fill"]').onclick = () => setTool("fill");
          eraseBtn.onclick = () => setErase(!erase);
          bgBtn.onclick = () => setTransparent(!transparentBg);

          body.querySelector('[data-act="clear"]').onclick = () => paintBase();

          body.querySelector('[data-act="resize"]').onclick = () => {
            rw.value = canvas.width;
            rh.value = canvas.height;
            resizePanel.hidden = !resizePanel.hidden;
          };
          body.querySelector('[data-rcancel]').onclick = () => { resizePanel.hidden = true; };
          body.querySelector('[data-rapply]').onclick = () => {
            const w = Math.max(1, Math.min(4096, Number.parseInt(rw.value, 10) || canvas.width));
            const h = Math.max(1, Math.min(4096, Number.parseInt(rh.value, 10) || canvas.height));
            const snapshot = document.createElement("canvas");
            snapshot.width = canvas.width;
            snapshot.height = canvas.height;
            snapshot.getContext("2d").drawImage(canvas, 0, 0);
            canvas.width = w;
            canvas.height = h;
            paintBase();
            ctx.drawImage(snapshot, 0, 0, snapshot.width, snapshot.height, 0, 0,
              rscale.checked ? w : snapshot.width, rscale.checked ? h : snapshot.height);
            resizePanel.hidden = true;
            refreshZoom();
            Toast.show(`Canvas resized to ${w}×${h}.`, "good");
          };

          body.querySelector('[data-act="save"]').onclick = async () => {
            const path = await FileDialog.show({ mode: "save", title: "Save painting", defaultName: "painting.png" });
            if (!path) return;
            const target = /\.[a-z0-9]+$/i.test(path) ? path : `${path}.png`;
            try {
              const dataUrl = canvas.toDataURL("image/png");
              const result = await invoke("fs.writeBytes", { path: target, base64: dataUrl });
              Toast.show(`Saved ${baseName(result.path)} (${fmtBytes(result.size)})`, "good");
            } catch (error) {
              Toast.show(error.message, "error");
            }
          };

          async function loadImagePath(path) {
            try {
              const file = await invoke("fs.readDataUrl", { path });
              const bitmap = new Image();
              await new Promise((resolve, reject) => {
                bitmap.onload = resolve;
                bitmap.onerror = () => reject(new Error("That file isn't a readable image."));
                bitmap.src = file.dataUrl;
              });
              canvas.width = bitmap.naturalWidth || canvas.width;
              canvas.height = bitmap.naturalHeight || canvas.height;
              canvas.style.width = "";
              canvas.style.height = "";
              paintBase();
              ctx.globalCompositeOperation = "source-over";
              ctx.drawImage(bitmap, 0, 0);
              refreshZoom();
              Toast.show(`Opened ${baseName(file.path)} — ${canvas.width}×${canvas.height}`, "good");
            } catch (error) {
              Toast.show(error.message, "error");
            }
          }
          api.loadPath = loadImagePath;
          api.onReopen = (next) => { if (next && next.path) loadImagePath(next.path); };

          body.querySelector('[data-act="open"]').onclick = async () => {
            const path = await FileDialog.show({ mode: "open", title: "Open image" });
            if (path) loadImagePath(path);
          };

          body.querySelector("[data-zoom-in]").onclick = () => zoomBy(1.25);
          body.querySelector("[data-zoom-out]").onclick = () => zoomBy(1 / 1.25);
          body.querySelector("[data-zoom-label]").onclick = () => zoomTo("fit");
          body.querySelector('[data-zoom="fit"]').onclick = () => zoomTo("fit");
          body.querySelector('[data-zoom="fill"]').onclick = () => zoomTo("fill");
          body.querySelector('[data-zoom="100"]').onclick = () => displayScale(1, "manual");
          stage.addEventListener("wheel", (event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
          }, { passive: false });
          canvas.addEventListener("keydown", (event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            if (event.key === "=" || event.key === "+") { event.preventDefault(); zoomBy(1.25); }
            else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomBy(1 / 1.25); }
            else if (event.key === "0") { event.preventDefault(); zoomTo("fit"); }
            else if (event.key === "1") { event.preventDefault(); displayScale(1, "manual"); }
          });

          const zoomObserver = new ResizeObserver(() => refreshZoom());
          zoomObserver.observe(stage);
          api.onClose(() => zoomObserver.disconnect());

          canvas.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            const p = point(event);
            if (tool === "fill") {
              floodFill(Math.floor(p.x), Math.floor(p.y));
              return;
            }
            drawing = true;
            try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
            applyStrokeStyle();
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + 0.01, p.y);
            ctx.stroke();
          });
          canvas.addEventListener("pointermove", (event) => {
            if (!drawing) return;
            const p = point(event);
            applyStrokeStyle();
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          });
          const stop = () => {
            if (!drawing) return;
            drawing = false;
            ctx.globalCompositeOperation = "source-over";
          };
          canvas.addEventListener("pointerup", stop);
          canvas.addEventListener("pointercancel", stop);
          canvas.addEventListener("contextmenu", (event) => event.preventDefault());

          paintBase();
          refreshZoom();
          if (requested) loadImagePath(requested);
        },
      });
    },
  };

  /* ---- Snake ------------------------------------------------------------- */
  Content.snake = {
    id: "snake", title: "Snake", icon: "🐍", accent: "#a55eea",
    description: "Classic snake, arrow keys",
    open() {
      WM.open({
        id: "snake", title: "Snake", icon: "🐍", accent: "#a55eea",
        width: 560, height: 580,
        render(body, api) {
          body.innerHTML = `
            <div class="snake">
              <div class="snake__hud">
                <span class="chip">Score <b data-score>0</b></span>
                <span class="chip">Best <b data-best>0</b></span>
                <span class="spacer"></span>
                <button class="btn btn--primary" data-act="start">▶ Play</button>
              </div>
              <canvas class="snake__board" width="440" height="440" tabindex="0"></canvas>
              <div class="snake__hint">Arrow keys / WASD to steer · Space to pause</div>
            </div>`;

          const canvas = body.querySelector("canvas");
          const ctx = canvas.getContext("2d");
          const scoreEl = body.querySelector("[data-score]");
          const bestEl = body.querySelector("[data-best]");
          const cell = 20;
          const cols = canvas.width / cell;
          const rows = canvas.height / cell;

          let snake, direction, nextDirection, food, score, timer, running, best;

          best = Store.get("snakeBest", 0);
          bestEl.textContent = best;

          const randomFood = () => {
            let spot;
            do {
              spot = { x: Math.floor(Math.random() * cols), y: Math.floor(Math.random() * rows) };
            } while (snake.some((segment) => segment.x === spot.x && segment.y === spot.y));
            return spot;
          };

          const reset = () => {
            snake = [{ x: 5, y: 10 }, { x: 4, y: 10 }, { x: 3, y: 10 }];
            direction = { x: 1, y: 0 };
            nextDirection = direction;
            score = 0;
            scoreEl.textContent = "0";
            food = randomFood();
          };

          const draw = () => {
            ctx.fillStyle = "#e9fbe9";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#ff4757";
            ctx.fillRect(food.x * cell + 2, food.y * cell + 2, cell - 4, cell - 4);
            snake.forEach((segment, index) => {
              ctx.fillStyle = index === 0 ? "#2ed573" : "#7be495";
              ctx.fillRect(segment.x * cell + 1, segment.y * cell + 1, cell - 2, cell - 2);
            });
          };

          const step = () => {
            direction = nextDirection;
            const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };
            const hitWall = head.x < 0 || head.y < 0 || head.x >= cols || head.y >= rows;
            const hitSelf = snake.some((segment) => segment.x === head.x && segment.y === head.y);
            if (hitWall || hitSelf) { gameOver(); return; }
            snake.unshift(head);
            if (head.x === food.x && head.y === food.y) {
              score += 1;
              scoreEl.textContent = score;
              food = randomFood();
            } else {
              snake.pop();
            }
            draw();
          };

          const gameOver = () => {
            clearInterval(timer);
            running = false;
            if (score > best) { best = score; Store.set("snakeBest", best); bestEl.textContent = best; }
            ctx.fillStyle = "rgba(23,24,28,.72)";
            ctx.fillRect(0, canvas.height / 2 - 40, canvas.width, 80);
            ctx.fillStyle = "#fff";
            ctx.font = "26px 'Comic Sans MS', cursive";
            ctx.textAlign = "center";
            ctx.fillText("GAME OVER", canvas.width / 2, canvas.height / 2 + 4);
            ctx.font = "15px 'Comic Sans MS', cursive";
            ctx.fillText("press Play to retry", canvas.width / 2, canvas.height / 2 + 26);
          };

          const start = () => {
            reset();
            draw();
            clearInterval(timer);
            running = true;
            timer = setInterval(step, 110);
            canvas.focus();
          };

          body.querySelector('[data-act="start"]').onclick = start;

          canvas.addEventListener("keydown", (event) => {
            const keys = {
              ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
              ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
              w: { x: 0, y: -1 }, s: { x: 0, y: 1 }, a: { x: -1, y: 0 }, d: { x: 1, y: 0 },
            };
            const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
            if (key === " ") {
              event.preventDefault();
              if (running) { clearInterval(timer); running = false; }
              else { running = true; timer = setInterval(step, 110); }
              return;
            }
            const move = keys[key];
            if (!move) return;
            event.preventDefault();
            if (move.x === -direction.x && move.y === -direction.y) return;
            nextDirection = move;
          });

          api.onClose(() => clearInterval(timer));
          reset();
          draw();
        },
      });
    },
  };

  /* ---- Tetris ------------------------------------------------------------ */
  Content.tetris = {
    id: "tetris", title: "Tetris", icon: "🧱", accent: "#3ec6ff",
    description: "Stack the blocks, clear the lines",
    open() {
      WM.open({
        id: "tetris", title: "Tetris", icon: "🧱", accent: "#3ec6ff",
        width: 470, height: 640,
        render(body, api) {
          body.innerHTML = `
            <div class="tetris">
              <div class="tetris__hud">
                <span class="chip">Score <b data-score>0</b></span>
                <span class="chip">Lines <b data-lines>0</b></span>
                <span class="chip">Level <b data-level>1</b></span>
                <span class="chip">Best <b data-best>0</b></span>
              </div>
              <div class="tetris__stage">
                <canvas class="tetris__board" width="240" height="480" tabindex="0"></canvas>
                <div class="tetris__side">
                  <div class="tetris__next-label">Next</div>
                  <canvas class="tetris__next" width="96" height="96" tabindex="-1"></canvas>
                  <button class="btn btn--primary" data-act="start">▶ Play</button>
                  <button class="btn" data-act="pause">⏸ Pause</button>
                </div>
              </div>
              <div class="tetris__hint">←/→ move · ↑/X rotate · ↓ soft drop · Space hard drop · P pause</div>
            </div>`;

          const COLS = 10, ROWS = 20, CELL = 24;
          const SHAPES = {
            I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
            O: [[1, 1], [1, 1]],
            T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
            S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
            Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
            J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
            L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
          };
          const COLORS = {
            I: "#3ec6ff", O: "#ffd93b", T: "#b06bff",
            S: "#4ce07a", Z: "#ff5d6c", J: "#4c7bff", L: "#ff9f43",
          };

          const board = body.querySelector(".tetris__board");
          const ctx = board.getContext("2d");
          const nextCanvas = body.querySelector(".tetris__next");
          const nctx = nextCanvas.getContext("2d");
          const scoreEl = body.querySelector("[data-score]");
          const linesEl = body.querySelector("[data-lines]");
          const levelEl = body.querySelector("[data-level]");
          const bestEl = body.querySelector("[data-best]");
          const pauseBtn = body.querySelector('[data-act="pause"]');

          let grid, piece, nextType, bag, score, lines, level, over, paused, timer;
          let best = Store.get("tetrisBest", 0) || 0;
          bestEl.textContent = best;

          const emptyGrid = () => Array.from({ length: ROWS }, () => Array(COLS).fill(""));

          const bagQueue = () => {
            if (!bag || !bag.length) {
              bag = Object.keys(SHAPES);
              for (let i = bag.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [bag[i], bag[j]] = [bag[j], bag[i]];
              }
            }
            return bag.pop();
          };

          const makePiece = (type) => {
            const matrix = SHAPES[type].map((row) => row.slice());
            return { type, matrix, x: Math.floor((COLS - matrix.length) / 2), y: 0 };
          };

          const rotate = (matrix) => matrix[0].map((_, i) => matrix.map((row) => row[i]).reverse());

          const collides = (matrix, px, py) => {
            for (let y = 0; y < matrix.length; y++) {
              for (let x = 0; x < matrix[y].length; x++) {
                if (!matrix[y][x]) continue;
                const bx = px + x, by = py + y;
                if (bx < 0 || bx >= COLS || by >= ROWS) return true;
                if (by >= 0 && grid[by][bx]) return true;
              }
            }
            return false;
          };

          const paintCell = (cx, cy, color, alpha) => {
            ctx.globalAlpha = alpha == null ? 1 : alpha;
            ctx.fillStyle = color;
            ctx.fillRect(cx * CELL + 1, cy * CELL + 1, CELL - 2, CELL - 2);
            ctx.fillStyle = "rgba(255,255,255,.22)";
            ctx.fillRect(cx * CELL + 1, cy * CELL + 1, CELL - 2, 4);
            ctx.globalAlpha = 1;
          };

          const canPlay = () => !over && !paused && !!piece;

          const drawNext = () => {
            nctx.fillStyle = "#12131a";
            nctx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
            if (!nextType) return;
            const matrix = SHAPES[nextType];
            let minX = 99, maxX = -1, minY = 99, maxY = -1;
            matrix.forEach((row, y) => row.forEach((value, x) => {
              if (!value) return;
              minX = Math.min(minX, x); maxX = Math.max(maxX, x);
              minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }));
            const size = 22;
            const ox = (nextCanvas.width - (maxX - minX + 1) * size) / 2;
            const oy = (nextCanvas.height - (maxY - minY + 1) * size) / 2;
            for (let y = minY; y <= maxY; y++) {
              for (let x = minX; x <= maxX; x++) {
                if (!matrix[y][x]) continue;
                const px = ox + (x - minX) * size, py = oy + (y - minY) * size;
                nctx.fillStyle = COLORS[nextType];
                nctx.fillRect(px + 1, py + 1, size - 2, size - 2);
                nctx.fillStyle = "rgba(255,255,255,.22)";
                nctx.fillRect(px + 1, py + 1, size - 2, 4);
              }
            }
          };

          const draw = () => {
            ctx.fillStyle = "#12131a";
            ctx.fillRect(0, 0, board.width, board.height);
            ctx.strokeStyle = "rgba(255,255,255,.07)";
            ctx.lineWidth = 1;
            for (let x = 1; x < COLS; x++) {
              ctx.beginPath(); ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, board.height); ctx.stroke();
            }
            for (let y = 1; y < ROWS; y++) {
              ctx.beginPath(); ctx.moveTo(0, y * CELL + 0.5); ctx.lineTo(board.width, y * CELL + 0.5); ctx.stroke();
            }
            for (let y = 0; y < ROWS; y++) {
              for (let x = 0; x < COLS; x++) {
                if (grid[y][x]) paintCell(x, y, COLORS[grid[y][x]]);
              }
            }
            if (piece && !over) {
              let gy = piece.y;
              while (!collides(piece.matrix, piece.x, gy + 1)) gy += 1;
              ctx.globalAlpha = .4;
              ctx.strokeStyle = COLORS[piece.type];
              ctx.lineWidth = 2;
              for (let y = 0; y < piece.matrix.length; y++) {
                for (let x = 0; x < piece.matrix[y].length; x++) {
                  if (!piece.matrix[y][x]) continue;
                  ctx.strokeRect((piece.x + x) * CELL + 2, (gy + y) * CELL + 2, CELL - 4, CELL - 4);
                }
              }
              ctx.globalAlpha = 1;
              for (let y = 0; y < piece.matrix.length; y++) {
                for (let x = 0; x < piece.matrix[y].length; x++) {
                  if (piece.matrix[y][x]) paintCell(piece.x + x, piece.y + y, COLORS[piece.type]);
                }
              }
            }
            if (over || paused) {
              ctx.fillStyle = "rgba(23,24,28,.72)";
              ctx.fillRect(0, board.height / 2 - 50, board.width, 100);
              ctx.fillStyle = "#fff";
              ctx.textAlign = "center";
              ctx.font = "26px 'Comic Sans MS', cursive";
              ctx.fillText(over ? "GAME OVER" : "PAUSED", board.width / 2, board.height / 2 - 4);
              ctx.font = "15px 'Comic Sans MS', cursive";
              ctx.fillText(over ? "press Play to retry" : "press P to resume", board.width / 2, board.height / 2 + 24);
            }
          };

          const gameOver = () => {
            clearInterval(timer);
            over = true;
            if (score > best) { best = score; Store.set("tetrisBest", best); bestEl.textContent = best; }
            draw();
          };

          const newPiece = () => {
            piece = makePiece(nextType);
            nextType = bagQueue();
            drawNext();
          };

          const dropInterval = () => Math.max(90, 780 - (level - 1) * 65);

          const armTimer = () => {
            clearInterval(timer);
            timer = setInterval(tick, dropInterval());
          };

          const tick = () => {
            if (!canPlay()) return;
            if (collides(piece.matrix, piece.x, piece.y + 1)) { lock(); return; }
            piece.y += 1;
            draw();
          };

          const clearLines = () => {
            let cleared = 0;
            for (let y = ROWS - 1; y >= 0; y--) {
              if (grid[y].every(Boolean)) {
                grid.splice(y, 1);
                grid.unshift(Array(COLS).fill(""));
                cleared += 1;
                y += 1;
              }
            }
            if (!cleared) return;
            lines += cleared;
            linesEl.textContent = lines;
            const table = { 1: 100, 2: 300, 3: 500, 4: 800 };
            score += (table[cleared] || 0) * level;
            scoreEl.textContent = score;
            const nextLevel = Math.floor(lines / 10) + 1;
            if (nextLevel !== level) { level = nextLevel; levelEl.textContent = level; armTimer(); }
          };

          const lock = () => {
            piece.matrix.forEach((row, y) => row.forEach((value, x) => {
              if (value && piece.y + y >= 0) grid[piece.y + y][piece.x + x] = piece.type;
            }));
            clearLines();
            newPiece();
            if (collides(piece.matrix, piece.x, piece.y)) { gameOver(); return; }
            draw();
          };

          const move = (dx) => {
            if (!canPlay() || collides(piece.matrix, piece.x + dx, piece.y)) return;
            piece.x += dx;
            draw();
          };

          const softDrop = () => {
            if (!canPlay()) return;
            if (collides(piece.matrix, piece.x, piece.y + 1)) { lock(); return; }
            piece.y += 1;
            score += 1;
            scoreEl.textContent = score;
            draw();
          };

          const hardDrop = () => {
            if (!canPlay()) return;
            let dropped = 0;
            while (!collides(piece.matrix, piece.x, piece.y + 1)) { piece.y += 1; dropped += 1; }
            score += dropped * 2;
            scoreEl.textContent = score;
            lock();
          };

          const spin = () => {
            if (!canPlay()) return;
            const rotated = rotate(piece.matrix);
            for (const kick of [0, -1, 1, -2, 2]) {
              if (!collides(rotated, piece.x + kick, piece.y)) {
                piece.matrix = rotated;
                piece.x += kick;
                draw();
                return;
              }
            }
          };

          const setPaused = (value) => {
            paused = value;
            pauseBtn.textContent = value ? "▶ Resume" : "⏸ Pause";
            if (value) clearInterval(timer);
            else if (!over) armTimer();
            draw();
          };

          const start = () => {
            clearInterval(timer);
            grid = emptyGrid();
            score = 0; lines = 0; level = 1; over = false; paused = false; bag = null;
            scoreEl.textContent = "0";
            linesEl.textContent = "0";
            levelEl.textContent = "1";
            pauseBtn.textContent = "⏸ Pause";
            nextType = bagQueue();
            newPiece();
            draw();
            armTimer();
            board.focus();
          };

          body.querySelector('[data-act="start"]').onclick = start;
          pauseBtn.onclick = () => {
            if (!piece || over) return;
            setPaused(!paused);
            board.focus();
          };
          board.addEventListener("pointerdown", () => board.focus());
          board.addEventListener("keydown", (event) => {
            const raw = event.key;
            const key = raw.length === 1 ? raw.toLowerCase() : raw;
            if (key === " " || key.startsWith("Arrow") || "wasdxp".includes(key)) { event.preventDefault(); }
            if (key === "p") { if (piece && !over) setPaused(!paused); return; }
            if (!canPlay()) return;
            if (key === "ArrowLeft" || key === "a") move(-1);
            else if (key === "ArrowRight" || key === "d") move(1);
            else if (key === "ArrowDown" || key === "s") softDrop();
            else if (key === "ArrowUp" || key === "w" || key === "x") spin();
            else if (raw === " ") hardDrop();
          });

          api.onClose(() => clearInterval(timer));

          grid = emptyGrid();
          score = 0; lines = 0; level = 1; over = false; paused = false; piece = null; nextType = null;
          draw();
        },
      });
    },
  };

  /* ---- Terminal ---------------------------------------------------------- */
  const TERMINAL_HELP = [
    "commands: help  clear  sys  mem  ps [n]  ls [path]  cd [path]  pwd",
    "          cat <path>  mkdir <path>  notepad [path]  paint  snake  tetris  calc",
    "          music  clock  doom  katgpt  packager  settings  theme [dark|light]  apps  echo <text>  date",
  ];

  Content.terminal = {
    id: "terminal", title: "Terminal", icon: "⌨️", accent: "#2ed573",
    description: "Shell wired into C#",
    open() {
      WM.open({
        id: "terminal", title: "Terminal", icon: "⌨️", accent: "#2ed573",
        width: 720, height: 460,
        render(body) {
          body.innerHTML = `
            <div class="terminal">
              <div class="terminal__out"></div>
              <div class="terminal__input">
                <span class="terminal__prompt">~&gt;</span>
                <input class="terminal__field" spellcheck="false" autocomplete="off" />
              </div>
            </div>`;

          const out = body.querySelector(".terminal__out");
          const field = body.querySelector(".terminal__field");
          const prompt = body.querySelector(".terminal__prompt");
          let cwd = null;
          const history = [];
          let historyIndex = -1;

          const displayCwd = () => cwd || "~";
          const write = (text, variant) => {
            const line = el("div", `terminal__line${variant ? ` terminal__line--${variant}` : ""}`, text);
            out.appendChild(line);
            out.scrollTop = out.scrollHeight;
          };
          const updatePrompt = () => { prompt.textContent = `${displayCwd()}>`; };

          const commands = {
            help: () => TERMINAL_HELP.forEach((line) => write(line)),
            clear: () => { out.innerHTML = ""; },
            echo: (args) => write(args.join(" ")),
            date: () => write(new Date().toLocaleString()),
            notepad: (args) => { Content.notepad.open({ path: args.join(" ") || undefined }); write("launched notepad", "ok"); },
            paint: () => { Content.paint.open(); write("launched paint", "ok"); },
            snake: () => { Content.snake.open(); write("launched snake", "ok"); },
            tetris: () => { Content.tetris.open(); write("launched tetris", "ok"); },
            calc: () => { Content.calc.open(); write("launched calc", "ok"); },
            music: () => { Content.music.open(); write("launched music", "ok"); },
            clock: () => { Content.clock.open(); write("launched clock", "ok"); },
            doom: () => { Content.doom.open(); write("launched doom", "ok"); },
            katgpt: () => { Content.katgpt.open(); write("launched katgpt", "ok"); },
            packager: () => { Content.packager.open(); write("launched packager", "ok"); },
            settings: () => { Content.settings.open(); write("launched settings", "ok"); },
            theme: (args) => {
              const arg = (args[0] || "").toLowerCase();
              if (arg === "dark" || arg === "light") { setTheme(arg); write(`theme → ${arg}`, "ok"); }
              else write(`theme is ${currentSettings().theme} — try: theme dark  |  theme light`, "cmd");
            },
            apps: () => AppRegistry().forEach((app) => write(`  ${app.icon}  ${app.id.padEnd(12)} ${app.title}`)),
            async sys() {
              const info = await invoke("os.info");
              write(`product   : ${info.product} ${info.version}`);
              write(`machine   : ${info.machine} (${info.user})`);
              write(`os        : ${info.os}`);
              write(`runtime   : ${info.runtime}`);
              write(`processors: ${info.processors}`);
              write(`memory    : ${fmtBytes(info.workingSetBytes)}`);
            },
            async mem() {
              const m = await invoke("os.metrics");
              write(`cpu       : ${m.cpuPercent}%`);
              write(`memory    : ${fmtBytes(m.memoryUsed)} / ${fmtBytes(m.memoryTotal)} (${m.memoryPercent}%)`);
              write(`app       : ${fmtBytes(m.processWorkingSet)} · ${m.processThreads} threads`);
            },
            async ps(args) {
              const limit = Number.parseInt(args[0], 10) || 15;
              const processes = await invoke("app.processes", { limit });
              processes.forEach((p) => write(`  ${String(p.id).padStart(6)}  ${p.name.padEnd(26)} ${fmtBytes(p.memory).padStart(9)}`));
            },
            pwd: () => write(displayCwd()),
            async ls(args) {
              const listing = await invoke("fs.list", { path: args.length ? args.join(" ") : cwd });
              cwd = listing.path;
              updatePrompt();
              write(listing.path, "ok");
              listing.entries.forEach((entry) =>
                write(`  ${entry.isDirectory ? "d" : "-"} ${(entry.isDirectory ? "" : fmtBytes(entry.size)).padStart(9)}  ${entry.name}`));
            },
            async cd(args) {
              const listing = await invoke("fs.list", { path: args.length ? args.join(" ") : null });
              cwd = listing.path;
              updatePrompt();
            },
            async cat(args) {
              if (!args.length) { write("usage: cat <path>", "err"); return; }
              const file = await invoke("fs.readText", { path: args.join(" ") });
              file.content.split(/\r?\n/).forEach((line) => write(line));
            },
            async mkdir(args) {
              if (!args.length) { write("usage: mkdir <path>", "err"); return; }
              const dir = await invoke("fs.mkdir", { path: args.join(" ") });
              write(`created ${dir.path}`, "ok");
            },
          };

          async function run(input) {
            const line = input.trim();
            if (!line) return;
            history.unshift(line);
            historyIndex = -1;
            write(`${displayCwd()}> ${line}`, "cmd");
            const [name, ...args] = line.split(/\s+/);
            const command = commands[name.toLowerCase()];
            if (!command) { write(`command not found: ${name}`, "err"); return; }
            try {
              const result = command(args);
              if (result instanceof Promise) await result;
            } catch (error) {
              write(error.message, "err");
            }
          }

          field.addEventListener("keydown", async (event) => {
            if (event.key === "Enter") {
              const value = field.value;
              field.value = "";
              await run(value);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              if (historyIndex + 1 < history.length) historyIndex += 1;
              field.value = history[historyIndex] || "";
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              historyIndex = historyIndex > 0 ? historyIndex - 1 : -1;
              field.value = historyIndex >= 0 ? history[historyIndex] : "";
            }
          });
          field.addEventListener("pointerdown", (event) => event.stopPropagation());
          body.addEventListener("click", () => field.focus());

          write("ByteSize OS shell v2 — type 'help'.", "cmd");
          updatePrompt();
          setTimeout(() => field.focus(), 30);
        },
      });
    },
  };

  /* ---- Installer (ZIP apps + dock manager) --------------------------------- */
  Content.installer = {
    id: "installer", title: "Installer", icon: "🧩", accent: "#ff9f43",
    description: "Install ZIP apps and manage your dock",
    open() {
      WM.open({
        id: "installer", title: "Installer", icon: "🧩", accent: "#ff9f43",
        width: 680, height: 620,
        render(body, api) {
          api.onReopen = () => render();

          function installedApps() {
            return (Store.get("customApps", []) || []).filter((app) => app && typeof app.html === "string");
          }

          async function installFromZip() {
            const path = await FileDialog.show({ mode: "open", title: "Choose a ZIP in the sandbox", startPath: "/Downloads" });
            if (!path) return;
            if (extName(path) !== "zip") {
              Toast.show("That isn't a .zip file.", "error");
              return;
            }
            try {
              const result = await invoke("app.installZip", { path });
              const app = result.app;
              const list = installedApps();
              if (list.some((a) => a.id === app.id)) {
                Toast.show(`“${app.title}” is already installed`, "error");
                return;
              }
              list.push({ ...app, installedAt: Date.now() });
              Store.set("customApps", list);
              const dockSet = new Set(dockIds());
              dockSet.add(app.id);
              Store.set("dock", [...dockSet]);
              renderDock();
              renderStartApps();
              render();
              Toast.show(`Installed ${app.icon} ${app.title} — find it in your dock!`, "good", 4200);
            } catch (err) {
              Toast.show(err.message, "error", 6500);
              const msg = body.querySelector("[data-install-msg]");
              if (msg) msg.textContent = err.message;
            }
          }

          async function uninstall(id) {
            Store.set("customApps", installedApps().filter((a) => a.id !== id));
            renderDock();
            renderStartApps();
            render();
            Toast.show("App uninstalled.", "info");
          }

          function render() {
            const dock = new Set(dockIds());
            const installed = installedApps();
            body.innerHTML = `
              <div class="installer">
                <section>
                  <h3 class="inst-title">📦 Install from ZIP</h3>
                  <p class="muted" style="margin-top:0">
                    A ByteSize ZIP has <b>metadata.json</b> (title, icon, accent, entry, script),
                    one <b>.html</b> and one <b>.js</b> file. Drop a ZIP anywhere in the sandbox,
                    then pick it here. The sample lives at <b class="mono">/Downloads/ExampleApp.zip</b>.
                  </p>
                  <div class="row">
                    <button class="btn btn--accent" data-zip>📂 Choose a .zip…</button>
                    <span class="chip muted" data-install-msg></span>
                  </div>
                  <div class="inst-list" data-installed></div>
                </section>
                <section>
                  <h3 class="inst-title">🧩 Dock</h3>
                  <p class="muted" style="margin-top:0">Toggle which apps appear on your dock. Everything stays available in START.</p>
                  <div data-docklist></div>
                </section>
              </div>`;

            body.querySelector("[data-zip]").onclick = installFromZip;

            const instHost = body.querySelector("[data-installed]");
            if (installed.length) {
              installed.forEach((app) => {
                const row = el("div", "install-item");
                row.innerHTML = `<span class="install-item__glyph">${app.icon}</span>
                  <div style="flex:1"><b>${esc(app.title)}</b><br><small class="muted">${esc(app.description || "ZIP app")}</small></div>`;
                const del = el("button", "btn btn--danger", "Uninstall");
                del.onclick = () => uninstall(app.id);
                row.appendChild(del);
                instHost.appendChild(row);
              });
            } else {
              const note = el("div", "muted");
              note.innerHTML = `No ZIP apps installed yet.<br><small>Try the sample: <b class="mono">/Downloads/ExampleApp.zip</b>.</small>`;
              instHost.appendChild(note);
            }

            const dockHost = body.querySelector("[data-docklist]");
            AppRegistry().forEach((app) => {
              const row = el("div", "install-item");
              row.innerHTML = `<span class="install-item__glyph">${app.icon}</span>
                <div style="flex:1"><b>${esc(app.title)}</b><br><small class="muted">${esc(app.description || "")}</small></div>`;
              const toggle = el("button", `btn ${dock.has(app.id) ? "btn--danger" : "btn--primary"}`,
                dock.has(app.id) ? "Remove" : "Install");
              toggle.onclick = () => {
                const current = new Set(dockIds());
                if (current.has(app.id)) current.delete(app.id);
                else current.add(app.id);
                Store.set("dock", [...current]);
                renderDock();
                renderStartApps();
                render();
                Toast.show(`${app.title} ${current.has(app.id) ? "added to" : "removed from"} dock`, "good");
              };
              row.appendChild(toggle);
              dockHost.appendChild(row);
            });
          }

          render();
        },
      });
    },
  };

  /* ---- App Packager (HTML file -> installable ZIP app) ------------------- */
  const PACKAGER_EMOJI = [
    "📦", "🧰", "🎮", "🕹️", "🎨", "🖌️", "🎵", "🎧", "📝", "📒",
    "🧮", "🔬", "🚀", "⭐", "🌟", "🔥", "💡", "🧩", "🗺️", "📷",
    "🔧", "⚙️", "🎲", "🃏", "🍕", "🍩", "🌈", "☕", "🧪", "📚",
    "🕰️", "💾", "🐱", "🐸", "🦄", "🐙", "🧸", "🌸", "🍄", "👾",
  ];
  const PACKAGER_ACCENTS = [
    "#8e7cff", "#4cc2ff", "#2ed573", "#ff9f43", "#ff6b81",
    "#ff7ac2", "#fdcb6e", "#00cec9", "#6c5ce7", "#e17055",
  ];
  const packagerSlug = (text) => String(text || "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

  Content.packager = {
    id: "packager", title: "App Packager", icon: "🧰", accent: "#8e7cff",
    description: "Turn an HTML file into an installable ZIP app",
    open() {
      WM.open({
        id: "packager", title: "App Packager", icon: "🧰", accent: "#8e7cff",
        width: 720, height: 660,
        render(body, api) {
          const state = {
            sourcePath: null, sourceHtml: "", resultHtml: "", js: "", scripts: 0,
            title: "", id: "", icon: "📦", accent: "#8e7cff", description: "",
            resizable: true, entry: "index.html", script: "app.js", idTouched: false,
          };

          body.innerHTML = `
            <div class="packager">
              <section class="packager__card">
                <h3 class="packager__title">1 · Source HTML</h3>
                <p class="muted" style="margin-top:0">
                  Choose one <b>.html</b> file from your sandbox. Every embedded
                  <span class="mono">&lt;script&gt;</span> block is pulled out into a single
                  <b>.js</b> file, leaving a clean document behind.
                </p>
                <div class="row">
                  <button class="btn btn--accent" data-source>📂 Choose a .html…</button>
                  <span class="chip muted" data-source-info>No file chosen</span>
                </div>
                <p class="muted" data-extract-info style="margin:8px 0 0"></p>
              </section>

              <section class="packager__card" data-meta-card hidden>
                <h3 class="packager__title">2 · App metadata</h3>
                <div class="packager__grid">
                  <label class="packager__field">
                    <span>App name</span>
                    <input class="field" data-title placeholder="My Cool App" />
                  </label>
                  <label class="packager__field">
                    <span>App id</span>
                    <input class="field mono" data-id placeholder="my-cool-app" />
                  </label>
                  <label class="packager__field packager__field--wide">
                    <span>Description</span>
                    <input class="field" data-desc placeholder="What does it do?" />
                  </label>
                  <label class="packager__field">
                    <span>Window title icon</span>
                    <input class="field" data-icon-input maxlength="8" placeholder="📦" />
                  </label>
                  <label class="packager__field">
                    <span>Accent colour</span>
                    <input class="packager__color" type="color" data-accent-input value="#8e7cff" />
                  </label>
                </div>

                <div class="packager__icons" data-icons></div>
                <div class="packager__accents" data-accents></div>

                <label class="packager__check">
                  <input type="checkbox" data-resizable checked /> Let the user resize this app's window
                </label>

                <details class="packager__advanced">
                  <summary>Advanced · file names</summary>
                  <div class="packager__grid" style="margin-top:10px">
                    <label class="packager__field">
                      <span>Entry (.html)</span>
                      <input class="field mono" data-entry value="index.html" />
                    </label>
                    <label class="packager__field">
                      <span>Script (.js)</span>
                      <input class="field mono" data-script value="app.js" />
                    </label>
                  </div>
                </details>
              </section>

              <section class="packager__card" data-meta-card hidden>
                <h3 class="packager__title">3 · Build it</h3>
                <div class="packager__preview" data-preview>
                  <span class="packager__preview-glyph" data-preview-glyph>📦</span>
                  <div style="flex:1">
                    <b data-preview-title>Untitled app</b><br />
                    <small class="muted" data-preview-desc>A ByteSize ZIP app</small>
                  </div>
                  <span class="chip mono" data-preview-id>app</span>
                </div>
                <div class="row" style="margin-top:12px">
                  <span class="muted" style="white-space:nowrap">Save as:</span>
                  <input class="field mono" data-zipname value="app.zip" style="max-width:220px" />
                </div>
                <div class="row" style="margin-top:10px">
                  <button class="btn btn--accent" data-install>📦 Build &amp; Install</button>
                  <button class="btn" data-save>💾 Save .zip only</button>
                  <span class="chip muted" data-status hidden></span>
                </div>
              </section>
            </div>`;

          const q = (selector) => body.querySelector(selector);
          const sourceInfo = q("[data-source-info]");
          const extractInfo = q("[data-extract-info]");
          const metaCards = body.querySelectorAll("[data-meta-card]");
          const status = q("[data-status]");
          const zipName = q("[data-zipname]");
          const titleInput = q("[data-title]");
          const idInput = q("[data-id]");
          const iconInput = q("[data-icon-input]");
          const accentInput = q("[data-accent-input]");
          const descInput = q("[data-desc]");
          const resizableInput = q("[data-resizable]");
          const entryInput = q("[data-entry]");
          const scriptInput = q("[data-script]");

          /* --- inline-script extraction --- */
          function extractInlineScripts(html) {
            const doc = new DOMParser().parseFromString(html, "text/html");
            const isJavaScript = (script) => {
              const type = (script.getAttribute("type") || "").trim().toLowerCase();
              return type === "" || type === "module"
                || type === "text/javascript" || type === "application/javascript"
                || type === "application/ecmascript" || type === "text/ecmascript";
            };
            const scripts = Array.from(doc.querySelectorAll("script"))
              .filter((script) => !script.getAttribute("src") && isJavaScript(script));
            const parts = [];
            scripts.forEach((script, index) => {
              parts.push(`/* --- embedded script #${index + 1} --- */\n${(script.textContent || "").trim()}`);
              script.remove();
            });
            return {
              html: "<!DOCTYPE html>\n" + doc.documentElement.outerHTML,
              js: parts.join("\n\n"),
              count: scripts.length,
              title: (doc.querySelector("title")?.textContent || "").trim(),
            };
          }

          function setTitle(value) {
            state.title = value;
            titleInput.value = value;
            if (!state.idTouched) {
              state.id = packagerSlug(value);
              idInput.value = state.id;
            }
            syncPreview();
          }

          function syncPreview() {
            body.querySelector("[data-preview-glyph]").innerHTML = state.icon || "📦";
            body.querySelector("[data-preview-title]").textContent = state.title || "Untitled app";
            body.querySelector("[data-preview-desc]").textContent = state.description || "A ByteSize ZIP app";
            body.querySelector("[data-preview-id]").textContent = state.id || "app";
            body.querySelector("[data-preview]").style.setProperty("--accent", state.accent);
            if (!zipName.dataset.touched) zipName.value = `${state.id || "app"}.zip`;
          }

          function setStatus(text, kind) {
            status.textContent = text || "";
            status.hidden = !text;
            status.style.background = kind === "error" ? "#ffe0e0" : kind === "good" ? "#e2ffe9" : "";
          }

          function registerInstalled(app) {
            const list = (Store.get("customApps", []) || []).filter((a) => a && a.id !== app.id);
            list.push({ ...app, installedAt: Date.now() });
            Store.set("customApps", list);
            const dockSet = new Set(dockIds());
            dockSet.add(app.id);
            Store.set("dock", [...dockSet]);
            renderDock();
            renderStartApps();
          }

          function applyExtraction(html, path) {
            const result = extractInlineScripts(html);
            state.sourceHtml = html;
            state.resultHtml = result.html;
            state.js = result.js || "/* No inline <script> was found in the source HTML. */";
            state.scripts = result.count;
            state.sourcePath = path;

            sourceInfo.textContent = `${baseName(path)} · ${fmtBytes(html.length)}`;
            extractInfo.innerHTML = result.count
              ? `Extracted <b>${result.count}</b> inline script${result.count === 1 ? "" : "s"} → <b class="mono">${esc(state.script)}</b> (${fmtBytes(state.js.length)}).`
              : `No inline <span class="mono">&lt;script&gt;</span> found — <b class="mono">${esc(state.script)}</b> will just hold a placeholder.`;

            if (!state.title) setTitle(result.title || baseName(path).replace(/\.[^.]+$/, ""));
            body.querySelectorAll("[data-meta-card]").forEach((card) => { card.hidden = false; });
            syncPreview();
          }

          async function build({ install }) {
            if (!state.sourcePath) {
              Toast.show("Choose an .html file first.", "error");
              return;
            }
            const title = state.title.trim();
            if (!title) {
              Toast.show("Give your app a name.", "error");
              return;
            }

            const id = packagerSlug(state.id) || packagerSlug(title) || "app";
            const requested = baseName(zipName.value.trim() || `${id}.zip`);
            const file = requested.toLowerCase().endsWith(".zip") ? requested : `${requested}.zip`;
            const outPath = joinPath("/Downloads", file);
            const entry = baseName(state.entry.trim() || "index.html");
            const script = baseName(state.script.trim() || "app.js");
            const metadata = JSON.stringify({
              title, id,
              icon: state.icon || "📦",
              accent: state.accent || "#8e7cff",
              description: state.description.trim(),
              resizable: state.resizable,
              entry, script,
            }, null, 2);

            setStatus("Building…", "");
            try {
              const packed = await invoke("app.package", {
                path: joinPath("/Downloads", file),
                metadata, entry, html: state.resultHtml, script, js: state.js,
              });
              if (install) {
                const result = await invoke("app.installZip", { path: packed.path });
                registerInstalled(result.app);
                setStatus(`Installed ${result.app.icon} ${result.app.title} → ${packed.path}`, "good");
                Toast.show(`Installed ${result.app.icon} ${result.app.title} — check your dock!`, "good", 4200);
              } else {
                setStatus(`Saved ${packed.path} (${fmtBytes(packed.size)})`, "good");
                Toast.show(`Saved ${packed.path}`, "good", 3600);
              }
            } catch (error) {
              setStatus(error.message, "error");
              Toast.show(error.message, "error", 6500);
            }
          }

          /* --- wiring --- */
          body.querySelector("[data-source]").onclick = async () => {
            const path = await FileDialog.show({ mode: "open", title: "Choose a .html file", startPath: "/Downloads" });
            if (!path) return;
            if (!/\.html?$/i.test(path)) {
              Toast.show("That isn't a .html file.", "error");
              return;
            }
            try {
              const file = await invoke("fs.readText", { path });
              applyExtraction(file.content, file.path || path);
              Toast.show(`Loaded ${baseName(path)}`, "good");
            } catch (error) {
              Toast.show(error.message, "error", 6500);
            }
          };

          const iconHost = body.querySelector("[data-icons]");
          PACKAGER_EMOJI.forEach((emoji) => {
            const button = el("button", "packager__icon", emoji);
            button.type = "button";
            button.classList.toggle("packager__icon--active", emoji === state.icon);
            button.onclick = () => {
              state.icon = emoji;
              iconInput.value = emoji;
              iconHost.querySelectorAll(".packager__icon").forEach((b) => {
                b.classList.toggle("packager__icon--active", b === button);
              });
              syncPreview();
            };
            iconHost.appendChild(button);
          });

          const accentHost = body.querySelector("[data-accents]");
          PACKAGER_ACCENTS.forEach((color) => {
            const swatch = el("button", "packager__accent");
            swatch.type = "button";
            swatch.dataset.color = color;
            swatch.style.background = color;
            swatch.title = color;
            swatch.classList.toggle("packager__accent--active", color.toLowerCase() === state.accent.toLowerCase());
            swatch.onclick = () => {
              state.accent = color;
              accentInput.value = color;
              accentHost.querySelectorAll(".packager__accent").forEach((s) => {
                s.classList.toggle("packager__accent--active", s.dataset.color === color);
              });
              syncPreview();
            };
            accentHost.appendChild(swatch);
          });

          titleInput.addEventListener("input", () => {
            state.title = titleInput.value;
            if (!state.idTouched) { state.id = packagerSlug(titleInput.value); idInput.value = state.id; }
            syncPreview();
          });
          idInput.addEventListener("input", () => {
            state.idTouched = true;
            state.id = packagerSlug(idInput.value);
            idInput.value = state.id;
            syncPreview();
          });
          iconInput.addEventListener("input", () => { state.icon = iconInput.value.trim(); syncPreview(); });
          accentInput.addEventListener("input", () => { state.accent = accentInput.value; syncPreview(); });
          descInput.addEventListener("input", () => { state.description = descInput.value; syncPreview(); });
          resizableInput.addEventListener("change", () => { state.resizable = resizableInput.checked; });
          entryInput.addEventListener("input", () => { state.entry = entryInput.value; });
          scriptInput.addEventListener("input", () => { state.script = scriptInput.value; });
          zipName.addEventListener("input", () => { zipName.dataset.touched = "1"; });

          body.querySelector("[data-install]").onclick = () => build({ install: true });
          body.querySelector("[data-save]").onclick = () => build({ install: false });

          api.onReopen = () => {};
          syncPreview();
        },
      });
    },
  };

  /* ---- Calculator -------------------------------------------------------- */
  Content.calc = {
    id: "calc", title: "Calculator", icon: "🧮", accent: "#4cc2ff",
    description: "Do the math, Family A style",
    open() {
      WM.open({
        id: "calc", title: "Calculator", icon: "🧮", accent: "#4cc2ff",
        width: 300, height: 440,
        resizable: false,
        render(body) {
          body.innerHTML = `
            <div class="calc">
              <div class="calc__screen" data-screen>0</div>
              <div class="calc__keys" data-keys></div>
            </div>`;
          const screen = body.querySelector("[data-screen]");
          const keys = body.querySelector("[data-keys]");
          let expr = "";

          const LAYOUT = ["C", "(", ")", "⌫", "7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", ".", "%", "+"];
          LAYOUT.forEach((label) => {
            const fn = ["C", "⌫"].includes(label) ? " calc__key--fn" : "";
            const btn = el("button", "calc__key" + fn, label);
            btn.onclick = () => press(label);
            keys.appendChild(btn);
          });
          const eq = el("button", "calc__key calc__key--eq", "=");
          eq.onclick = () => press("=");
          keys.appendChild(eq);

          function render() {
            screen.style.fontSize = expr.length > 20 ? "20px" : "34px";
            screen.textContent = expr || "0";
          }

          function press(label) {
            if (label === "C") { expr = ""; render(); return; }
            if (label === "⌫") { expr = expr.slice(0, -1); render(); return; }
            if (label === "=") { evaluate(); return; }
            expr += ({ "÷": "/", "×": "*", "−": "-" }[label] || label);
            render();
          }

          function evaluate() {
            const safe = expr.replace(/[^0-9+\-*/.()%]/g, "");
            if (!safe) return;
            try {
              expr = String(Number.isFinite(compute(safe)) ? Math.round(compute(safe) * 1e10) / 1e10 : "Error");
            } catch (error) {
              expr = "Error";
            }
            render();
          }

          // Tiny safe calculator parser (+ - * / % with parentheses and
          // unary minus). No eval/Function — CSP forbids 'unsafe-eval'.
          function compute(source) {
            let pos = 0;
            const next = () => source[pos];
            function expression() {
              let value = term();
              while (pos < source.length && (next() === "+" || next() === "-")) {
                const op = source[pos++];
                const rhs = term();
                value = op === "+" ? value + rhs : value - rhs;
              }
              return value;
            }
            function term() {
              let value = factor();
              while (pos < source.length && (next() === "*" || next() === "/")) {
                const op = source[pos++];
                const rhs = factor();
                value = op === "*" ? value * rhs : value / rhs;
              }
              return value;
            }
            function factor() {
              if (next() === "(") {
                pos++;
                const inner = expression();
                if (next() === ")") pos++;
                return inner;
              }
              if (next() === "-") {
                pos++;
                return -factor();
              }
              let num = "";
              while (pos < source.length && /[0-9.]/.test(source[pos])) num += source[pos++];
              if (num === "") throw new Error("bad expression");
              const value = parseFloat(num);
              if (next() === "%") {
                pos++;
                return value / 100;
              }
              return value;
            }
            return expression();
          }

          body.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); press("="); }
            else if (event.key === "Escape") { press("C"); }
            else if (event.key === "Backspace") { event.preventDefault(); press("⌫"); }
            else if (/^[0-9+\-*/.()%]$/.test(event.key)) press(event.key);
          });
          render();
        },
      });
    },
  };

  /* ---- Music (plays the songs in the sandbox /Music folder) -------------- */
  Content.music = {
    id: "music", title: "Music", icon: "🎵", accent: "#a55eea",
    description: "Play the songs in your /Music folder",
    open() {
      WM.open({
        id: "music", title: "Music", icon: "🎵", accent: "#a55eea",
        width: 520, height: 520,
        render(body, api) {
          body.innerHTML = `
            <div class="music">
              <div class="music__deck">
                <div class="music__art" data-art>🎵</div>
                <div class="music__now">
                  <b data-title>—</b>
                  <small class="muted" data-sub>Scanning /Music…</small>
                </div>
                <div class="music__eq"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
              </div>
              <div class="music__controls">
                <button class="btn" data-prev title="Previous">⏮</button>
                <button class="btn btn--accent music__play" data-play title="Play / pause">▶</button>
                <button class="btn" data-next title="Next">⏭</button>
                <button class="btn" data-refresh title="Rescan /Music">⟳</button>
                <input class="music__vol" type="range" data-vol min="0" max="1" step="0.05" value="0.8" aria-label="Volume" />
              </div>
              <div class="music__seek">
                <span class="music__time" data-cur>0:00</span>
                <input type="range" data-seek min="0" max="1000" step="1" value="0" aria-label="Seek" />
                <span class="music__time" data-dur>0:00</span>
              </div>
              <div class="music__tracks" data-tracks></div>
            </div>`;

          const artEl = body.querySelector("[data-art]");
          const titleEl = body.querySelector("[data-title]");
          const subEl = body.querySelector("[data-sub]");
          const tracksEl = body.querySelector("[data-tracks]");
          const playBtn = body.querySelector("[data-play]");
          const volInput = body.querySelector("[data-vol]");
          const seekInput = body.querySelector("[data-seek]");
          const curEl = body.querySelector("[data-cur]");
          const durEl = body.querySelector("[data-dur]");
          const root = body.querySelector(".music");

          const AUDIO_DIR = "/Music";
          const MEDIA_HOST = "https://media.bytesizeos.local";
          const AUDIO_EXT = ["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "webm"];

          const audio = document.createElement("audio");
          audio.preload = "metadata";
          audio.volume = Number(volInput.value) || 0.8;

          let tracks = [];
          let trackIdx = -1;
          let retriedViaBridge = false;

          const isAudio = (name) => {
            const dot = String(name).lastIndexOf(".");
            return dot > 0 && AUDIO_EXT.includes(name.slice(dot + 1).toLowerCase());
          };
          const mediaUrl = (path) =>
            MEDIA_HOST + "/" + String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
          const fmtTime = (sec) => {
            if (!isFinite(sec) || sec < 0) return "0:00";
            return Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
          };
          const fmtSize = (bytes) => {
            const n = Number(bytes) || 0;
            if (n < 1024) return n + " B";
            if (n < 1048576) return Math.round(n / 1024) + " KB";
            return (n / 1048576).toFixed(1) + " MB";
          };

          function renderTracks() {
            tracksEl.innerHTML = "";
            if (!tracks.length) {
              const empty = el("div", "music__empty");
              empty.innerHTML = `No songs yet. Drop audio files (MP3, WAV, OGG…) into the <b>/Music</b> folder, then press ⟳.`;
              tracksEl.appendChild(empty);
              return;
            }
            tracks.forEach((track, index) => {
              const row = el("button", "music__track" + (index === trackIdx ? " music__track--active" : ""));
              row.innerHTML = `<span>🎵</span><span class="music__track-name">${esc(track.name)}</span><small class="muted">${fmtSize(track.size)}</small>`;
              row.onclick = () => selectTrack(index, true);
              tracksEl.appendChild(row);
            });
          }

          function refreshHeader() {
            const track = tracks[trackIdx];
            artEl.textContent = "🎵";
            titleEl.textContent = track ? track.name : "—";
            if (!tracks.length) subEl.textContent = "Empty /Music folder";
            else if (track) subEl.textContent = `${trackIdx + 1} of ${tracks.length} · ${audio.paused ? "paused" : "playing"}`;
            else subEl.textContent = `${tracks.length} song${tracks.length === 1 ? "" : "s"} in /Music — pick one`;
          }

          function selectTrack(index, autoplay) {
            if (!tracks.length) return;
            trackIdx = ((index % tracks.length) + tracks.length) % tracks.length;
            retriedViaBridge = false;
            audio.src = mediaUrl(tracks[trackIdx].path);
            seekInput.value = "0";
            curEl.textContent = "0:00";
            durEl.textContent = "0:00";
            renderTracks();
            refreshHeader();
            if (autoplay) play();
          }

          function play() {
            if (!tracks.length) return;
            audio.play().catch((error) => {
              subEl.textContent = "Can't play this file" + (error && error.message ? " — " + error.message : "");
            });
          }

          function toggle() {
            if (!tracks.length) return;
            if (trackIdx < 0) { selectTrack(0, true); return; }
            if (audio.paused) play();
            else audio.pause();
          }

          async function scan() {
            subEl.textContent = "Scanning /Music…";
            const currentPath = tracks[trackIdx] ? tracks[trackIdx].path : null;
            let found = [];
            try {
              const listing = await invoke("fs.list", { path: AUDIO_DIR });
              found = (listing.entries || [])
                .filter((entry) => !entry.isDirectory && isAudio(entry.name))
                .map((entry) => ({ name: entry.name, path: entry.path, size: entry.size }));
            } catch (_) {
              found = [];
            }
            tracks = found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
            const keep = currentPath ? tracks.findIndex((t) => t.path === currentPath) : -1;
            if (keep >= 0) trackIdx = keep;
            else if (trackIdx >= tracks.length) trackIdx = tracks.length ? 0 : -1;
            renderTracks();
            refreshHeader();
          }

          audio.addEventListener("play", () => {
            root.classList.add("music--playing");
            playBtn.textContent = "⏸";
            refreshHeader();
          });
          audio.addEventListener("pause", () => {
            root.classList.remove("music--playing");
            playBtn.textContent = "▶";
            if (trackIdx >= 0) refreshHeader();
          });
          audio.addEventListener("ended", () => {
            if (tracks.length) selectTrack(trackIdx + 1, true);
          });
          audio.addEventListener("loadedmetadata", () => {
            durEl.textContent = fmtTime(audio.duration);
            seekInput.value = "0";
          });
          audio.addEventListener("timeupdate", () => {
            curEl.textContent = fmtTime(audio.currentTime);
            if (audio.duration) seekInput.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
          });
          audio.addEventListener("error", async () => {
            const track = tracks[trackIdx];
            if (!track) return;
            // The media host streams the file; if that failed, read it over the
            // bridge as a data URL instead.
            if (!retriedViaBridge) {
              retriedViaBridge = true;
              subEl.textContent = "Trying another way…";
              try {
                const file = await invoke("fs.readDataUrl", { path: track.path });
                audio.src = file.dataUrl;
                audio.load();
                play();
                return;
              } catch (_) { /* fall through */ }
            }
            root.classList.remove("music--playing");
            playBtn.textContent = "▶";
            subEl.textContent = `Can't play “${track.name}” — unsupported format?`;
          });

          playBtn.onclick = toggle;
          body.querySelector("[data-prev]").onclick = () => selectTrack(trackIdx - 1, !audio.paused || trackIdx < 0);
          body.querySelector("[data-next]").onclick = () => selectTrack(trackIdx + 1, !audio.paused || trackIdx < 0);
          body.querySelector("[data-refresh]").onclick = () => { audio.pause(); scan(); };
          volInput.addEventListener("input", () => { audio.volume = Number(volInput.value) || 0; });
          seekInput.addEventListener("input", () => {
            if (audio.duration) audio.currentTime = (Number(seekInput.value) / 1000) * audio.duration;
          });

          api.onClose(() => {
            audio.pause();
            audio.removeAttribute("src");
            try { audio.load(); } catch (_) { /* ignore */ }
          });

          scan();
        },
      });
    },
  };

  /* ---- Clock ------------------------------------------------------------- */
  Content.clock = {
    id: "clock", title: "Clock", icon: "🕒", accent: "#ffd000",
    description: "Time, date and a tiny calendar",
    open() {
      WM.open({
        id: "clock", title: "Clock", icon: "🕒", accent: "#ffd000",
        width: 340, height: 500,
        render(body, api) {
          const ticks = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => {
            const a = deg * Math.PI / 180;
            const inner = 80, outer = 90;
            return `<line class="clock__tick" x1="${(100 + inner * Math.sin(a)).toFixed(1)}" y1="${(100 - inner * Math.cos(a)).toFixed(1)}" x2="${(100 + outer * Math.sin(a)).toFixed(1)}" y2="${(100 - outer * Math.cos(a)).toFixed(1)}"></line>`;
          }).join("");

          body.innerHTML = `
            <div class="clock">
              <svg class="clock__face" viewBox="0 0 200 200" aria-label="Analog clock">
                <circle class="clock__rim" cx="100" cy="100" r="94"></circle>
                ${ticks}
                <line class="clock__hand clock__hand--h" data-hand="h" x1="100" y1="100" x2="100" y2="58"></line>
                <line class="clock__hand clock__hand--m" data-hand="m" x1="100" y1="100" x2="100" y2="34"></line>
                <line class="clock__hand clock__hand--s" data-hand="s" x1="100" y1="100" x2="100" y2="28"></line>
                <circle class="clock__hub" cx="100" cy="100" r="4"></circle>
              </svg>
              <div class="clock__digital" data-time>--:--:--</div>
              <div class="clock__date" data-date>—</div>
              <div class="clock__cal" data-cal></div>
              <div class="clock__alarm">
                <b>⏰ Alarm</b>
                <input type="time" data-alarm value="07:00" />
                <button class="btn" data-set-alarm>Set</button>
                <button class="btn" data-clear-alarm>Clear</button>
                <span data-alarm-status></span>
              </div>
            </div>`;

          const timeEl = body.querySelector("[data-time]");
          const dateEl = body.querySelector("[data-date]");
          const calEl = body.querySelector("[data-cal]");

          function renderCalendar(now) {
            const year = now.getFullYear();
            const month = now.getMonth();
            const firstWeekday = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const today = now.getDate();
            let html = `<div class="clock__cal-head">${now.toLocaleDateString([], { month: "long", year: "numeric" })}</div>`;
            html += `<div class="clock__cal-week">`;
            ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].forEach((d) => { html += `<span>${d}</span>`; });
            html += `</div><div class="clock__cal-grid">`;
            for (let i = 0; i < firstWeekday; i++) html += `<span></span>`;
            for (let day = 1; day <= daysInMonth; day++) html += `<span class="${day === today ? "clock__cal-today" : ""}">${day}</span>`;
            html += `</div>`;
            calEl.innerHTML = html;
          }

          function tick() {
            const now = new Date();
            timeEl.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            dateEl.textContent = now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
            const hDeg = (now.getHours() % 12) * 30 + now.getMinutes() * 0.5;
            const mDeg = now.getMinutes() * 6 + now.getSeconds() * 0.1;
            const sDeg = now.getSeconds() * 6;
            body.querySelector('[data-hand="h"]').setAttribute("transform", `rotate(${hDeg} 100 100)`);
            body.querySelector('[data-hand="m"]').setAttribute("transform", `rotate(${mDeg} 100 100)`);
            body.querySelector('[data-hand="s"]').setAttribute("transform", `rotate(${sDeg} 100 100)`);
            renderCalendar(now);
          }

          tick();
          const timer = setInterval(tick, 1000);

          const alarmInput = body.querySelector("[data-alarm]");
          const alarmStatus = body.querySelector("[data-alarm-status]");
          let alarmTime = null;
          let alarmFired = false;

          const say = (text, tone) => {
            alarmStatus.textContent = text;
            alarmStatus.dataset.tone = tone;
          };

          body.querySelector("[data-set-alarm]").onclick = () => {
            alarmTime = alarmInput.value;
            alarmFired = false;
            say(`Alarm set for ${alarmTime}`, "good");
          };
          body.querySelector("[data-clear-alarm]").onclick = () => {
            alarmTime = null;
            alarmFired = false;
            say("Cleared", "muted");
          };

          const alarmCheck = setInterval(() => {
            if (!alarmTime || alarmFired) return;
            const now = new Date();
            const [h, m] = alarmTime.split(":").map(Number);
            if (now.getHours() === h && now.getMinutes() === m && now.getSeconds() < 3) {
              alarmFired = true;
              say("⏰ Ringing!", "bad");
              Toast.show("Alarm! ⏰", "good");
            }
          }, 1000);

          api.onClose(() => { clearInterval(timer); clearInterval(alarmCheck); });
        },
      });
    },
  };

  /* ---- DOOM (real WebAssembly port — DOOM shareware) --------------------- */
  Content.doom = {
    id: "doom", title: "DOOM", icon: "🛸", accent: "#e84f4f",
    description: "The classic 1993 shooter — real WebAssembly port",
    open() {
      WM.open({
        id: "doom", title: "DOOM", icon: "🛸", accent: "#e84f4f",
        width: 920, height: 660,
        render(body) {
          body.style.padding = "0";
          body.style.overflow = "hidden";
          body.style.background = "#000";
          const frame = document.createElement("iframe");
          frame.className = "doom-frame";
          frame.title = "DOOM";
          frame.src = "/apps/doom/doom.html";
          frame.setAttribute("allow", "fullscreen");
          frame.style.cssText = "width:100%;height:100%;border:0;background:#000;display:block;";
          body.appendChild(frame);
        },
      });
    },
  };

  /* ---- Code Studio (C, C++, Rust, C#) ------------------------------------ */
  const STUDIO_LANGS = [
    { id: "c", label: "C" },
    { id: "cpp", label: "C++" },
    { id: "rust", label: "Rust" },
    { id: "csharp", label: "C#" },
  ];
  const STUDIO_TEMPLATES = {
    c: '#include <stdio.h>\n\nint main(void) {\n    printf("Hello from C!\\n");\n    return 0;\n}\n',
    cpp: '#include <iostream>\n\nint main() {\n    std::cout << "Hello from C++!" << std::endl;\n    return 0;\n}\n',
    rust: 'fn main() {\n    println!("Hello from Rust!");\n}\n',
    csharp: 'using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine("Hello from C#!");\n    }\n}\n',
  };
  Content.studio = {
    id: "studio", title: "Code Studio", icon: "💻", accent: "#00b8a9",
    description: "Write & run C, C++, Rust and C#",
    open() {
      WM.open({
        id: "studio", title: "Code Studio", icon: "💻", accent: "#00b8a9",
        width: 800, height: 660,
        render(body) {
          let language = STUDIO_LANGS.some((lang) => lang.id === Store.get("studioLanguage", "c"))
            ? Store.get("studioLanguage", "c")
            : "c";
          const codes = { ...(Store.get("studioCode", {}) || {}) };
          let toolchains = {};
          let running = false;

          function codeFor(id) {
            if (typeof codes[id] !== "string") codes[id] = STUDIO_TEMPLATES[id] || "";
            return codes[id];
          }

          body.innerHTML = `
            <div class="studio">
              <div class="studio__tabs" data-langs></div>
              <div class="studio__toolbar">
                <button class="btn btn--run" data-run>▶ Run</button>
                <label class="studio__admin" title="Without admin, programs run sandboxed to your home folder">
                  <input type="checkbox" data-admin /> Run as admin
                </label>
                <span class="studio__status muted" data-status></span>
              </div>
              <textarea class="studio__editor mono" data-editor spellcheck="false" autocomplete="off"></textarea>
              <pre class="studio__output mono" data-output>Ready. Pick a language and press Run.</pre>
            </div>`;

          const langsHost = $("[data-langs]", body);
          const editor = $("[data-editor]", body);
          const output = $("[data-output]", body);
          const statusEl = $("[data-status]", body);
          const adminBox = $("[data-admin]", body);
          const runButton = $("[data-run]", body);

          function setStatus(text, tone) {
            statusEl.textContent = text || "";
            statusEl.className = `studio__status ${tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "muted"}`;
          }

          function renderTabs() {
            langsHost.innerHTML = "";
            STUDIO_LANGS.forEach((lang) => {
              const info = toolchains[lang.id];
              const button = el("button", `option ${language === lang.id ? "option--active" : ""}`, lang.label);
              if (info && !info.available) {
                button.classList.add("option--unavailable");
                button.title = `No ${lang.label} toolchain found on this PC`;
              }
              button.onclick = () => {
                codes[language] = editor.value;
                language = lang.id;
                Store.set("studioLanguage", language);
                Store.set("studioCode", codes);
                editor.value = codeFor(language);
                renderTabs();
                refreshStatus();
              };
              langsHost.appendChild(button);
            });
          }

          function refreshStatus() {
            const info = toolchains[language];
            if (!info) { setStatus(""); return; }
            setStatus(info.available ? `Compiler: ${info.compiler}` : `No ${info.label} toolchain installed`, info.available ? "good" : "bad");
          }

          async function loadToolchains() {
            try {
              const result = await invoke("studio.toolchains");
              toolchains = {};
              (result.toolchains || []).forEach((entry) => { toolchains[entry.id] = entry; });
            } catch { toolchains = {}; }
            renderTabs();
            refreshStatus();
          }

          async function runCode() {
            if (running) return;
            codes[language] = editor.value;
            Store.set("studioCode", codes);
            running = true;
            runButton.disabled = true;
            adminBox.disabled = true;
            setStatus("Compiling…", "muted");
            output.textContent = "Compiling and running…";
            const started = performance.now();
            try {
              const result = await invoke("studio.run", { language, code: editor.value, admin: adminBox.checked }, 180000);
              const seconds = (((result.elapsedMs ?? (performance.now() - started))) / 1000).toFixed(1);
              const mode = result.admin ? "admin" : "sandboxed";
              const header = result.ok
                ? `✔ ${result.language} ${mode} · finished in ${seconds}s`
                : `✖ ${result.language} ${mode} · ${result.stage} ${result.timedOut ? "timed out" : "failed"} in ${seconds}s`;
              output.textContent = `${header}\n\n${result.output || "(no output)"}`;
              output.scrollTop = 0;
              setStatus(result.ok ? "Done" : "Failed", result.ok ? "good" : "bad");
            } catch (error) {
              output.textContent = error.message;
              setStatus("Error", "bad");
            } finally {
              running = false;
              runButton.disabled = false;
              adminBox.disabled = false;
            }
          }

          runButton.onclick = runCode;
          editor.value = codeFor(language);
          editor.addEventListener("input", () => {
            codes[language] = editor.value;
            Store.set("studioCode", codes);
          });
          editor.addEventListener("keydown", (event) => {
            if (event.key === "Tab") {
              event.preventDefault();
              const start = editor.selectionStart;
              const end = editor.selectionEnd;
              editor.value = `${editor.value.slice(0, start)}    ${editor.value.slice(end)}`;
              editor.selectionStart = editor.selectionEnd = start + 4;
            }
          });

          renderTabs();
          loadToolchains();
        },
      });
    },
  };

  /* ---- Settings ---------------------------------------------------------- */
  const WALLPAPER_PRESETS = [
    { id: "kat", name: "Kat (Default)", thumb: "/assets/wallpapers/katdefaultbackground.png" },
    { id: "blueprint", name: "Classic Blueprint Grid", cls: "wallpaper-card__thumb--blueprint" },
  ];
  const FONTS = [
    { id: "comic", name: "Comic", value: '"Comic Sans MS","Chalkboard SE","Comic Neue",cursive' },
    { id: "print", name: "Hand-drawn", value: '"Segoe Print","Bradley Hand",cursive' },
    { id: "mono", name: "Pixel-ish", value: '"Lucida Console","Cascadia Code",monospace' },
    { id: "arial", name: "Arial", value: '"Arial","Helvetica Neue","sans-serif"' },
  ];
  const WINDOW_STYLES = [
    { id: "drawn", name: "Drawn" },
    { id: "bubbly", name: "Bubbly" },
    { id: "1995", name: "1995" },
    { id: "squares", name: "Squares" },
  ];

  Content.settings = {
    id: "settings", title: "Settings", icon: "⚙️", accent: "#6c5ce7",
    description: "Look and feel",
    open() {
      WM.open({
        id: "settings", title: "Settings", icon: "⚙️", accent: "#6c5ce7",
        width: 620, height: 560,
        render(body, api) {
          api.onReopen = () => renderSettings();
          function renderSettings() {
            const current = currentSettings();
            const wp = currentWallpaper();
            body.innerHTML = `
              <div class="tabs">
                <button class="tab tab--active" data-tab="wallpaper">🎨 Wallpaper</button>
                <button class="tab" data-tab="appearance">🔤 Appearance</button>
              </div>
              <div data-panel="wallpaper"></div>
              <div data-panel="appearance" hidden></div>`;

            const tabs = body.querySelectorAll(".tab");
            tabs.forEach((tab) => {
              tab.onclick = () => {
                tabs.forEach((t) => t.classList.toggle("tab--active", t === tab));
                body.querySelectorAll("[data-panel]").forEach((panel) => {
                  panel.hidden = panel.dataset.panel !== tab.dataset.tab;
                });
              };
            });

            /* ---- Wallpaper tab ---- */
            const wpPanel = body.querySelector('[data-panel="wallpaper"]');
            wpPanel.innerHTML = `
              <div class="wallpaper-grid" data-presets></div>
              <div class="setting-block" style="margin-top:14px">
                <h3>🖼️ Custom wallpaper</h3>
                <p class="muted" style="margin-top:0">Pick an image from <b>/Wallpapers</b> inside your home storage, or upload one — it gets copied into <b>/Wallpapers</b> so the OS never reads your real drives.</p>
                <div class="row">
                  <button class="btn" data-browse>📂 Browse /Wallpapers</button>
                  <label class="btn" style="cursor:pointer">⬆️ Upload image<input type="file" accept="image/*" data-upload hidden></label>
                </div>
                <p class="muted mono" data-current style="margin-bottom:0"></p>
              </div>`;

            const presets = wpPanel.querySelector("[data-presets]");
            WALLPAPER_PRESETS.forEach((preset) => {
              const active = wp.type === "preset" && wp.id === preset.id;
              const card = el("button", `wallpaper-card ${active ? "wallpaper-card--active" : ""}`);
              card.innerHTML = `<div class="wallpaper-card__thumb"></div><div class="wallpaper-card__label">${esc(preset.name)}</div>`;
              const thumb = card.querySelector(".wallpaper-card__thumb");
              if (preset.cls) {
                thumb.classList.add(preset.cls);
              } else {
                thumb.style.backgroundImage = `url("${preset.thumb}")`;
                thumb.style.backgroundSize = "cover";
                thumb.style.backgroundPosition = "center";
              }
              card.onclick = async () => {
                Store.set("wallpaper", { type: "preset", id: preset.id });
                await applyWallpaper();
                renderSettings();
              };
              presets.appendChild(card);
            });

            wpPanel.querySelector("[data-browse]").onclick = async () => {
              const path = await FileDialog.show({ mode: "open", title: "Choose a wallpaper", startPath: "/Wallpapers" });
              if (!path) return;
              if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) {
                Toast.show("Pick an image file (.png, .jpg, .gif, .webp, .bmp).", "error");
                return;
              }
              Store.set("wallpaper", { type: "custom", path });
              await applyWallpaper();
              renderSettings();
            };

            wpPanel.querySelector("[data-upload]").onchange = (event) => {
              const file = event.target.files && event.target.files[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = async () => {
                try {
                  const safe = file.name.replace(/[^a-z0-9._-]/gi, "_") || "upload.png";
                  const targetPath = `/Wallpapers/upload-${Date.now()}-${safe}`;
                  await invoke("fs.writeBytes", { path: targetPath, base64: String(reader.result) });
                  Store.set("wallpaper", { type: "custom", path: targetPath });
                  await applyWallpaper();
                  Toast.show("Wallpaper uploaded to /Wallpapers!", "good");
                  renderSettings();
                } catch (error) {
                  Toast.show(error.message, "error");
                }
              };
              reader.readAsDataURL(file);
            };

            const wpName = wp.type === "custom"
              ? wp.path
              : (WALLPAPER_PRESETS.find((p) => p.id === wp.id) || WALLPAPER_PRESETS[0]).name;
            wpPanel.querySelector("[data-current]").textContent = `Current: ${wpName}`;

            /* ---- Appearance tab ---- */
            const apPanel = body.querySelector('[data-panel="appearance"]');
            apPanel.innerHTML = `
              <div class="setting-block">
                <h3>🔤 Font style</h3>
                <div class="option-grid" data-fonts></div>
              </div>
              <div class="setting-block">
                <h3>🪟 Window style</h3>
                <div class="option-grid" data-window-styles></div>
              </div>
              <div class="setting-block">
                <h3>🌗 Theme</h3>
                <div class="option-grid">
                  <button class="option ${current.theme === "light" ? "option--active" : ""}" data-theme-choice="light">☀️ Light</button>
                  <button class="option ${current.theme === "dark" ? "option--active" : ""}" data-theme-choice="dark">🌙 Dark</button>
                </div>
              </div>
              <div class="setting-block">
                <h3>🏷️ Dock labels</h3>
                <div class="option-grid">
                  <button class="option ${current.labels ? "option--active" : ""}" data-labels="true">Show</button>
                  <button class="option ${current.labels ? "" : "option--active"}" data-labels="false">Hide</button>
                </div>
              </div>
              <div class="setting-block">
                <h3>🔍 Zoom</h3>
                <div class="option-grid" data-zoom></div>
              </div>
              <button class="btn btn--danger" data-reset>♻️ Reset everything</button>`;

            const fontHost = apPanel.querySelector("[data-fonts]");
            FONTS.forEach((font) => {
              const option = el("button", `option ${current.font === font.id ? "option--active" : ""}`, font.name);
              option.onclick = () => { saveSettings({ font: font.id }); applySettings(); renderSettings(); };
              fontHost.appendChild(option);
            });

            const styleHost = apPanel.querySelector("[data-window-styles]");
            WINDOW_STYLES.forEach((style) => {
              const option = el("button", `option ${current.windowStyle === style.id ? "option--active" : ""}`, style.name);
              option.onclick = () => { saveSettings({ windowStyle: style.id }); applySettings(); renderSettings(); };
              styleHost.appendChild(option);
            });

            apPanel.querySelectorAll("[data-theme-choice]").forEach((button) => {
              button.onclick = () => { saveSettings({ theme: button.dataset.themeChoice }); applySettings(); renderSettings(); };
            });

            apPanel.querySelectorAll("[data-labels]").forEach((button) => {
              button.onclick = () => { saveSettings({ labels: button.dataset.labels === "true" }); applySettings(); renderSettings(); };
            });

            const zoomHost = apPanel.querySelector("[data-zoom]");
            const ZOOM_PRESETS = [
              { label: "1×", factor: 1 },
              { label: "0.75×", factor: 0.75 },
              { label: "0.50×", factor: 0.5 },
              { label: "0.25×", factor: 0.25 },
            ];
            ZOOM_PRESETS.forEach((zoom) => {
              const option = el("button", `option ${current.zoom === zoom.factor ? "option--active" : ""}`, zoom.label);
              option.onclick = () => { saveSettings({ zoom: zoom.factor }); applySettings(); renderSettings(); };
              zoomHost.appendChild(option);
            });

            apPanel.querySelector("[data-reset]").onclick = () => {
              ["wallpaper", "font", "labels", "windowStyle", "theme", "dock", "customApps", "snakeBest", "tetrisBest", "studioLanguage", "studioCode", "zoom"].forEach((key) => Store.remove(key));
              applySettings();
              applyWallpaper();
              renderDock();
              renderStartApps();
              renderSettings();
              Toast.show("Settings reset. Fresh as a daisy!", "good");
            };
          }
          renderSettings();
        },
      });
    },
  };

  /* ---- About ------------------------------------------------------------- */
  /* ---- KatGPT (ask anything; receive meows) ------------------------------ */
  Content.katgpt = {
    id: "katgpt", title: "KatGPT", icon: "🐱", accent: "#ff7ac2",
    description: "Ask anything. Get meows.",
    open() {
      WM.open({
        id: "katgpt", title: "KatGPT", icon: "🐱", accent: "#ff7ac2",
        width: 620, height: 560,
        render(body, api) {
          body.innerHTML = `
            <div class="katgpt">
              <div class="katgpt__log" data-log>
                <div class="katgpt__msg katgpt__msg--bot">
                  <div class="katgpt__avatar">🐱</div>
                  <div class="katgpt__bubble">Hi, I'm <b>KatGPT</b>. Ask me anything and I'll answer in meows. 🐾</div>
                </div>
              </div>
              <form class="katgpt__composer" data-form>
                <input class="katgpt__input" data-input placeholder="Ask KatGPT anything…" autocomplete="off" spellcheck="false" />
                <button class="btn katgpt__send" type="submit">Send 🐾</button>
              </form>
            </div>`;

          const log = body.querySelector("[data-log]");
          const form = body.querySelector("[data-form]");
          const input = body.querySelector("[data-input]");
          const scroll = () => { log.scrollTop = log.scrollHeight; };

          function addMessage(role, build) {
            const msg = el("div", `katgpt__msg katgpt__msg--${role}`);
            msg.appendChild(el("div", "katgpt__avatar", role === "user" ? "🧑" : "🐱"));
            const bubble = el("div", "katgpt__bubble");
            build(bubble);
            msg.appendChild(bubble);
            log.appendChild(msg);
            scroll();
            return bubble;
          }

          function answer() {
            // The entire state of the art: a random pile of meows, 1–426 of them.
            const count = 1 + Math.floor(Math.random() * 426);
            const bubble = addMessage("bot", (b) => {
              b.innerHTML = `<span class="katgpt__typing">${"meow ".repeat(Math.min(count, 3)).trim()}…</span>`;
            });
            setTimeout(() => {
              bubble.textContent = Array(count).fill("meow").join(" ");
              scroll();
            }, 420);
          }

          form.addEventListener("submit", (event) => {
            event.preventDefault();
            const value = input.value.trim();
            if (!value) { return; }
            addMessage("user", (b) => { b.textContent = value; });
            input.value = "";
            answer();
          });

          api.onReopen = () => input.focus();
          input.focus();
        },
      });
    },
  };

  Content.about = {
    id: "about", title: "About OS", icon: "💠", accent: "#00cec9",
    description: "Version and system info",
    open() {
      WM.open({
        id: "about", title: "About ByteSize OS", icon: "💠", accent: "#00cec9",
        width: 600, height: 480,
        render(body) {
          body.innerHTML = `
            <div class="about">
              <div class="about__hero">
                <div class="about__logo">B</div>
                <div>
                  <div style="font-size:22px;font-weight:800">ByteSize OS</div>
                  <div class="muted">Fast · Lightweight · Powerful · Goofy</div>
                </div>
              </div>
              <dl class="about__facts" data-facts><dt>Loading…</dt><dd></dd></dl>
            </div>`;

          invoke("os.info").then((info) => {
            const rows = [
              ["Version", info.version],
              ["Machine", `${info.machine} (${info.user})`],
              ["Operating system", info.os],
              ["Architecture", `${info.osArchitecture} · process ${info.processArchitecture}`],
              ["Processors", info.processors],
              ["Runtime", info.runtime],
              ["Uptime", fmtUptime(info.uptimeSeconds)],
              ["App memory", fmtBytes(info.workingSetBytes)],
              ["Process id", info.pid],
              ["Home storage", info.storageRoot || "—"],
              ["Made with", "C# + HTML, zero frameworks 💛"],
            ];
            body.querySelector("[data-facts]").innerHTML = rows
              .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
          }).catch((error) => {
            body.querySelector("[data-facts]").innerHTML = `<dt>Error</dt><dd>${esc(error.message)}</dd>`;
          });
        },
      });
    },
  };

  /* ======================================================================
     Installed apps (ZIP) — runtime + launcher
     ====================================================================== */
  let latestInstalledWindow = null;

  // Injected into every installed ZIP app: console logging + a window.bs
  // bridge proxy (postMessage -> invoke -> C#).
  const APP_RUNTIME = `
(function () {
  if (window.bs && window.bs._katStudio) return;
  var seq = 0;
  function pump(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var v = args[i];
      if (typeof v === "string") parts.push(v);
      else { try { parts.push(JSON.stringify(v)); } catch (e) { parts.push(String(v)); } }
    }
    parent.postMessage({ katStudio: true, type: "log", level: level, text: parts.join(" ") }, "*");
  }
  ["log", "info", "warn", "error"].forEach(function (l) {
    var orig = console[l];
    console[l] = function () { pump(l, arguments); if (orig) orig.apply(console, arguments); };
  });
  window.addEventListener("error", function (e) {
    pump("error", [(e.message || "Error") + (e.lineno ? "  (line " + e.lineno + ")" : "")]);
    var err = e.error || {};
    parent.postMessage({ katStudio: true, type: "katcheck", message: e.message || "Script error", module: (e.filename || "app.js").split("/").pop(), stack: (err && err.stack) ? String(err.stack) : "" }, "*");
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason || {};
    pump("error", ["Uncaught promise rejection: " + (r && r.message ? r.message : String(r))]);
    parent.postMessage({ katStudio: true, type: "katcheck", message: "Unhandled promise rejection: " + (r && r.message ? r.message : String(r)), module: "app.js", stack: (r && r.stack) ? String(r.stack) : "" }, "*");
  });
  window.bs = {
    _katStudio: true,
    invoke: function (type, payload) {
      return new Promise(function (resolve, reject) {
        var id = "c" + (++seq) + "-" + Math.random().toString(36).slice(2);
        var onMsg = function (e) {
          var m = e.data;
          if (m && m.katStudio === true && m.type === "invokeReply" && m.callId === id) {
            window.removeEventListener("message", onMsg);
            if (m.ok) resolve(m.data); else reject(new Error(m.error || "bridge call failed"));
          }
        };
        window.addEventListener("message", onMsg);
        parent.postMessage({ katStudio: true, type: "invoke", callId: id, cmd: type, payload: payload === undefined ? null : payload }, "*");
      });
    },
    setTitle: function (t) { parent.postMessage({ katStudio: true, type: "setTitle", text: String(t) }, "*"); },
    requestPointerLock: function (element) {
      var el = element || document.body;
      return el.requestPointerLock ? el.requestPointerLock() : null;
    },
    exitPointerLock: function () { if (document.exitPointerLock) { document.exitPointerLock(); } },
    setResizable: function (value) { parent.postMessage({ katStudio: true, type: "setResizable", value: value !== false }, "*"); }
  };
})();
`;

  // Lightweight styling for installed apps whose index.html is a fragment.
  const APP_FRAGMENT_CSS = `
:root { --accent: #4cc2ff; }
body { margin: 0; font-family: "Comic Sans MS", "Chalkboard SE", cursive; color: #17181c; min-height: 100vh; background: #fdf6ec; }
button { font-family: inherit; cursor: pointer; }
.text-muted { color: #6b6f78; }
.inst-card { border: 3px solid #17181c; border-radius: 12px; background: #fff; padding: 10px 14px; box-shadow: 4px 4px 0 rgba(23, 24, 28, .25); }
`;

  // A ZIP app's own .js is re-embedded in a <script> tag; escape a closing tag
  // if the author ever wrote one.
  const escapeScriptTag = (source) => String(source || "").replace(/<\/script/gi, "<\\/script");

  // Build a runnable full document from a ZIP app's html + js.
  function buildAppDocument(app) {
    const trimmed = String(app.html || "").trim();
    const runtimeTag = `<script>${APP_RUNTIME}</script>`;
    const appTag = `<script>${escapeScriptTag(app.js || "")}</script>`;
    if (/^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
      let doc = trimmed;
      if (/<head[\s>]/i.test(doc)) doc = doc.replace(/<head[^>]*>/i, (match) => `${match}\n${runtimeTag}`);
      else doc = runtimeTag + "\n" + doc;
      if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, `${appTag}\n</body>`);
      else doc += appTag;
      return doc;
    }
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${APP_FRAGMENT_CSS}</style>
${runtimeTag}
</head>
<body class="kat-app">
${trimmed || '<p class="text-muted">This app has no content yet.</p>'}
${appTag}
</body>
</html>`;
  }

  // Global listener: installed-app iframes talk back through postMessage.
  function handleAppMessage(event) {
    const m = event.data;
    if (!m || m.katStudio !== true) return;
    if (m.type === "log") {
      const send = m.level === "error" ? console.error : m.level === "warn" ? console.warn : console.log;
      send("[app]", m.text);
    } else if (m.type === "invoke") {
      invoke(m.cmd, m.payload)
        .then((data) => event.source.postMessage({ katStudio: true, type: "invokeReply", callId: m.callId, ok: true, data }, "*"))
        .catch((err) => event.source.postMessage({ katStudio: true, type: "invokeReply", callId: m.callId, ok: false, error: err.message }, "*"));
    } else if (m.type === "setTitle") {
      if (latestInstalledWindow && latestInstalledWindow.api) latestInstalledWindow.api.setTitle(m.text);
    } else if (m.type === "setResizable") {
      if (latestInstalledWindow && latestInstalledWindow.api) latestInstalledWindow.api.setResizable(m.value);
    } else if (m.type === "katcheck") {
      // An installed app crashed - show the KatCheck window from the shell.
      if (typeof ByteSize.katcheck === "function") ByteSize.katcheck(m);
      else Toast.show(m.message || "App error", "error");
    }
  }
  window.addEventListener("message", handleAppMessage);

  // Pointer lock is available to every app (built-in or installed via ZIP);
  // pressing Esc always releases the cursor, in the shell and in any frame.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.pointerLockElement) {
      document.exitPointerLock();
    }
  }, true);

  // Open an installed ZIP app in a Family A window.
  function openInstalledApp(app) {
    const doc = buildAppDocument(app);
    const win = WM.open({
      id: "app-" + app.id,
      title: app.title,
      icon: app.icon,
      accent: app.accent,
      width: 680,
      height: 520,
      resizable: app.resizable !== false,
      render(body) {
        body.style.padding = "0";
        body.style.overflow = "hidden";
        const frame = document.createElement("iframe");
        frame.className = "inst-frame";
        frame.setAttribute("sandbox", "allow-scripts allow-modals allow-forms allow-pointer-lock");
        frame.style.cssText = "width:100%;height:100%;border:0;background:#fff;display:block;";
        body.appendChild(frame);
        frame.srcdoc = doc;
      },
    });
    latestInstalledWindow = { api: win };
    win.onClose(() => { if (latestInstalledWindow && latestInstalledWindow.api === win) latestInstalledWindow = null; });
    return win;
  }

/* ======================================================================
     App registry (base + custom)
     ====================================================================== */
  const BASE_APPS = [
    Content.fileManager, Content.notepad, Content.paint, Content.snake, Content.tetris,
    Content.calc, Content.music, Content.clock,
    Content.terminal, Content.installer, Content.packager, Content.studio,
    Content.doom, Content.katgpt, Content.settings, Content.about,

  ];
  const DEFAULT_DOCK = ["files", "notepad", "paint", "snake", "tetris", "doom", "calc", "music", "clock", "katgpt", "terminal", "installer", "packager", "settings", "about"];

  function AppRegistry() {
    const installed = (Store.get("customApps", []) || []).filter((app) => app && typeof app.html === "string");
    return [...BASE_APPS, ...installed.map((app) => ({ ...app, open: () => openInstalledApp(app) }))];
  }
  const appById = (id) => AppRegistry().find((app) => app.id === id);

  function dockIds() {
    const stored = Store.get("dock", null);
    const valid = new Set(AppRegistry().map((app) => app.id));
    const list = (Array.isArray(stored) ? stored : DEFAULT_DOCK).filter((id) => valid.has(id));
    return list;
  }

  /* ======================================================================
     Dock / taskbar / start menu
     ====================================================================== */
  const dockEl = $("#dock");
  const startMenu = $("#start-menu");
  const startApps = $("#start-menu__apps");

  function renderDock() {
    dockEl.innerHTML = "";
    dockIds().forEach((id) => {
      const app = appById(id);
      if (!app) return;
      const button = el("button", "dock__icon");
      button.title = app.description || app.title;
      button.innerHTML = `<span class="dock__glyph">${app.icon}</span><span class="dock__label">${esc(app.title)}</span>`;
      button.onclick = () => app.open();
      dockEl.appendChild(button);
    });
  }

  function renderStartApps() {
    startApps.innerHTML = "";
    AppRegistry().forEach((app) => {
      const button = el("button", "start-menu__item");
      button.innerHTML = `<span class="glyph">${app.icon}</span><span>${esc(app.title)}</span><small>${esc(app.description || "")}</small>`;
      button.onclick = () => { app.open(); toggleStart(false); };
      startApps.appendChild(button);
    });
  }

  function toggleStart(force) {
    const show = force == null ? startMenu.hidden : force;
    startMenu.hidden = !show;
    if (show) refreshStartStats();
  }

  async function refreshStartStats() {
    try {
      const m = await invoke("os.metrics");
      $("#sm-cpu").textContent = `${m.cpuPercent}%`;
      $("#sm-ram").textContent = `${m.memoryPercent}%`;
    } catch {
      $("#sm-cpu").textContent = "n/a";
      $("#sm-ram").textContent = "n/a";
    }
  }

  /* ======================================================================
     Settings application
     ====================================================================== */
  function currentSettings() {
    return {
      font: Store.get("font", "comic"),
      labels: Store.get("labels", true),
      windowStyle: Store.get("windowStyle", "drawn"),
      theme: Store.get("theme", "light"),
      zoom: Store.get("zoom", 1),
    };
  }
  function saveSettings(patch) {
    const next = { ...currentSettings(), ...patch };
    Store.set("font", next.font);
    Store.set("labels", next.labels);
    Store.set("windowStyle", next.windowStyle);
    Store.set("theme", next.theme);
    Store.set("zoom", next.zoom);
  }
  function currentWallpaper() {
    const pref = Store.get("wallpaper", null);
    if (pref && typeof pref === "object" && (pref.type === "preset" || pref.type === "custom")) return pref;
    return { type: "preset", id: "kat" };
  }
  function applySettings() {
    const settings = currentSettings();
    const font = FONTS.find((f) => f.id === settings.font) || FONTS[0];
    document.documentElement.style.setProperty("--font", font.value);
    document.body.classList.toggle("hide-dock-labels", !settings.labels);
    document.body.dataset.windowStyle = settings.windowStyle;
    const dark = settings.theme === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const toggle = $("#theme-toggle");
    if (toggle) {
      toggle.textContent = dark ? "☀️" : "🌙";
      toggle.title = dark ? "Switch to light mode" : "Switch to dark mode";
      toggle.setAttribute("aria-pressed", String(dark));
    }
    invoke("os.setZoom", { factor: settings.zoom }).catch(() => {});
  }
  function setTheme(theme) {
    const next = theme === "dark" ? "dark" : "light";
    saveSettings({ theme: next });
    applySettings();
    Toast.show(next === "dark" ? "Dark mode on 🌙" : "Light mode on ☀️", "good");
    return next;
  }
  async function applyWallpaper() {
    const desktopEl = $("#desktop");
    if (!desktopEl) return;
    const pref = currentWallpaper();
    desktopEl.style.backgroundImage = "";

    if (pref.type === "preset" && pref.id === "blueprint") {
      document.body.dataset.wallpaper = "blueprint";
      return;
    }

    if (pref.type === "custom" && pref.path) {
      document.body.dataset.wallpaper = "custom";
      try {
        const file = await invoke("fs.readDataUrl", { path: pref.path });
        desktopEl.style.backgroundImage = `url("${file.dataUrl}")`;
        desktopEl.style.backgroundSize = "cover";
        desktopEl.style.backgroundPosition = "center";
        desktopEl.style.backgroundRepeat = "no-repeat";
      } catch (error) {
        document.body.dataset.wallpaper = "kat";
        Toast.show(`Wallpaper unavailable: ${error.message}`, "error");
      }
      return;
    }

    // Default: Kat Bliss.
    document.body.dataset.wallpaper = "kat";
  }

  /* ======================================================================
     Clock
     ====================================================================== */
  function tickClock() {
    const now = new Date();
    $("#clock-time").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("#clock-date").textContent = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }

  /* ======================================================================
     Boot
     ====================================================================== */
  async function boot() {
    await Store.load();
    applySettings();
    await applyWallpaper();
    renderDock();
    renderStartApps();
    tickClock();
    setInterval(tickClock, 1000);
    window.addEventListener("beforeunload", () => Store.flush());

    $("#start-button").onclick = (event) => { event.stopPropagation(); toggleStart(); };
    $("#theme-toggle").onclick = (event) => {
      event.stopPropagation();
      setTheme(currentSettings().theme === "dark" ? "light" : "dark");
    };
    document.addEventListener("pointerdown", (event) => {
      if (startMenu.hidden) return;
      if (startMenu.contains(event.target) || $("#start-button").contains(event.target)) return;
      toggleStart(false);
    });

    if (window.ByteSizeNative) {
      window.__bzosSwipe = (dir) => {
        toggleStart(dir === "up" || dir === "left");
      };
      document.body.dataset.phoneMode = "on";
      if (!Store.get("phoneHintSeen", false)) {
        const hint = el("div", "phone-hint", "Swipe up or ➡️ for your apps 👆");
        $("#desktop").appendChild(hint);
        Store.set("phoneHintSeen", true);
        setTimeout(() => hint.remove(), 3200);
      }
    }

    if (!ByteSize.hosted) {
      Toast.show("Outside the native host — backend commands are unavailable.", "error", 7000);
    } else {
      Toast.show("Welcome to ByteSize OS! Press START or double-click a file. 🎉", "good", 5000);
    }
  }

  boot();
})();
