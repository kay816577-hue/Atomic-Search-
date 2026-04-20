// Authentication — optional, user-initiated. Atomic works anonymously without
// an account; signing in unlocks the download safety scanner.
//
// Two methods, both graceful-degrade when the corresponding keys are missing:
//   1. Google OAuth:  GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
//   2. Email magic link: requires SMTP_* env vars; otherwise the endpoint
//      returns an honest error.
//
// Sessions are tiny signed cookies (HMAC-SHA256). Users live in the SQLite
// storage that the crawler already uses. Zero other storage, no JWT libs.

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { upsertUser, getUserByEmail, getUserById } from "./storage.js";
import { sendMail, emailConfigured } from "./mailer.js";
import { privateFetch } from "./util.js";

const SESSION_COOKIE = "atomic_s";
const MAGIC_COOKIE = "atomic_m";
const SESSION_TTL_SEC = 30 * 24 * 3600;
const MAGIC_TTL_SEC = 15 * 60;

function secret() {
  return (
    process.env.ATOMIC_SESSION_SECRET ||
    process.env.SESSION_SECRET ||
    // Derive a stable-ish fallback so cookies survive restarts in dev. In
    // production you should set ATOMIC_SESSION_SECRET.
    "atomic-default-" + (process.env.GH_INDEX_PAT || process.env.VIRUSTOTAL_API_KEY || "dev-secret")
  );
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function unb64url(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload) {
  const raw = JSON.stringify(payload);
  const body = b64url(raw);
  const mac = b64url(createHmac("sha256", secret()).update(body).digest());
  return body + "." + mac;
}
function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".", 2);
  const expected = b64url(createHmac("sha256", secret()).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(unb64url(body).toString("utf8")); } catch { return null; }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

export async function currentUser(c) {
  const tok = getCookie(c, SESSION_COOKIE);
  const payload = verify(tok);
  if (!payload?.uid) return null;
  const user = await getUserById(payload.uid).catch(() => null);
  return user || null;
}

async function setSession(c, user) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const token = sign({ uid: user.id, exp });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: SESSION_TTL_SEC,
  });
}

export function buildAuthRoutes() {
  const app = new Hono();

  app.get("/api/auth/me", async (c) => {
    const user = await currentUser(c);
    return c.json({
      user: user ? { id: user.id, email: user.email, name: user.name, provider: user.provider } : null,
      config: {
        google: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
        email: emailConfigured(),
      },
    });
  });

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  /* ---------------- Magic-link flow ---------------- */
  app.post("/api/auth/magic/request", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ ok: false, error: "Please enter a valid email address." }, 400);
    }
    if (!emailConfigured()) {
      return c.json({ ok: false, error: "Email sign-in isn't configured on this server. Try Google sign-in, or keep using Atomic without signing in." }, 400);
    }
    const token = randomBytes(24).toString("hex");
    const hash = createHash("sha256").update(token).digest("hex");
    const exp = Math.floor(Date.now() / 1000) + MAGIC_TTL_SEC;
    // Encode the pending email + hash into a signed cookie — we never store
    // pending-link state server-side. The cookie carries what we need to
    // complete the link when the user clicks it.
    setCookie(c, MAGIC_COOKIE, sign({ email, hash, exp }), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: new URL(c.req.url).protocol === "https:",
      maxAge: MAGIC_TTL_SEC,
    });
    const origin = new URL(c.req.url).origin;
    const link = `${origin}/api/auth/magic/confirm?token=${encodeURIComponent(token)}`;
    const result = await sendMail({
      to: email,
      subject: "Your Atomic sign-in link",
      text: `Click to sign in to Atomic: ${link}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
      html:
        `<p>Click the button to sign in to Atomic.</p>` +
        `<p><a href="${link}" style="background:#1a73e8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Sign in</a></p>` +
        `<p style="color:#555;font-size:13px">Or paste this into your browser: <br>${link}</p>` +
        `<p style="color:#555;font-size:13px">This link expires in 15 minutes. Ignore this email if you didn't request it.</p>`,
    });
    if (!result.ok) {
      return c.json({ ok: false, error: "We couldn't send the sign-in email. (" + (result.reason || "unknown") + ")" }, 500);
    }
    return c.json({ ok: true, message: "Check your inbox — we sent you a sign-in link." });
  });

  app.get("/api/auth/magic/confirm", async (c) => {
    const token = String(c.req.query("token") || "");
    const cookie = getCookie(c, MAGIC_COOKIE);
    const payload = verify(cookie);
    if (!payload?.email || !payload?.hash || !token) {
      return c.html(magicPage("Sign-in link is invalid or expired. Please try again."), 400);
    }
    const hash = createHash("sha256").update(token).digest("hex");
    if (hash !== payload.hash) {
      return c.html(magicPage("Sign-in link doesn't match this browser. Please request a new link."), 400);
    }
    const user = await upsertUser({
      email: payload.email,
      name: payload.email.split("@")[0],
      provider: "email",
      sub: payload.email,
    });
    deleteCookie(c, MAGIC_COOKIE, { path: "/" });
    await setSession(c, user);
    return c.redirect("/?signedin=1");
  });

  /* ---------------- Google OAuth flow ---------------- */
  app.get("/api/auth/google/start", (c) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return c.text("Google sign-in isn't configured on this server.", 400);
    const origin = new URL(c.req.url).origin;
    const redirect = origin + "/api/auth/google/callback";
    const state = randomBytes(16).toString("hex");
    setCookie(c, "atomic_gstate", state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: new URL(c.req.url).protocol === "https:",
      maxAge: 600,
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: "openid email profile",
      access_type: "online",
      state,
      prompt: "select_account",
    });
    return c.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString());
  });

  app.get("/api/auth/google/callback", async (c) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return c.text("Google sign-in isn't configured.", 400);
    const state = c.req.query("state");
    const code = c.req.query("code");
    const cookieState = getCookie(c, "atomic_gstate");
    if (!state || !code || state !== cookieState) {
      return c.text("Sign-in was cancelled or the state didn't match.", 400);
    }
    deleteCookie(c, "atomic_gstate", { path: "/" });

    const origin = new URL(c.req.url).origin;
    const redirect = origin + "/api/auth/google/callback";
    const tokenRes = await privateFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect,
        grant_type: "authorization_code",
      }).toString(),
      timeout: 10000,
    });
    if (!tokenRes.ok) return c.text("Google sign-in failed (token exchange).", 400);
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokens.access_token) return c.text("Google sign-in failed.", 400);

    const profileRes = await privateFetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: "Bearer " + tokens.access_token },
      timeout: 10000,
    });
    if (!profileRes.ok) return c.text("Google sign-in failed (profile).", 400);
    const profile = await profileRes.json().catch(() => ({}));
    if (!profile?.email) return c.text("Google sign-in failed (no email).", 400);

    const user = await upsertUser({
      email: profile.email,
      name: profile.name || profile.email.split("@")[0],
      provider: "google",
      sub: profile.id || profile.email,
    });
    await setSession(c, user);
    return c.redirect("/?signedin=1");
  });

  return app;
}

function magicPage(body) {
  return `<!doctype html><meta charset="utf-8"><title>Sign in — Atomic</title>
<link rel="stylesheet" href="/css/themes.css">
<link rel="stylesheet" href="/css/styles.css">
<body data-theme="atom-dark" class="interstitial">
<main style="max-width:540px;margin:80px auto;padding:28px;text-align:center">
<h1>Sign in</h1>
<p style="color:var(--text-dim)">${body}</p>
<p><a href="/" style="background:var(--accent);color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Back to Atomic</a></p>
</main></body>`;
}
