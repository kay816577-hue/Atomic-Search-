(function () {
  "use strict";
  var audio = new Audio();
  audio.preload = "metadata";
  audio.volume = 0.7;

  var state = { queue: [], index: -1 };

  var $ = function (id) { return document.getElementById(id); };

  function fmt(sec) {
    sec = Math.floor(sec || 0);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" + s : s);
  }

  function setTrack(i) {
    if (i < 0 || i >= state.queue.length) return;
    state.index = i;
    var t = state.queue[i];
    audio.src = t.streamUrl;
    audio.play().catch(function () {});
    $("track-title").textContent = t.title;
    $("track-artist").textContent = t.artist;
    $("cover").src = t.artwork || "";
    $("play").textContent = "❚❚";
  }

  function renderList(tracks) {
    state.queue = tracks;
    var list = $("music-list");
    list.innerHTML = "";
    tracks.forEach(function (t, i) {
      var li = document.createElement("li");
      li.innerHTML =
        (t.artwork ? '<img src="' + t.artwork + '" alt="">' : '<div class="cover"></div>') +
        '<div class="mt"><b></b><span></span></div>';
      li.querySelector("b").textContent = t.title;
      li.querySelector("span").textContent = t.artist;
      li.addEventListener("click", function () { setTrack(i); });
      list.appendChild(li);
    });
  }

  async function search(q) {
    var url = q ? "/api/music/search?q=" + encodeURIComponent(q) : "/api/music/trending";
    var res = await fetch(url).catch(function () { return null; });
    if (!res || !res.ok) return;
    var data = await res.json();
    renderList(data.tracks || []);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var toggle = $("player-toggle");
    var panel = $("player-panel");
    toggle.addEventListener("click", function () {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && state.queue.length === 0) search("");
    });

    $("music-search").addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        search(e.target.value.trim());
      }
    });
    $("music-trending").addEventListener("click", function () { search(""); });

    $("play").addEventListener("click", function () {
      if (!audio.src) {
        if (state.queue.length) setTrack(0);
        return;
      }
      if (audio.paused) {
        audio.play().catch(function () {});
        $("play").textContent = "❚❚";
      } else {
        audio.pause();
        $("play").textContent = "▶";
      }
    });
    $("prev").addEventListener("click", function () {
      if (state.index > 0) setTrack(state.index - 1);
    });
    $("next").addEventListener("click", function () {
      if (state.index + 1 < state.queue.length) setTrack(state.index + 1);
    });

    audio.addEventListener("timeupdate", function () {
      var pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      $("seek").value = String(pct || 0);
      $("time").textContent = fmt(audio.currentTime) + " / " + fmt(audio.duration);
    });
    audio.addEventListener("ended", function () {
      if (state.index + 1 < state.queue.length) setTrack(state.index + 1);
      else $("play").textContent = "▶";
    });

    $("seek").addEventListener("input", function (e) {
      if (!audio.duration) return;
      audio.currentTime = (e.target.value / 100) * audio.duration;
    });
    $("volume").addEventListener("input", function (e) {
      audio.volume = Number(e.target.value) / 100;
    });
  });
})();
