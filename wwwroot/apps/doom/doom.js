/* ============================================================================
   DOOM for ByteSize OS — real WebAssembly port.

   Drives `doom.wasm` (doomgeneric compiled to wasm) through its tiny interface:
   10 imports in, initGame/tickGame/reportKeyDown/reportKeyUp out.

   The module only accepts *keyboard* input, so the mouse is supported the way
   classic ports do it: while the Pointer Lock API holds the cursor we translate
   horizontal mouse motion into the engine's turn keys, and the mouse buttons
   into FIRE / USE. Press Esc to release the pointer at any time.
   ========================================================================== */
(function () {
  "use strict";

  var canvas = document.getElementById("doom-canvas");
  var overlay = document.getElementById("doom-overlay");
  var status = document.getElementById("doom-status");
  var hud = document.getElementById("doom-hud");
  var ctx = canvas.getContext("2d");

  var wasm = null;       // module exports
  var memory = null;     // exported WebAssembly.Memory
  var imageData = null;  // scratch frame buffer
  var held = new Set();  // doom keys currently reported as down

  /* ---- Helpers ----------------------------------------------------------- */

  function readUtf8(ptr, len) {
    try {
      return new TextDecoder("utf-8", { fatal: false })
        .decode(new Uint8Array(memory.buffer, ptr, len));
    } catch (_) { return ""; }
  }

  function pressKey(key) {
    if (key === null || key === undefined) { return; }
    if (!held.has(key)) { held.add(key); wasm.reportKeyDown(key); }
  }

  function releaseKey(key) {
    if (key === null || key === undefined) { return; }
    if (held.has(key)) { held.delete(key); wasm.reportKeyUp(key); }
  }

  // Release everything (used when the pointer unlocks or the tab loses focus)
  // so the marine never runs off on his own.
  function releaseAll() {
    held.forEach(function (key) { wasm.reportKeyUp(key); });
    held.clear();
  }

  function isLocked() { return document.pointerLockElement === canvas; }

  function setLockedVisuals(locked) {
    overlay.classList.toggle("hide", locked);
    if (locked) {
      hud.classList.add("show");
      clearTimeout(setLockedVisuals._t);
      setLockedVisuals._t = setTimeout(function () { hud.classList.remove("show"); }, 3000);
    } else {
      hud.classList.remove("show");
    }
  }

  /* ---- Imports the module expects ---------------------------------------- */

  function onGameInit(width, height) {
    canvas.width = width;
    canvas.height = height;
    imageData = ctx.createImageData(width, height);
  }

  // ARGB little-endian (bytes ordered B,G,R,A) -> ImageData's R,G,B,A.
  function drawFrame(frameBufferPtr) {
    if (!imageData) { return; }
    var fb = new Uint8Array(memory.buffer, frameBufferPtr, canvas.width * canvas.height * 4);
    var data = imageData.data;
    for (var i = 0; i < data.length; i += 4) {
      data[i] = fb[i + 2];
      data[i + 1] = fb[i + 1];
      data[i + 2] = fb[i];
      data[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  var imports = {
    loading: {
      onGameInit: onGameInit,
      wadSizes: function () {},   // no custom WAD -> module loads shareware WAD
      readWads: function () {}
    },
    ui: { drawFrame: drawFrame },
    runtimeControl: {
      timeInMilliseconds: function () { return BigInt(Math.trunc(performance.now())); }
    },
    console: {
      onInfoMessage: function (p, l) { console.log("[doom] " + readUtf8(p, l).trim()); },
      onErrorMessage: function (p, l) { console.error("[doom] " + readUtf8(p, l).trim()); }
    },
    gameSaving: {
      sizeOfSaveGame: function () { return 0; },
      readSaveGame: function () { return 0; },
      writeSaveGame: function () { return 0; }
    }
  };

  /* ---- Keyboard -> DOOM keys --------------------------------------------- */

  var SPECIAL = {
    ArrowLeft: "KEY_LEFTARROW",
    ArrowRight: "KEY_RIGHTARROW",
    ArrowUp: "KEY_UPARROW",
    ArrowDown: "KEY_DOWNARROW",
    ",": "KEY_STRAFE_L",
    ".": "KEY_STRAFE_R",
    Control: "KEY_FIRE",
    " ": "KEY_USE",
    Shift: "KEY_SHIFT",
    Tab: "KEY_TAB",
    Escape: "KEY_ESCAPE",
    Enter: "KEY_ENTER",
    Backspace: "KEY_BACKSPACE",
    Alt: "KEY_ALT"
  };
  var WASD = { w: "ArrowUp", a: "ArrowLeft", s: "ArrowDown", d: "ArrowRight" };

  function doomKeyFor(event) {
    if (!wasm) { return null; }
    if (Object.prototype.hasOwnProperty.call(SPECIAL, event.key)) {
      return wasm[SPECIAL[event.key]];
    }
    var key = typeof event.key === "string" ? event.key.toLowerCase() : "";
    if (WASD[key]) { return wasm[SPECIAL[WASD[key]]]; }
    if (event.key.length === 1) { return event.key.charCodeAt(0); }
    return null;
  }

  function onKeyDown(event) {
    // Esc always means "give me my mouse back" while the pointer is captured.
    // (The browser normally consumes this press; handling it too is harmless.)
    if (event.key === "Escape" && isLocked()) {
      event.preventDefault();
      document.exitPointerLock();
      return;
    }
    var key = doomKeyFor(event);
    if (key === null || key === undefined) { return; }
    event.preventDefault();
    event.stopPropagation();
    pressKey(key);
  }

  function onKeyUp(event) {
    var key = doomKeyFor(event);
    if (key === null || key === undefined) { return; }
    event.preventDefault();
    event.stopPropagation();
    releaseKey(key);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  /* ---- Mouse: pointer lock + turning + buttons --------------------------- */

  var turnTimers = { left: 0, right: 0 };

  // Tap the engine's turn key for as long as the mouse keeps moving.
  function turnBurst(dir) {
    var key = dir === "left" ? wasm.KEY_LEFTARROW : wasm.KEY_RIGHTARROW;
    pressKey(key);
    clearTimeout(turnTimers[dir]);
    turnTimers[dir] = setTimeout(function () { releaseKey(key); }, 60);
  }

  document.addEventListener("mousemove", function (event) {
    if (!isLocked()) { return; }
    var dx = event.movementX || 0;
    if (dx > 300) { dx = 300; }         // guard against rare spikes
    if (dx < -300) { dx = -300; }
    if (dx > 0.4) { turnBurst("right"); }
    else if (dx < -0.4) { turnBurst("left"); }
  });

  function requestLock() {
    try {
      var promise = canvas.requestPointerLock();
      if (promise && typeof promise.catch === "function") { promise.catch(function () {}); }
    } catch (_) { /* Chrome's post-Esc cooldown; just click again */ }
  }

  canvas.addEventListener("mousedown", function (event) {
    if (!isLocked()) { requestLock(); return; }
    event.preventDefault();
    if (event.button === 0) { pressKey(wasm.KEY_FIRE); }
    else if (event.button === 2) { pressKey(wasm.KEY_USE); }
  });
  canvas.addEventListener("mouseup", function (event) {
    if (!isLocked()) { return; }
    if (event.button === 0) { releaseKey(wasm.KEY_FIRE); }
    else if (event.button === 2) { releaseKey(wasm.KEY_USE); }
  });
  canvas.addEventListener("contextmenu", function (event) {
    if (isLocked()) { event.preventDefault(); }
  });

  document.addEventListener("pointerlockchange", function () {
    var locked = isLocked();
    setLockedVisuals(locked);
    if (!locked) { releaseAll(); }
  });
  document.addEventListener("pointerlockerror", function () {
    if (status) { status.textContent = "Pointer lock was blocked — click again to play."; }
  });

  // Never leave keys held if the window loses focus.
  window.addEventListener("blur", function () { if (wasm) { releaseAll(); } });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && wasm) { releaseAll(); }
  });

  /* ---- Boot -------------------------------------------------------------- */

  function start() {
    fetch("doom.wasm")
      .then(function (response) {
        if (!response.ok) { throw new Error("Could not load doom.wasm (HTTP " + response.status + ")."); }
        return response.arrayBuffer();
      })
      .then(function (bytes) { return WebAssembly.instantiate(bytes, imports); })
      .then(function (result) {
        wasm = result.instance.exports;
        memory = wasm.memory;

        wasm.initGame();
        requestLock(); // first click will grant it; harmless if it fails now
        canvas.focus();

        var interval = 1000 / 35; // DOOM's native cadence
        var last = 0;
        function loop(now) {
          if (!document.hidden && now - last >= interval) {
            last = now;
            wasm.tickGame();
          }
          requestAnimationFrame(loop);
        }
        requestAnimationFrame(loop);
      })
      .catch(function (error) {
        console.error("DOOM failed to start:", error);
        if (overlay) { overlay.classList.remove("hide"); }
        if (status) {
          status.innerHTML = '<span style="color:#ff6b3d">DOOM failed to start</span><br />' +
            String(error && error.message ? error.message : error);
        }
      });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    start();
  } else {
    window.addEventListener("load", start);
  }
})();
