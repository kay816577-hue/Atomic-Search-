// Cheap instant-answer helpers. These run BEFORE meta-search and populate
// the `instant` slot at the top of the results page. Each function returns
// null when it doesn't apply, or an {source,title,text} shape that mirrors
// the Wikipedia instant-answer already wired up.
//
// Everything here is strictly local — no embeddings, no LLM, no external
// calls except Wiktionary (definitions), wttr.in (weather) and open.er-api
// (currency), each cached aggressively in-memory.

import { privateFetch } from "./util.js";

// --- Calculator ---------------------------------------------------------
//
// Safe arithmetic evaluator. We DO NOT use `eval` / `Function`. Instead we
// tokenise, shunting-yard to RPN, then evaluate. Supports:
//   + - * / % ^
//   parentheses
//   unary minus
//   decimal literals (1.5, .75)
//   `X% of Y` → (X/100) * Y
//   `sqrt(n)`  `abs(n)` (simple functions)
//
// Returns a number on success, null otherwise.

const CALC_FUNCS = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  log: Math.log10,
  ln: Math.log,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};

function tokeniseCalc(input) {
  const tokens = [];
  let i = 0;
  const s = input.replace(/\s+/g, "");
  while (i < s.length) {
    const ch = s[i];
    if ("+-*/%^(),".includes(ch)) {
      tokens.push({ type: ch, value: ch });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j += 1;
      const num = Number(s.slice(i, j));
      if (!Number.isFinite(num)) return null;
      tokens.push({ type: "num", value: num });
      i = j;
      continue;
    }
    if (/[a-z]/i.test(ch)) {
      let j = i;
      while (j < s.length && /[a-z]/i.test(s[j])) j += 1;
      const name = s.slice(i, j).toLowerCase();
      if (!CALC_FUNCS[name]) return null;
      tokens.push({ type: "fn", value: name });
      i = j;
      continue;
    }
    return null;
  }
  return tokens;
}

const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };
const RIGHT = new Set(["^"]);

function shunt(tokens) {
  const out = [];
  const ops = [];
  let prev = null;
  for (const tok of tokens) {
    if (tok.type === "num") {
      out.push(tok);
    } else if (tok.type === "fn") {
      ops.push(tok);
    } else if (tok.value === "(") {
      ops.push(tok);
    } else if (tok.value === ")") {
      while (ops.length && ops[ops.length - 1].value !== "(") out.push(ops.pop());
      if (!ops.length) return null;
      ops.pop();
      if (ops.length && ops[ops.length - 1].type === "fn") out.push(ops.pop());
    } else if ("+-*/%^".includes(tok.value)) {
      // Unary minus: at start, or after an operator / "("
      if (
        tok.value === "-" &&
        (!prev || prev.type === "(" || "+-*/%^".includes(prev.value) || prev.value === ",")
      ) {
        out.push({ type: "num", value: 0 });
      }
      while (
        ops.length &&
        ops[ops.length - 1].type !== "(" &&
        ops[ops.length - 1].type !== "fn" &&
        ((RIGHT.has(tok.value) ? PREC[ops[ops.length - 1].value] > PREC[tok.value] : PREC[ops[ops.length - 1].value] >= PREC[tok.value]))
      ) {
        out.push(ops.pop());
      }
      ops.push(tok);
    } else {
      return null;
    }
    prev = tok;
  }
  while (ops.length) {
    const op = ops.pop();
    if (op.type === "(" || op.type === ")") return null;
    out.push(op);
  }
  return out;
}

function evalRpn(rpn) {
  const stack = [];
  for (const tok of rpn) {
    if (tok.type === "num") {
      stack.push(tok.value);
      continue;
    }
    if (tok.type === "fn") {
      if (!stack.length) return null;
      const a = stack.pop();
      stack.push(CALC_FUNCS[tok.value](a));
      continue;
    }
    if (stack.length < 2) return null;
    const b = stack.pop();
    const a = stack.pop();
    switch (tok.value) {
      case "+": stack.push(a + b); break;
      case "-": stack.push(a - b); break;
      case "*": stack.push(a * b); break;
      case "/": if (b === 0) return null; stack.push(a / b); break;
      case "%": if (b === 0) return null; stack.push(a % b); break;
      case "^": stack.push(Math.pow(a, b)); break;
      default: return null;
    }
  }
  if (stack.length !== 1) return null;
  const v = stack[0];
  return Number.isFinite(v) ? v : null;
}

// Recognises math-like queries. Also handles `X% of Y`, which we rewrite
// to `(X/100)*Y` before parsing.
const MATH_CHAR_RE = /^[0-9+\-*/%^().,\sA-Za-z]+$/;
const PERCENT_OF_RE = /^\s*(-?\d+(?:\.\d+)?)\s*%\s*of\s*(-?\d+(?:\.\d+)?)\s*$/i;

export function calcAnswer(raw) {
  const query = (raw || "").trim();
  if (!query || query.length > 80) return null;
  if (!MATH_CHAR_RE.test(query)) return null;

  // `X% of Y`
  const m = PERCENT_OF_RE.exec(query);
  let expr = query;
  if (m) expr = `(${m[1]}/100)*${m[2]}`;

  // Must have at least one operator for us to treat it as arithmetic —
  // otherwise "react" and "123" would each light up the calculator.
  if (!/[+\-*/%^]/.test(expr)) return null;

  const tokens = tokeniseCalc(expr);
  if (!tokens) return null;
  const rpn = shunt(tokens);
  if (!rpn) return null;
  const val = evalRpn(rpn);
  if (val === null) return null;

  const pretty = Number.isInteger(val) ? String(val) : String(Number(val.toFixed(10))).replace(/\.?0+$/, "");
  return {
    source: "Atomic calculator",
    title: query,
    text: `${query} = ${pretty}`,
    value: val,
  };
}

// --- Dictionary (Wiktionary) -------------------------------------------

const DEFINE_RE = /^\s*(?:define|definition\s+of|meaning\s+of|what\s+does\s+)\s*["']?([a-z][a-z\-']{1,40})["']?\s*\??\s*$/i;
const DEF_CACHE = new Map();
const DEF_CACHE_CAP = 300;

export async function defineAnswer(raw) {
  const m = DEFINE_RE.exec((raw || "").trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  if (DEF_CACHE.has(word)) return DEF_CACHE.get(word) || null;
  try {
    const res = await privateFetch(
      `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`,
      { timeout: 3500, headers: { Accept: "application/json" } }
    );
    if (!res.ok) { DEF_CACHE.set(word, null); return null; }
    const j = await res.json();
    // Shape: { en: [{ partOfSpeech, definitions: [{ definition, examples? }] }, ...] }
    const entries = j?.en || j?.de || Object.values(j)[0];
    if (!Array.isArray(entries) || !entries.length) return null;
    const first = entries[0];
    const def = first?.definitions?.[0]?.definition || "";
    const plainDef = def.replace(/<[^>]+>/g, "").trim();
    if (!plainDef) return null;
    const out = {
      source: "Wiktionary",
      title: word,
      text: `${first.partOfSpeech ? "(" + first.partOfSpeech + ") " : ""}${plainDef}`,
      url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
    };
    if (DEF_CACHE.size >= DEF_CACHE_CAP) DEF_CACHE.delete(DEF_CACHE.keys().next().value);
    DEF_CACHE.set(word, out);
    return out;
  } catch {
    return null;
  }
}

// --- Weather (wttr.in) -------------------------------------------------

const WEATHER_RE = /^\s*(?:weather|forecast|temp(?:erature)?)\s+(?:in|at|for)\s+([a-z][a-z\s,.'-]{1,60})\s*\??\s*$/i;
const WEATHER_CACHE = new Map();
const WEATHER_TTL_MS = 15 * 60 * 1000;

export async function weatherAnswer(raw) {
  const m = WEATHER_RE.exec((raw || "").trim());
  if (!m) return null;
  const place = m[1].trim().replace(/\s+/g, " ");
  const key = place.toLowerCase();
  const cached = WEATHER_CACHE.get(key);
  const now = Date.now();
  if (cached && now - cached.ts < WEATHER_TTL_MS) return cached.payload;
  try {
    // wttr.in format=j1 returns JSON; we only want current condition.
    const res = await privateFetch(
      `https://wttr.in/${encodeURIComponent(place)}?format=j1`,
      { timeout: 4000, headers: { Accept: "application/json", "User-Agent": "AtomicSearch/1.0" } }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const cur = j?.current_condition?.[0];
    const area = j?.nearest_area?.[0]?.areaName?.[0]?.value || place;
    const region = j?.nearest_area?.[0]?.region?.[0]?.value || "";
    const country = j?.nearest_area?.[0]?.country?.[0]?.value || "";
    if (!cur) return null;
    const desc = cur.weatherDesc?.[0]?.value || "";
    const text =
      `${desc}, ${cur.temp_C}°C / ${cur.temp_F}°F, feels like ${cur.FeelsLikeC}°C. ` +
      `Wind ${cur.windspeedKmph} km/h ${cur.winddir16Point || ""}. ` +
      `Humidity ${cur.humidity}%. Updated ${cur.localObsDateTime || ""}.`;
    const payload = {
      source: "wttr.in",
      title: `${area}${region ? ", " + region : ""}${country ? ", " + country : ""}`.trim(),
      text,
      url: `https://wttr.in/${encodeURIComponent(place)}`,
    };
    WEATHER_CACHE.set(key, { ts: now, payload });
    if (WEATHER_CACHE.size > 200) WEATHER_CACHE.delete(WEATHER_CACHE.keys().next().value);
    return payload;
  } catch {
    return null;
  }
}

// --- Time in city (IANA, no network) -----------------------------------
//
// We only ship a compact city -> timezone table; the big win is the
// Intl.DateTimeFormat API which knows every IANA zone without any state.

const CITY_TZ = {
  "new york": "America/New_York",
  "nyc": "America/New_York",
  "los angeles": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  "chicago": "America/Chicago",
  "toronto": "America/Toronto",
  "vancouver": "America/Vancouver",
  "mexico city": "America/Mexico_City",
  "sao paulo": "America/Sao_Paulo",
  "buenos aires": "America/Argentina/Buenos_Aires",
  "london": "Europe/London",
  "dublin": "Europe/Dublin",
  "paris": "Europe/Paris",
  "berlin": "Europe/Berlin",
  "madrid": "Europe/Madrid",
  "rome": "Europe/Rome",
  "amsterdam": "Europe/Amsterdam",
  "vienna": "Europe/Vienna",
  "zurich": "Europe/Zurich",
  "stockholm": "Europe/Stockholm",
  "oslo": "Europe/Oslo",
  "helsinki": "Europe/Helsinki",
  "copenhagen": "Europe/Copenhagen",
  "moscow": "Europe/Moscow",
  "istanbul": "Europe/Istanbul",
  "athens": "Europe/Athens",
  "warsaw": "Europe/Warsaw",
  "prague": "Europe/Prague",
  "lisbon": "Europe/Lisbon",
  "dubai": "Asia/Dubai",
  "abu dhabi": "Asia/Dubai",
  "riyadh": "Asia/Riyadh",
  "tel aviv": "Asia/Tel_Aviv",
  "jerusalem": "Asia/Jerusalem",
  "tehran": "Asia/Tehran",
  "karachi": "Asia/Karachi",
  "mumbai": "Asia/Kolkata",
  "delhi": "Asia/Kolkata",
  "bangalore": "Asia/Kolkata",
  "colombo": "Asia/Colombo",
  "dhaka": "Asia/Dhaka",
  "bangkok": "Asia/Bangkok",
  "hanoi": "Asia/Ho_Chi_Minh",
  "ho chi minh": "Asia/Ho_Chi_Minh",
  "singapore": "Asia/Singapore",
  "kuala lumpur": "Asia/Kuala_Lumpur",
  "jakarta": "Asia/Jakarta",
  "manila": "Asia/Manila",
  "hong kong": "Asia/Hong_Kong",
  "taipei": "Asia/Taipei",
  "shanghai": "Asia/Shanghai",
  "beijing": "Asia/Shanghai",
  "tokyo": "Asia/Tokyo",
  "osaka": "Asia/Tokyo",
  "seoul": "Asia/Seoul",
  "sydney": "Australia/Sydney",
  "melbourne": "Australia/Melbourne",
  "perth": "Australia/Perth",
  "auckland": "Pacific/Auckland",
  "cairo": "Africa/Cairo",
  "johannesburg": "Africa/Johannesburg",
  "cape town": "Africa/Johannesburg",
  "nairobi": "Africa/Nairobi",
  "lagos": "Africa/Lagos",
  "utc": "UTC",
  "gmt": "UTC",
};

const TIME_RE = /^\s*(?:time|current\s+time|what\s+time\s+is\s+it)\s+(?:in|at|for)?\s+([a-z][a-z\s,.'-]{1,50})\s*\??\s*$/i;

export function timeAnswer(raw) {
  const m = TIME_RE.exec((raw || "").trim());
  if (!m) return null;
  const place = m[1].trim().toLowerCase().replace(/\s+/g, " ");
  const tz = CITY_TZ[place] || CITY_TZ[place.replace(/,.*/, "").trim()];
  if (!tz) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
    const now = fmt.format(new Date());
    return {
      source: "Atomic clock",
      title: place.replace(/\b\w/g, (c) => c.toUpperCase()),
      text: `${now} (${tz})`,
    };
  } catch {
    return null;
  }
}

// --- Unit conversion ---------------------------------------------------
//
// Linear-factor table, all expressed against a common base per dimension.
// `convert(from, to, value)` returns the converted value, or null when
// the units aren't in the same dimension / unknown.

const UNITS = {
  // length (base: m)
  m: { dim: "length", f: 1 },
  meter: { dim: "length", f: 1 },
  meters: { dim: "length", f: 1 },
  metre: { dim: "length", f: 1 },
  km: { dim: "length", f: 1000 },
  kilometer: { dim: "length", f: 1000 },
  kilometers: { dim: "length", f: 1000 },
  kilometre: { dim: "length", f: 1000 },
  kilometres: { dim: "length", f: 1000 },
  cm: { dim: "length", f: 0.01 },
  mm: { dim: "length", f: 0.001 },
  mi: { dim: "length", f: 1609.344 },
  mile: { dim: "length", f: 1609.344 },
  miles: { dim: "length", f: 1609.344 },
  yd: { dim: "length", f: 0.9144 },
  yard: { dim: "length", f: 0.9144 },
  yards: { dim: "length", f: 0.9144 },
  ft: { dim: "length", f: 0.3048 },
  foot: { dim: "length", f: 0.3048 },
  feet: { dim: "length", f: 0.3048 },
  in: { dim: "length", f: 0.0254 },
  inch: { dim: "length", f: 0.0254 },
  inches: { dim: "length", f: 0.0254 },
  // mass (base: kg)
  kg: { dim: "mass", f: 1 },
  kilogram: { dim: "mass", f: 1 },
  kilograms: { dim: "mass", f: 1 },
  g: { dim: "mass", f: 0.001 },
  gram: { dim: "mass", f: 0.001 },
  grams: { dim: "mass", f: 0.001 },
  mg: { dim: "mass", f: 0.000001 },
  lb: { dim: "mass", f: 0.45359237 },
  lbs: { dim: "mass", f: 0.45359237 },
  pound: { dim: "mass", f: 0.45359237 },
  pounds: { dim: "mass", f: 0.45359237 },
  oz: { dim: "mass", f: 0.028349523125 },
  ounce: { dim: "mass", f: 0.028349523125 },
  ounces: { dim: "mass", f: 0.028349523125 },
  ton: { dim: "mass", f: 1000 },
  tonne: { dim: "mass", f: 1000 },
  tonnes: { dim: "mass", f: 1000 },
  // volume (base: l)
  l: { dim: "volume", f: 1 },
  liter: { dim: "volume", f: 1 },
  liters: { dim: "volume", f: 1 },
  litre: { dim: "volume", f: 1 },
  litres: { dim: "volume", f: 1 },
  ml: { dim: "volume", f: 0.001 },
  gal: { dim: "volume", f: 3.785411784 },
  gallon: { dim: "volume", f: 3.785411784 },
  gallons: { dim: "volume", f: 3.785411784 },
  qt: { dim: "volume", f: 0.946352946 },
  pt: { dim: "volume", f: 0.473176473 },
  cup: { dim: "volume", f: 0.2365882365 },
  cups: { dim: "volume", f: 0.2365882365 },
  // time (base: s)
  s: { dim: "time", f: 1 },
  sec: { dim: "time", f: 1 },
  second: { dim: "time", f: 1 },
  seconds: { dim: "time", f: 1 },
  min: { dim: "time", f: 60 },
  mins: { dim: "time", f: 60 },
  minute: { dim: "time", f: 60 },
  minutes: { dim: "time", f: 60 },
  h: { dim: "time", f: 3600 },
  hr: { dim: "time", f: 3600 },
  hour: { dim: "time", f: 3600 },
  hours: { dim: "time", f: 3600 },
  day: { dim: "time", f: 86400 },
  days: { dim: "time", f: 86400 },
  week: { dim: "time", f: 604800 },
  weeks: { dim: "time", f: 604800 },
  // speed (base: m/s) — written as one compound unit
  mps: { dim: "speed", f: 1 },
  "m/s": { dim: "speed", f: 1 },
  kmh: { dim: "speed", f: 0.2777777778 },
  "km/h": { dim: "speed", f: 0.2777777778 },
  kph: { dim: "speed", f: 0.2777777778 },
  mph: { dim: "speed", f: 0.44704 },
  knot: { dim: "speed", f: 0.514444 },
  knots: { dim: "speed", f: 0.514444 },
};

// Temperature is special (not a linear factor — offset too).
function tempConvert(fromU, toU, v) {
  const k = { c: v, f: (v - 32) * 5 / 9, k: v - 273.15 }[fromU];
  if (k === undefined) return null;
  switch (toU) {
    case "c": return k;
    case "f": return k * 9 / 5 + 32;
    case "k": return k + 273.15;
    default: return null;
  }
}

const UNIT_RE = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z/]+)\s+(?:to|in|as)\s+([a-z/]+)\s*\??\s*$/i;

export function unitAnswer(raw) {
  const m = UNIT_RE.exec((raw || "").trim());
  if (!m) return null;
  const v = Number(m[1]);
  const fromU = m[2].toLowerCase();
  const toU = m[3].toLowerCase();
  if (!Number.isFinite(v)) return null;

  // Temperature
  const tempAliases = { c: "c", "°c": "c", celsius: "c", f: "f", "°f": "f", fahrenheit: "f", k: "k", kelvin: "k" };
  if (tempAliases[fromU] && tempAliases[toU]) {
    const out = tempConvert(tempAliases[fromU], tempAliases[toU], v);
    if (out == null) return null;
    return {
      source: "Atomic converter",
      title: `${v} ${fromU} → ${toU}`,
      text: `${v}°${fromU.toUpperCase()} = ${Number(out.toFixed(4))}°${toU.toUpperCase()}`,
    };
  }

  const from = UNITS[fromU];
  const to = UNITS[toU];
  if (!from || !to || from.dim !== to.dim) return null;
  const base = v * from.f;
  const result = base / to.f;
  return {
    source: "Atomic converter",
    title: `${v} ${fromU} → ${toU}`,
    text: `${v} ${fromU} = ${Number(result.toFixed(6))} ${toU}`,
  };
}

// --- Currency (open.er-api.com, 1h cache) ------------------------------

const CURRENCY_RE = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]{3})\s+(?:to|in|as)\s+([a-z]{3})\s*\??\s*$/i;
const FX_CACHE = new Map();
const FX_TTL_MS = 60 * 60 * 1000;

export async function currencyAnswer(raw) {
  const m = CURRENCY_RE.exec((raw || "").trim());
  if (!m) return null;
  const v = Number(m[1]);
  const from = m[2].toUpperCase();
  const to = m[3].toUpperCase();
  if (!Number.isFinite(v)) return null;
  // Skip when the codes also happen to be unit aliases (mi, km etc are only 2
  // chars so they can't collide). Looks OK.
  const now = Date.now();
  const hit = FX_CACHE.get(from);
  let rates = hit && now - hit.ts < FX_TTL_MS ? hit.rates : null;
  if (!rates) {
    try {
      const res = await privateFetch(
        `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`,
        { timeout: 4000, headers: { Accept: "application/json" } }
      );
      if (!res.ok) return null;
      const j = await res.json();
      if (!j?.rates || j.result !== "success") return null;
      rates = j.rates;
      FX_CACHE.set(from, { ts: now, rates });
    } catch {
      return null;
    }
  }
  const r = rates[to];
  if (!r) return null;
  const result = v * r;
  return {
    source: "open.er-api.com",
    title: `${v} ${from} → ${to}`,
    text: `${v} ${from} = ${Number(result.toFixed(4))} ${to} (rate ${r})`,
  };
}

// --- Dice / coin / random ----------------------------------------------

const DICE_RE = /^\s*roll\s+(\d{1,2})?\s*d\s*(\d{1,3})\s*\??\s*$/i;
const COIN_RE = /^\s*(?:flip|toss)\s+(?:a\s+)?coin\s*\??\s*$/i;
const RAND_RE = /^\s*random(?:\s+number)?(?:\s+(?:between|from))?\s+(-?\d+)\s+(?:to|and|-)\s+(-?\d+)\s*\??\s*$/i;

export function randomAnswer(raw) {
  const q = (raw || "").trim();
  let m;
  if ((m = DICE_RE.exec(q))) {
    const n = Math.max(1, Math.min(20, Number(m[1]) || 1));
    const sides = Math.max(2, Math.min(1000, Number(m[2])));
    const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
    const total = rolls.reduce((a, b) => a + b, 0);
    return {
      source: "Atomic dice",
      title: `${n}d${sides}`,
      text: `Rolls: ${rolls.join(", ")}. Total: ${total}.`,
    };
  }
  if (COIN_RE.test(q)) {
    const face = Math.random() < 0.5 ? "Heads" : "Tails";
    return { source: "Atomic coin", title: "Coin flip", text: face };
  }
  if ((m = RAND_RE.exec(q))) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    if (a > b) [a, b] = [b, a];
    const v = a + Math.floor(Math.random() * (b - a + 1));
    return { source: "Atomic random", title: `Random ${a}–${b}`, text: String(v) };
  }
  return null;
}

// --- Dispatcher --------------------------------------------------------
//
// Runs the sync checks first (cheapest), then tries the async ones in
// order. Returns the first hit or null.

export async function resolveInstant(raw) {
  const q = (raw || "").trim();
  if (!q) return null;

  const sync = calcAnswer(q) || timeAnswer(q) || unitAnswer(q) || randomAnswer(q);
  if (sync) return sync;

  const def = await defineAnswer(q);
  if (def) return def;
  const cur = await currencyAnswer(q);
  if (cur) return cur;
  const w = await weatherAnswer(q);
  if (w) return w;
  return null;
}
