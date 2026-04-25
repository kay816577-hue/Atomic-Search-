// What's-new modal: shown once per version (keyed by window.ATOMIC_VERSION
// or fallback constant). Dismiss stores "v3.0.0" (this version only) or
// "forever" (never again regardless of future version bumps).

(function () {
  "use strict";
  const VERSION = "v3.0.0";
  const KEY = "atomic:whatsnew";
  const FOREVER = "forever";

  function shouldShow() {
    try {
      const v = localStorage.getItem(KEY);
      if (v === FOREVER) return false;
      if (v === VERSION) return false;
      return true;
    } catch {
      return false;
    }
  }

  function open() {
    const m = document.getElementById("whatsnew-modal");
    if (!m) return;
    m.hidden = false;
    document.documentElement.style.overflow = "hidden";
  }

  function close() {
    const m = document.getElementById("whatsnew-modal");
    if (!m) return;
    m.hidden = true;
    document.documentElement.style.overflow = "";
  }

  function setKey(v) {
    try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (shouldShow()) {
      // Defer slightly so themes + home content render first.
      setTimeout(open, 400);
    }

    const closeBtn = document.getElementById("whatsnew-close");
    const gotIt = document.getElementById("whatsnew-dismiss-version");
    const forever = document.getElementById("whatsnew-dismiss-forever");

    if (closeBtn) closeBtn.addEventListener("click", () => { setKey(VERSION); close(); });
    if (gotIt) gotIt.addEventListener("click", () => { setKey(VERSION); close(); });
    if (forever) forever.addEventListener("click", () => { setKey(FOREVER); close(); });

    // Backdrop click closes.
    const modal = document.getElementById("whatsnew-modal");
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) { setKey(VERSION); close(); }
      });
    }
  });

  // Expose for Settings "re-open what's new" link.
  window.AtomicWhatsNew = { open, close, reset: () => setKey("") };
})();
