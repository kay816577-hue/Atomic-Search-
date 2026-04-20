// NSFW filter. Deliberately simple and conservative: a hand-curated domain
// blocklist covers the overwhelming majority of traffic, and a keyword
// check on host + URL path + title + snippet catches long-tail and
// user-generated subdomains. When either trips, the result is dropped
// from search output, image output, and refused by the crawler.
//
// False positives are possible (e.g. "sex education" articles) but the
// bar is: better a few legitimate adult-adjacent articles get filtered
// than letting explicit content through. Tweak KEYWORDS if a legit page
// keeps getting filtered.

const BLOCKED_DOMAINS = new Set([
  "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com",
  "youporn.com", "tube8.com", "spankbang.com", "porntrex.com", "porn.com",
  "beeg.com", "tnaflix.com", "hclips.com", "txxx.com", "sex.com",
  "eporner.com", "hqporner.com", "motherless.com", "chaturbate.com",
  "stripchat.com", "cam4.com", "livejasmin.com", "bongacams.com",
  "myfreecams.com", "cams.com", "onlyfans.com", "fansly.com",
  "manyvids.com", "iwantclips.com", "clips4sale.com",
  "literotica.com", "asstr.org", "nifty.org", "adultfriendfinder.com",
  "ashleymadison.com", "milfzr.com", "brazzers.com", "bangbros.com",
  "realitykings.com", "naughtyamerica.com", "digitalplayground.com",
  "evilangel.com", "mofos.com", "twistys.com", "kink.com", "porntube.com",
  "xxx.com", "adultdvdempire.com", "javhd.com", "jav.guru", "jav.com",
  "pornone.com", "sextvx.com", "hentaihaven.xxx", "hentai-foundry.com",
  "nhentai.net", "e-hentai.org", "exhentai.org", "rule34.xxx",
  "rule34.paheal.net", "rule34video.com", "gelbooru.com", "danbooru.donmai.us",
  "fapello.com", "erome.com", "scrolller.com",
]);

// Host suffixes that are auto-blocked regardless of exact domain. Catches
// e.g. "something.pornhub.com" and the many ".xxx" / ".adult" TLDs.
const BLOCKED_SUFFIXES = [
  ".xxx", ".adult", ".sex", ".porn",
];

const KEYWORDS = [
  "porn", "xxx", "xnxx", "xvideos", "hentai", "rule34", "nsfw",
  "pornhub", "onlyfans", "fansly", "chaturbate", "stripchat",
  "milf", "bdsm", "incest", "fetish", "gangbang", "blowjob", "handjob",
  "cumshot", "anal", "deepthroat", "creampie", "bukkake", "threesome",
  "jav", "av-jav", "hardcore-porn", "sex-cam", "camgirl", "camwhore",
  "escort", "hookup-sex", "cuckold", "shemale", "tranny",
];

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase();
  } catch {
    return "";
  }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return (u.pathname || "").toLowerCase();
  } catch {
    return "";
  }
}

// Exported for testability and for the UI if we ever want a "why was this
// filtered?" debug badge.
export function isNsfwUrl(url) {
  if (!url) return false;
  const host = hostOf(url);
  if (!host) return false;
  // Exact domain + any parent domain up the chain.
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    if (BLOCKED_DOMAINS.has(candidate)) return true;
  }
  for (const suf of BLOCKED_SUFFIXES) {
    if (host.endsWith(suf)) return true;
  }
  // Path / host keyword check — catches e.g. "example.com/porn/..." or a
  // subdomain "porn.example.com" that isn't in the blocklist.
  const hay = host + " " + pathOf(url);
  for (const k of KEYWORDS) {
    // Word-boundary-ish: keyword surrounded by non-alpha on both sides.
    const re = new RegExp(`(^|[^a-z])${k}([^a-z]|$)`, "i");
    if (re.test(hay)) return true;
  }
  return false;
}

export function isNsfwText(...fields) {
  const hay = fields.filter(Boolean).join(" ").toLowerCase();
  if (!hay) return false;
  for (const k of KEYWORDS) {
    const re = new RegExp(`(^|[^a-z])${k}([^a-z]|$)`, "i");
    if (re.test(hay)) return true;
  }
  return false;
}

// Unified predicate used by search + images + crawler. `result` is the loose
// shape produced by aggregator / meta-image search (url, title, snippet, host).
export function isNsfwResult(result) {
  if (!result) return false;
  if (isNsfwUrl(result.url)) return true;
  if (isNsfwText(result.title, result.snippet, result.host)) return true;
  return false;
}
