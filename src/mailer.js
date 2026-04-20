// Tiny SMTP wrapper. Uses `nodemailer` if available; otherwise no-ops and the
// caller is responsible for surfacing a clear "email delivery isn't configured"
// message to the user.
//
// Env:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   SMTP_SECURE = "true" to force TLS (usually port 465)

let _transport = null;
let _tried = false;

async function transport() {
  if (_tried) return _transport;
  _tried = true;
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  let nodemailer;
  try {
    nodemailer = (await import("nodemailer")).default || (await import("nodemailer"));
  } catch {
    console.warn("[mailer] nodemailer not installed; email sign-in disabled");
    return null;
  }
  _transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return _transport;
}

export function emailConfigured() {
  return !!process.env.SMTP_HOST;
}

export async function sendMail({ to, subject, text, html }) {
  const tx = await transport();
  if (!tx) return { ok: false, reason: "not-configured" };
  const from = process.env.SMTP_FROM || "Atomic Search <noreply@atomicsearch.local>";
  try {
    await tx.sendMail({ from, to, subject, text, html });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || "send-failed" };
  }
}
