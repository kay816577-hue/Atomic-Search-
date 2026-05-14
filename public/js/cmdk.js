// Command palette (Ctrl/Cmd-K). Lets the user jump to any feature
// without hunting through menus. Entirely client-side, localstorage for
// recent commands.

(function () {
  "use strict";

  const COMMANDS = [
    { id: "home", label: "Go to home", hint: "/", run: () => { location.href = "/"; } },
    { id: "tools", label: "Open /tools", hint: "t", run: () => { location.href = "/tools"; } },
    { id: "settings", label: "Open Settings", hint: ",", run: () => document.getElementById("open-settings-home")?.click() || document.getElementById("open-settings")?.click() },
    { id: "whatsnew", label: "What's new in this version", run: () => window.AtomicWhatsNew?.open() },
    { id: "theme-toggle", label: "Toggle dark/light theme",
      run: () => {
        const sel = document.getElementById("theme");
        if (!sel) return;
        const cur = sel.value;
        sel.value = cur === "ucx" ? "paper-white" : "ucx";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      } },
    { id: "tab-images", label: "Search: Images tab",
      run: () => document.querySelector("[data-tab=\"images\"]")?.click() },
    { id: "tab-news", label: "Search: News tab",
      run: () => document.querySelector("[data-tab=\"news\"]")?.click() },
    { id: "tab-scan", label: "Search: Scan tab",
      run: () => document.querySelector("[data-tab=\"scan\"]")?.click() },
    { id: "ai", label: "Open AI chat",
      run: () => {
        if (!window.AtomicAI?.isEnabled()) {
          alert("AI mode is off. Turn it on in Settings first.");
          return;
        }
        window.AtomicAI.openPanel();
      } },
    { id: "github", label: "Open Atomic on GitHub",
      run: () => window.open("https://github.com/kay816577-hue/Atomic-Search-", "_blank", "noopener") },
    { id: "focus-search", label: "Focus search box",
      run: () => (document.getElementById("q") || document.getElementById("q-hero"))?.focus() },
    { id: "clear-history", label: "Clear local history",
      run: () => { try { localStorage.removeItem("atomic:history"); alert("History cleared."); } catch { /* ignore */ } } },
    { id: "export-settings", label: "Export settings (JSON)",
      run: () => {
        const dump = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k) continue;
          if (!k.startsWith("atomic")) continue;
          dump[k] = localStorage.getItem(k);
        }
        const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "atomic-settings.json";
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
      } },
  ];

  function open() {
    const m = document.getElementById("cmdk-modal");
    if (!m) return;
    m.hidden = false;
    const i = document.getElementById("cmdk-input");
    if (i) { i.value = ""; render(""); setTimeout(() => i.focus(), 30); }
  }

  function close() {
    const m = document.getElementById("cmdk-modal");
    if (!m) return;
    m.hidden = true;
  }

  function render(filter) {
    const list = document.getElementById("cmdk-list");
    if (!list) return;
    const f = (filter || "").toLowerCase().trim();
    const items = f
      ? COMMANDS.filter((c) => c.label.toLowerCase().includes(f))
      : COMMANDS;
    list.innerHTML = "";
    items.forEach((cmd, i) => {
      const li = document.createElement("li");
      li.className = "cmdk-item" + (i === 0 ? " cmdk-active" : "");
      li.tabIndex = -1;
      li.innerHTML = `<span>${cmd.label}</span>` + (cmd.hint ? `<kbd>${cmd.hint}</kbd>` : "");
      li.addEventListener("click", () => { cmd.run(); close(); });
      list.appendChild(li);
    });
  }

  function move(delta) {
    const items = Array.from(document.querySelectorAll(".cmdk-item"));
    if (!items.length) return;
    let i = items.findIndex((el) => el.classList.contains("cmdk-active"));
    items[i]?.classList.remove("cmdk-active");
    i = (i + delta + items.length) % items.length;
    items[i].classList.add("cmdk-active");
    items[i].scrollIntoView({ block: "nearest" });
  }

  function runActive() {
    const el = document.querySelector(".cmdk-item.cmdk-active");
    if (!el) return;
    const label = el.querySelector("span")?.textContent;
    const cmd = COMMANDS.find((c) => c.label === label);
    if (cmd) { cmd.run(); close(); }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.addEventListener("keydown", (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        open();
        return;
      }
      const m = document.getElementById("cmdk-modal");
      if (!m || m.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); move(-1); return; }
      if (e.key === "Enter") { e.preventDefault(); runActive(); return; }
    });

    const input = document.getElementById("cmdk-input");
    if (input) input.addEventListener("input", () => render(input.value));

    const modal = document.getElementById("cmdk-modal");
    if (modal) {
      modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    }
  });

  window.AtomicCmdK = { open, close };
})();
