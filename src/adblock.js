// Embedded blocklist of the most-abused ad/tracker/telemetry hosts.
//
// Everything in here is matched as a suffix (so `doubleclick.net` also
// blocks `x.y.doubleclick.net`). We favour a compact, carefully-curated
// list over a giant hosts-file dump because we ship this to every VM
// cold boot — keeping it small keeps startup fast.
//
// Sources reviewed (public / public-domain / CC0): StevenBlack hosts
// unified list, Peter Lowe's, and AdGuard's "ads+trackers" subset. Only
// the hosts responsible for the largest share of page weight / trackers
// are kept here; heavy use of `isBlockedHost` means missing one at worst
// lets an ad through, never breaks a page.

export const AD_TRACKER_HOSTS = [
  // ---- Google ad & analytics ----
  "doubleclick.net",
  "googlesyndication.com",
  "googletagmanager.com",
  "googletagservices.com",
  "google-analytics.com",
  "googleadservices.com",
  "adservice.google.com",
  "pagead2.googlesyndication.com",
  "partnerad.l.doubleclick.net",
  "stats.g.doubleclick.net",
  "adsystem.google.com",
  "googleoptimize.com",
  "ampproject.net",

  // ---- Facebook / Meta ----
  "facebook.net",
  "connect.facebook.net",
  "fbcdn.net",
  "graph.facebook.com",
  "pixel.facebook.com",

  // ---- Amazon ads ----
  "amazon-adsystem.com",
  "amazonaax.com",
  "assoc-amazon.com",

  // ---- Microsoft / Bing ads ----
  "bat.bing.com",
  "bat.bing.net",
  "clarity.ms",
  "ads.microsoft.com",

  // ---- Twitter/X ----
  "ads-twitter.com",
  "analytics.twitter.com",
  "t.co/i/adsct",

  // ---- LinkedIn ----
  "ads.linkedin.com",
  "px.ads.linkedin.com",

  // ---- TikTok ----
  "analytics.tiktok.com",
  "business-api.tiktok.com",

  // ---- Yahoo / Verizon Media ----
  "ads.yahoo.com",
  "analytics.yahoo.com",
  "advertising.yahoo.com",

  // ---- Adobe Analytics / Marketo ----
  "omtrdc.net",
  "demdex.net",
  "2o7.net",
  "everesttech.net",
  "tt.omtrdc.net",
  "sc.omtrdc.net",

  // ---- Large independent ad networks ----
  "adnxs.com",
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "3lift.com",
  "taboola.com",
  "outbrain.com",
  "criteo.com",
  "criteo.net",
  "mediavine.com",
  "adsafeprotected.com",
  "moatads.com",
  "serving-sys.com",
  "casalemedia.com",
  "bidswitch.net",
  "smartadserver.com",
  "yieldmo.com",
  "sharethrough.com",
  "indexww.com",
  "gumgum.com",
  "adroll.com",
  "adform.net",
  "revcontent.com",
  "zemanta.com",
  "bluekai.com",
  "bidtheatre.com",
  "advertising.com",
  "chartbeat.com",
  "chartbeat.net",

  // ---- Analytics / telemetry ----
  "segment.com",
  "segment.io",
  "mixpanel.com",
  "amplitude.com",
  "heap.io",
  "heapanalytics.com",
  "fullstory.com",
  "hotjar.com",
  "hotjar.io",
  "mouseflow.com",
  "crazyegg.com",
  "luckyorange.com",
  "quantserve.com",
  "scorecardresearch.com",
  "kissmetrics.com",
  "optimizely.com",
  "newrelic.com",
  "nr-data.net",
  "bugsnag.com",
  "sentry.io",
  "honeybadger.io",
  "rollbar.com",
  "tealiumiq.com",
  "branch.io",
  "braze.com",
  "appsflyer.com",
  "adjust.com",
  "singular.net",

  // ---- Pop-up / toxic networks ----
  "popads.net",
  "popcash.net",
  "propellerads.com",
  "trafficjunky.net",
  "trafficjunky.com",
  "exoclick.com",
  "juicyads.com",
  "adcash.com",
  "clickaine.com",
  "adsterra.com",
  "ero-advertising.com",
  "mgid.com",

  // ---- Push-notification / consent / newsletter spam ----
  "onesignal.com",
  "pushcrew.com",
  "pushowl.com",
  "onetrust.com",
  "trustarc.com",
  "quantcast.mgr.consensu.org",
  "cookielaw.org",
  "cookie-script.com",

  // ---- Misc trackers ----
  "nr-data.net",
  "quantcount.com",
  "mathtag.com",
  "adsrvr.org",
  "rlcdn.com",
  "ctnsnet.com",
  "lijit.com",
];

// Normalise once into a Set of exact host strings (lowercased). We then
// test membership cheaply and also do a suffix walk for subdomains.
const BLOCKED_SET = new Set(AD_TRACKER_HOSTS.map((h) => h.toLowerCase()));

export function matchBlockedHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  if (BLOCKED_SET.has(h)) return true;
  // Walk up the subdomain chain: foo.bar.doubleclick.net → bar.doubleclick.net
  // → doubleclick.net. Stops when we've stripped to 2 labels or matched.
  const parts = h.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    if (BLOCKED_SET.has(candidate)) return true;
  }
  return false;
}

export function isBlockedHost(url) {
  try {
    return matchBlockedHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
