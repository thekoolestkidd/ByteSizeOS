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
  const STORE_KEYS = ["wallpaper", "font", "labels", "windowStyle", "dock", "customApps", "pixoogle", "snakeBest", "studioLanguage", "studioCode"];
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
      task.textContent = `${spec.icon || ""} ${spec.title || "Window"}`.trim();
      layer.appendChild(node);
      taskbarItems.appendChild(task);

      const rec = {
        key: spec.id || uid(),
        el: node, task,
        minimized: false, maximized: false, prev: null,
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
        setTitle(title) {
          node.querySelector(".window__title").textContent = title;
          task.textContent = `${spec.icon || ""} ${title}`.trim();
        },
      };
      rec.api = api;

      node.querySelector(".window__icon").textContent = spec.icon || "";
      node.querySelector(".window__title").textContent = spec.title || "Window";

      node.querySelector(".notch--min").onclick = () => minimize(rec);
      node.querySelector(".notch--max").onclick = () => toggleMaximize(rec);
      node.querySelector(".notch--close").onclick = () => closeWindow(rec);
      task.onclick = () => {
        if (rec.minimized) restore(rec);
        else if (node.classList.contains("window--focused")) minimize(rec);
        else focus(rec);
      };
      node.addEventListener("pointerdown", () => focus(rec));

      enableDrag(rec);
      enableResize(rec);
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
    description: "Doodle, fill and resize",
    open() {
      WM.open({
        id: "paint", title: "Paint", icon: "🎨", accent: "#ff4757",
        width: 1000, height: 700,
        render(body) {
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
                <span class="spacer"></span>
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
              <div class="paint__stage"><canvas width="820" height="440"></canvas></div>
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

          let tool = "brush";
          let erase = false;
          let transparentBg = false;
          let color = "#17181c";
          let drawing = false;

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

  /* ---- Terminal ---------------------------------------------------------- */
  const TERMINAL_HELP = [
    "commands: help  clear  sys  mem  ps [n]  ls [path]  cd [path]  pwd",
    "          cat <path>  mkdir <path>  notepad [path]  paint  snake  calc",
    "          music  clock  pixoogle  settings  apps  echo <text>  date",
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
            calc: () => { Content.calc.open(); write("launched calc", "ok"); },
            music: () => { Content.music.open(); write("launched music", "ok"); },
            clock: () => { Content.clock.open(); write("launched clock", "ok"); },
            pixoogle: () => { Content.pixoogle.open(); write("launched pixoogle", "ok"); },
            settings: () => { Content.settings.open(); write("launched settings", "ok"); },
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

          write("ByteSize OS shell v1 — type 'help'.", "cmd");
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

  /* ---- Calculator -------------------------------------------------------- */
  Content.calc = {
    id: "calc", title: "Calculator", icon: "🧮", accent: "#4cc2ff",
    description: "Do the math, Family A style",
    open() {
      WM.open({
        id: "calc", title: "Calculator", icon: "🧮", accent: "#4cc2ff",
        width: 300, height: 440,
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

  /* ---- Music (lo-fi synth radio) ----------------------------------------- */
  Content.music = {
    id: "music", title: "Music", icon: "🎵", accent: "#a55eea",
    description: "Lo-fi radio — synth tunes, no files needed",
    open() {
      WM.open({
        id: "music", title: "Music", icon: "🎵", accent: "#a55eea",
        width: 460, height: 430,
        render(body, api) {
          body.innerHTML = `
            <div class="music">
              <div class="music__deck">
                <div class="music__art" data-art>🎵</div>
                <div class="music__now">
                  <b data-title>—</b>
                  <small class="muted" data-sub>pick a track</small>
                </div>
                <div class="music__eq"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
              </div>
              <div class="music__controls">
                <button class="btn" data-prev title="Previous">⏮</button>
                <button class="btn btn--accent music__play" data-play title="Play / pause">▶</button>
                <button class="btn" data-next title="Next">⏭</button>
                <input class="music__vol" type="range" data-vol min="0" max="1" step="0.05" value="0.7" aria-label="Volume" />
              </div>
              <div class="music__tracks" data-tracks></div>
            </div>`;

          const artEl = body.querySelector("[data-art]");
          const titleEl = body.querySelector("[data-title]");
          const subEl = body.querySelector("[data-sub]");
          const tracksEl = body.querySelector("[data-tracks]");
          const playBtn = body.querySelector("[data-play]");
          const volInput = body.querySelector("[data-vol]");

          const NOTE_SEMIS = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
          const noteFreq = (name) => {
            const match = /^([A-G]#?)(\d)$/.exec(String(name).trim());
            if (!match || !(match[1] in NOTE_SEMIS)) return 0;
            const midi = (parseInt(match[2], 10) + 1) * 12 + NOTE_SEMIS[match[1]];
            return 440 * Math.pow(2, (midi - 69) / 12);
          };

          const TRACKS = [
            { name: "Sunny Day", emoji: "☀️", bpm: 118, notes: "C5 D5 E5 G5 E5 D5 C5 A4 C5 D5 E5 G5 A5 G5 E5 C5", bass: "C3 G3 A3 E3" },
            { name: "Starlight", emoji: "🌙", bpm: 96, notes: "A4 B4 C5 B4 A4 G#4 F#4 G#4 A4 B4 C5 B4 A4 G#4 E4 F#4", bass: "A2 E3 F#3 C#3" },
            { name: "Park Hop", emoji: "🛹", bpm: 132, notes: "G4 A4 B4 D5 B4 A4 G4 E4 G4 A4 B4 D5 E5 D5 B4 G4", bass: "G2 D3 E3 C3" },
          ];

          let ac = null, master = null, timer = null;
          let playing = false, trackIdx = 0, step = 0, nextTime = 0;

          function ensureContext() {
            if (ac) return;
            ac = new (window.AudioContext || window.webkitAudioContext)();
            master = ac.createGain();
            master.gain.value = Number(volInput.value) || 0.7;
            master.connect(ac.destination);
          }

          function playNote(freq, time, dur, type, gain) {
            const osc = ac.createOscillator();
            const env = ac.createGain();
            osc.type = type;
            osc.frequency.value = freq;
            env.gain.setValueAtTime(0.0001, time);
            env.gain.exponentialRampToValueAtTime(gain, time + 0.012);
            env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
            osc.connect(env);
            env.connect(master);
            osc.start(time);
            osc.stop(time + dur + 0.05);
          }

          function schedule() {
            const track = TRACKS[trackIdx];
            const melody = track.notes.split(/\s+/);
            const bass = track.bass.split(/\s+/);
            const stepSeconds = 60 / track.bpm / 4;
            while (nextTime < ac.currentTime + 0.12) {
              const mf = noteFreq(melody[step % melody.length]);
              if (mf) playNote(mf, nextTime, stepSeconds * 0.85, "square", 0.05);
              if (step % 4 === 0) {
                const bf = noteFreq(bass[Math.floor(step / 4) % bass.length]);
                if (bf) playNote(bf / 2, nextTime, stepSeconds * 3.2, "triangle", 0.11);
              }
              step = (step + 1) % 64;
              nextTime += stepSeconds;
            }
          }

          function renderTracks() {
            tracksEl.innerHTML = "";
            TRACKS.forEach((track, index) => {
              const row = el("button", "music__track" + (index === trackIdx ? " music__track--active" : ""));
              row.innerHTML = `<span>${track.emoji}</span><span style="flex:1;text-align:left">${esc(track.name)}</span><small class="muted">${track.bpm} BPM</small>`;
              row.onclick = () => selectTrack(index);
              tracksEl.appendChild(row);
            });
          }

          function selectTrack(index) {
            trackIdx = index;
            step = 0;
            nextTime = 0;
            renderTracks();
            artEl.textContent = TRACKS[index].emoji;
            titleEl.textContent = TRACKS[index].name;
            if (playing) { stop(); play(); }
          }

          function play() {
            ensureContext();
            ac.resume();
            playing = true;
            step = 0;
            nextTime = ac.currentTime + 0.08;
            timer = setInterval(schedule, 30);
            playBtn.textContent = "⏸";
            body.querySelector(".music").classList.add("music--playing");
            subEl.textContent = `${trackIdx + 1} of ${TRACKS.length} · playing`;
          }

          function stop() {
            playing = false;
            clearInterval(timer);
            timer = null;
            playBtn.textContent = "▶";
            body.querySelector(".music").classList.remove("music--playing");
            subEl.textContent = `${trackIdx + 1} of ${TRACKS.length} · ${TRACKS[trackIdx].bpm} BPM`;
          }

          function toggle() {
            if (playing) stop();
            else play();
          }

          playBtn.onclick = toggle;
          body.querySelector("[data-prev]").onclick = () => selectTrack((trackIdx + TRACKS.length - 1) % TRACKS.length);
          body.querySelector("[data-next]").onclick = () => selectTrack((trackIdx + 1) % TRACKS.length);
          volInput.addEventListener("input", () => { if (master) master.gain.value = Number(volInput.value) || 0; });

          api.onClose(() => {
            stop();
            if (ac) ac.close().catch(() => {});
          });
          selectTrack(0);
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
          api.onClose(() => clearInterval(timer));
        },
      });
    },
  };
/* ---- Pixoogle (in-window Wikipedia search) -------------------------------- */
  Content.pixoogle = {
    id: "pixoogle", title: "Pixoogle", icon: "🔎", accent: "#1e90ff",
    description: "Search the web, right here in the window",
    open() {
      WM.open({
        id: "pixoogle", title: "Pixoogle", icon: "🔎", accent: "#1e90ff",
        width: 700, height: 540,
        render(body) {
          const history = Store.get("pixoogle", []);
          body.innerHTML = `
            <div class="pixoogle">
              <div class="pixoogle__logo"><span class="c1">P</span><span class="c2">i</span><span class="c3">x</span><b>oogle</b></div>
              <div class="pixoogle__search">
                <input class="field" data-q placeholder="Search Wikipedia… (no real browser, promise)" />
                <button class="btn btn--accent" data-act="go">Search</button>
                <button class="btn" data-act="lucky" title="I'm feeling goofy">🎲</button>
              </div>
              <div class="pixoogle__meta muted" data-meta></div>
              <div class="pixoogle__results" data-results></div>
            </div>`;

          const input = body.querySelector("[data-q]");
          const results = body.querySelector("[data-results]");
          const meta = body.querySelector("[data-meta]");
          const GOOFY = ["cat", "rubber duck", "why is the sky blue", "ice cream", "spaceship"];

          const setBusy = (text) => { meta.textContent = text || ""; };
          const stripHtml = (html) => String(html || "").replace(/<[^>]*>/g, "");
          const remember = (q) => {
            history.unshift(q);
            Store.set("pixoogle", history.slice(0, 12));
          };

          function renderHistory() {
            if (!history.length) {
              results.innerHTML = '<p class="muted" style="text-align:center;margin-top:24px">No searches yet. Go on, type something!</p>';
              return;
            }
            results.innerHTML = history.map((item) => `
              <button class="result" data-q="${esc(item)}">${esc(item)}<small>search again</small></button>`).join("");
            results.querySelectorAll(".result").forEach((button) => {
              button.onclick = () => { input.value = button.dataset.q; search(button.dataset.q); };
            });
          }

          async function search(query) {
            const q = (query || input.value).trim();
            if (!q) { Toast.show("Type something to search for.", "error"); return; }
            remember(q);
            input.value = q;
            setBusy(`Searching for “${q}”…`);
            results.innerHTML = "";
            try {
              const url = "https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=12"
                + `&srsearch=${encodeURIComponent(q)}&format=json&origin=*`;
              const res = await invoke("net.get", { url });
              if (res.status !== 200) throw new Error(`Wikipedia answered with status ${res.status}.`);
              const data = JSON.parse(res.body);
              const hits = (data && data.query && data.query.search) || [];
              setBusy(`${hits.length} ${hits.length === 1 ? "result" : "results"} for “${q}”`);
              if (!hits.length) {
                results.innerHTML = '<p class="muted" style="text-align:center;margin-top:24px">No results. Try different words!</p>';
                return;
              }
              results.innerHTML = hits.map((hit) => `
                <button class="result" data-title="${esc(hit.title)}">
                  <b>${esc(hit.title)}</b><small>${esc(stripHtml(hit.snippet))}…</small>
                </button>`).join("");
              results.querySelectorAll(".result").forEach((button) => {
                button.onclick = () => article(button.dataset.title);
              });
            } catch (error) {
              setBusy("");
              results.innerHTML = `<p class="muted" style="margin-top:24px">${esc(error.message)}</p>`;
              Toast.show("Pixoogle needs internet.", "error");
            }
          }

          async function article(title) {
            setBusy(`Loading “${title}”…`);
            results.innerHTML = "";
            try {
              const url = "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1"
                + `&format=json&origin=*&titles=${encodeURIComponent(title)}`;
              const res = await invoke("net.get", { url });
              const data = JSON.parse(res.body);
              const pages = data && data.query && data.query.pages ? data.query.pages : {};
              const page = Object.values(pages)[0];
              const text = page && page.extract ? page.extract : "No article text available.";
              const paragraph = esc(text)
                .replace(/\n{2,}/g, "</p><p>")
                .replace(/\n/g, "<br>");
              results.innerHTML = `
                <div class="row" style="margin-bottom:8px">
                  <button class="btn" data-back>⬅ Back</button>
                  <b style="font-size:16px;flex:1">${esc(title)}</b>
                  <span class="chip">wikipedia</span>
                </div>
                <article class="wiki"><p>${paragraph}</p></article>`;
              results.querySelector("[data-back]").onclick = () => search(input.value);
              setBusy("");
            } catch (error) {
              setBusy("");
              results.innerHTML = `<p class="muted" style="margin-top:24px">${esc(error.message)}</p>`;
            }
          }

          async function randomArticle() {
            setBusy("Feeling goofy…");
            try {
              const url = "https://en.wikipedia.org/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=1&format=json&origin=*";
              const res = await invoke("net.get", { url });
              const data = JSON.parse(res.body);
              const title = data && data.query && data.query.random && data.query.random[0]
                ? data.query.random[0].title
                : null;
              if (title) { input.value = title; await article(title); }
              else { setBusy(""); Toast.show("Couldn't find a random article.", "error"); }
            } catch (error) {
              setBusy("");
              Toast.show(error.message, "error");
            }
          }

          body.querySelector('[data-act="go"]').onclick = () => search();
          body.querySelector('[data-act="lucky"]').onclick = () => {
            const q = GOOFY[Math.floor(Math.random() * GOOFY.length)];
            input.value = q;
            search(q);
          };
          input.addEventListener("keydown", (event) => { if (event.key === "Enter") search(); });
          renderHistory();
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
                <h3>🏷️ Dock labels</h3>
                <div class="option-grid">
                  <button class="option ${current.labels ? "option--active" : ""}" data-labels="true">Show</button>
                  <button class="option ${current.labels ? "" : "option--active"}" data-labels="false">Hide</button>
                </div>
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

            apPanel.querySelectorAll("[data-labels]").forEach((button) => {
              button.onclick = () => { saveSettings({ labels: button.dataset.labels === "true" }); applySettings(); renderSettings(); };
            });

            apPanel.querySelector("[data-reset]").onclick = () => {
              ["wallpaper", "font", "labels", "windowStyle", "dock", "customApps", "pixoogle", "snakeBest", "studioLanguage", "studioCode"].forEach((key) => Store.remove(key));
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
    setTitle: function (t) { parent.postMessage({ katStudio: true, type: "setTitle", text: String(t) }, "*"); }
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
    } else if (m.type === "katcheck") {
      // An installed app crashed - show the KatCheck window from the shell.
      if (typeof ByteSize.katcheck === "function") ByteSize.katcheck(m);
      else Toast.show(m.message || "App error", "error");
    }
  }
  window.addEventListener("message", handleAppMessage);

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
    Content.fileManager, Content.notepad, Content.paint, Content.snake,
    Content.calc, Content.music, Content.clock,
    Content.terminal, Content.installer, Content.studio, Content.pixoogle, Content.settings,
    Content.about,
  ];
  const DEFAULT_DOCK = ["files", "notepad", "paint", "snake", "calc", "music", "clock", "terminal", "installer", "pixoogle", "settings", "about"];

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
    };
  }
  function saveSettings(patch) {
    const next = { ...currentSettings(), ...patch };
    Store.set("font", next.font);
    Store.set("labels", next.labels);
    Store.set("windowStyle", next.windowStyle);
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
    document.addEventListener("pointerdown", (event) => {
      if (startMenu.hidden) return;
      if (startMenu.contains(event.target) || $("#start-button").contains(event.target)) return;
      toggleStart(false);
    });

    if (!ByteSize.hosted) {
      Toast.show("Outside the native host — backend commands are unavailable.", "error", 7000);
    } else {
      Toast.show("Welcome to ByteSize OS! Press START or double-click a file. 🎉", "good", 5000);
    }
  }

  boot();
})();
