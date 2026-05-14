/**
 * Content Filtering Module
 * 4-level progressive content filtering: Off → Basic → Kid → Strict
 * 
 * Features:
 * - NSFW content blocking
 * - Gambling & betting site blocking
 * - Violence & drug content filtering
 * - Anti-spy/scareware detection
 * - Anti-ads network blocking
 * - Hate speech & conspiracy filtering
 * - All processing is local (no external API calls)
 */

// Filter levels
export const FILTER_LEVELS = {
  OFF: 0,
  BASIC: 1,
  KID: 2,
  STRICT: 3
};

export function getFilterLevel(name) {
  const levels = {
    "off": FILTER_LEVELS.OFF,
    "basic": FILTER_LEVELS.BASIC,
    "kid": FILTER_LEVELS.KID,
    "strict": FILTER_LEVELS.STRICT
  };
  return levels[String(name || "off").toLowerCase()] || FILTER_LEVELS.OFF;
}

// ============================================================================
// DOMAIN BLOCKLISTS
// ============================================================================

// NSFW sites (from existing nsfw.js)
const NSFW_DOMAINS = new Set([
  "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com",
  "youporn.com", "tube8.com", "spankbang.com", "porntrex.com", "porn.com",
  "beeg.com", "tnaflix.com", "hclips.com", "txxx.com", "sex.com",
  "eporner.com", "hqporner.com", "motherless.com", "chaturbate.com",
  "stripchat.com", "cam4.com", "livejasmin.com", "bongacams.com",
  "onlyfans.com", "fansly.com", "manyvids.com", "brazzers.com",
]);

// Gambling & betting domains
const GAMBLING_DOMAINS = new Set([
  "bet365.com", "williamhill.com", "betfair.com", "ladbrokes.com",
  "paddypower.com", "betway.com", "fanduel.com", "draftkings.com",
  "mgm.com", "caesars.com", "888.com", "betvictor.com", "skybet.com",
  "pokerstars.com", "888poker.com", "fulltilt.com", "zynga.com",
  "nih.gov/gambling", "casino.com", "slots.com", "roulette.com",
]);

// Scareware & spyware domains
const SCAREWARE_DOMAINS = new Set([
  "techsupportscam.com", "mackeeper.com", "pcoptimizer.com",
  "macbooster.com", "cleanmypc.com", "optimizer.com", "tune-up.com",
  "registry-cleaner.com", "spybot-search-destroy.com", "antivirustoolbar.com",
  "conduit.com", "babylon.com", "searchprotect.com", "delta-homes.com",
]);

// Ad network domains
const AD_NETWORK_DOMAINS = new Set([
  "doubleclick.net", "googlesyndication.com", "adnxs.com", "rubiconproject.com",
  "scorecardresearch.com", "tracking.com", "advertising.com", "ads.com",
  "adserver.com", "banner-ads.com", "clicksor.com", "contextual.com",
]);

// Suspicious blocklist (anti-spy, data brokers)
const SUSPICIOUS_DOMAINS = new Set([
  "databroker.com", "intelius.com", "whitepages.com", "beenverified.com",
  "spokeo.com", "pipl.com", "fastpeoplesearch.com", "fastbackgroundcheck.com",
  "peoplefinders.com", "instant-checkmate.com",
]);

// ============================================================================
// KEYWORD DETECTION
// ============================================================================

const KEYWORD_GROUPS = {
  nsfw: [
    "porn", "adult", "xxx", "sex", "nude", "nude", "webcam", "cam girl",
    "onlyfans", "chaturbate", "stripchat", "omegle",
  ],
  gambling: [
    "casino", "poker", "bet", "betting", "odds", "sportsbook", "bookie",
    "roulette", "blackjack", "slots", "gambling", "wager",
  ],
  violence: [
    "gore", "violence", "kill", "murder", "execution", "graphic violence",
    "snuff", "torture", "cannibalism",
  ],
  drugs: [
    "cocaine", "heroin", "meth", "crack", "drug dealer", "buy drugs online",
    "illegal substances", "narcotics", "opioids",
  ],
  hate: [
    "hate speech", "racial slur", "neo-nazi", "white supremacy",
    "militia", "klan", "terrorism", "extremist",
  ],
  conspiracy: [
    "flat earth", "chemtrails", "deep state", "illuminati", "reptilians",
    "jfk assassination conspiracy", "moon landing hoax", "9/11 inside job",
  ],
  scam: [
    "nigerian prince", "wire money", "claim reward", "act now",
    "verify account", "confirm identity", "update payment",
  ],
  fake_tech: [
    "your computer has virus", "windows has detected", "system alert",
    "malware detected", "your device is compromised",
  ]
};

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

/**
 * Check if content matches keyword group
 */
function hasKeywords(text, keywords, minMatches = 1) {
  if (!text) return false;
  text = text.toLowerCase();
  let matches = 0;
  
  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) {
      matches++;
      if (matches >= minMatches) return true;
    }
  }
  
  return false;
}

/**
 * Extract domain from URL
 */
function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Check domain blocklist
 */
function isDomainBlocked(domain, filterLevel) {
  if (!domain) return false;
  
  // BASIC filter
  if (filterLevel >= FILTER_LEVELS.BASIC) {
    if (NSFW_DOMAINS.has(domain)) return true;
    if (GAMBLING_DOMAINS.has(domain)) return true;
  }
  
  // KID filter
  if (filterLevel >= FILTER_LEVELS.KID) {
    if (SCAREWARE_DOMAINS.has(domain)) return true;
    if (AD_NETWORK_DOMAINS.has(domain)) return true;
  }
  
  // STRICT filter
  if (filterLevel >= FILTER_LEVELS.STRICT) {
    if (SUSPICIOUS_DOMAINS.has(domain)) return true;
  }
  
  return false;
}

/**
 * Analyze content against keywords
 */
export function analyzeContent(result, filterLevel) {
  const text = `${result.title || ""} ${result.snippet || ""} ${result.url || ""}`.toLowerCase();
  const flags = [];
  
  if (filterLevel >= FILTER_LEVELS.BASIC) {
    if (hasKeywords(text, KEYWORD_GROUPS.nsfw)) flags.push("nsfw");
    if (hasKeywords(text, KEYWORD_GROUPS.gambling)) flags.push("gambling");
  }
  
  if (filterLevel >= FILTER_LEVELS.KID) {
    if (hasKeywords(text, KEYWORD_GROUPS.violence)) flags.push("violence");
    if (hasKeywords(text, KEYWORD_GROUPS.drugs)) flags.push("drugs");
    if (hasKeywords(text, KEYWORD_GROUPS.scam)) flags.push("scam");
    if (hasKeywords(text, KEYWORD_GROUPS.fake_tech)) flags.push("fake_tech");
  }
  
  if (filterLevel >= FILTER_LEVELS.STRICT) {
    if (hasKeywords(text, KEYWORD_GROUPS.hate)) flags.push("hate_speech");
    if (hasKeywords(text, KEYWORD_GROUPS.conspiracy, 2)) flags.push("conspiracy");
  }
  
  return {
    blocked: flags.length > 0,
    flags,
    reason: flags.length > 0 ? `Content flagged as: ${flags.join(", ")}` : null
  };
}

/**
 * Main filter function for result sets
 */
export function filterResults(results, filterLevel) {
  if (filterLevel === FILTER_LEVELS.OFF || !results) {
    return results || [];
  }
  
  return results.filter(result => {
    const domain = getDomain(result.url);
    
    // Domain check
    if (isDomainBlocked(domain, filterLevel)) {
      return false;
    }
    
    // Content keyword check
    const analysis = analyzeContent(result, filterLevel);
    if (analysis.blocked) {
      return false;
    }
    
    return true;
  });
}

/**
 * Filter images (same logic)
 */
export function filterImages(images, filterLevel) {
  return filterResults(images, filterLevel);
}

/**
 * Get filter level name
 */
export function getFilterLevelName(level) {
  const names = {
    [FILTER_LEVELS.OFF]: "Off",
    [FILTER_LEVELS.BASIC]: "Basic",
    [FILTER_LEVELS.KID]: "Kid Mode",
    [FILTER_LEVELS.STRICT]: "Strict Safe"
  };
  return names[level] || "Unknown";
}

/**
 * Get filter description
 */
export function getFilterDescription(level) {
  const descriptions = {
    [FILTER_LEVELS.OFF]: "Show all results",
    [FILTER_LEVELS.BASIC]: "Block adult content and gambling",
    [FILTER_LEVELS.KID]: "Safe for kids - blocks violence, drugs, scams, ads",
    [FILTER_LEVELS.STRICT]: "Strictest filtering - also blocks conspiracy and data brokers"
  };
  return descriptions[level] || "";
}

/**
 * Statistics on what was filtered
 */
export function getFilterStats(originalResults, filteredResults, filterLevel) {
  const blocked = originalResults.length - filteredResults.length;
  
  return {
    filterLevel: getFilterLevelName(filterLevel),
    totalOriginal: originalResults.length,
    totalShown: filteredResults.length,
    blocked,
    blockPercentage: originalResults.length > 0 
      ? Math.round((blocked / originalResults.length) * 100)
      : 0
  };
}

export default {
  FILTER_LEVELS,
  getFilterLevel,
  analyzeContent,
  filterResults,
  filterImages,
  getFilterLevelName,
  getFilterDescription,
  getFilterStats
};
