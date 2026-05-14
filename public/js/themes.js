(function () {
  "use strict";
  var KEY = "atomic.theme";
  var DEFAULT = "atom-dark";

  function apply(t) {
    if (!t) return;
    document.body.dataset.theme = t;
    try { localStorage.setItem(KEY, t); } catch (e) { /* ignore */ }
    var sel = document.getElementById("theme");
    if (sel) sel.value = t;
  }

  // Boot: apply saved theme (or default) immediately so there's no flash.
  var saved = DEFAULT;
  try { saved = localStorage.getItem(KEY) || DEFAULT; } catch (e) { /* ignore */ }
  apply(saved);

  // Late-bind the <select> so the settings modal can mutate it.
  document.addEventListener("DOMContentLoaded", function () {
    var sel = document.getElementById("theme");
    if (!sel) return;
    sel.value = document.body.dataset.theme || DEFAULT;
    sel.addEventListener("change", function (e) { apply(e.target.value); });
  });
})();
