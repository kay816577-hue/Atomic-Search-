(function () {
  var KEY = "atomic.theme";
  var sel = document.getElementById("theme");
  function apply(t) {
    document.body.dataset.theme = t;
    try { localStorage.setItem(KEY, t); } catch (e) {}
    if (sel) sel.value = t;
  }
  try {
    var saved = localStorage.getItem(KEY);
    if (saved) apply(saved);
  } catch (e) {}
  if (sel) sel.addEventListener("change", function (e) { apply(e.target.value); });
})();
