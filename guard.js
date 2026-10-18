import crypto from "node:crypto";

// ---------- rate limiting ----------
// In-memory sliding windows. Good enough for one small app; limits reset on restart
// and are per instance.

const hits = new Map();

export function limited(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, times] of hits) {
    if (!times.some((t) => now - t < 3600_000)) hits.delete(key);
  }
}, 600_000).unref();

// ---------- bots ----------

const BOT_UA =
  /bot|crawl|spider|slurp|scrap|curl|wget|httpie|python|java\/|okhttp|go-http|axios|node-fetch|undici|libwww|headless|phantom|puppeteer|playwright|selenium/i;

export const isBot = (ua) => !ua || BOT_UA.test(ua);

// ---------- allow lists ----------

export function parseAllowList(text) {
  return String(text || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// An entry is a full address (jane@fund.com) or a domain (fund.com or @fund.com).
export function isAllowed(email, list) {
  const domain = email.split("@")[1];
  return list.some((entry) => {
    if (entry.includes("@") && !entry.startsWith("@")) return entry === email;
    return entry.replace(/^@/, "") === domain;
  });
}

// What a given email may do on a link: "ok", "code", "locked" or "not_allowed".
export function accessFor(link, email) {
  if (link.lock_email && link.locked_email && link.locked_email !== email) return "locked";
  const list = parseAllowList(link.allowed_emails);
  if (list.length) return isAllowed(email, list) ? "ok" : "not_allowed";
  return link.verify_email ? "code" : "ok";
}

// ---------- one-time codes ----------

export const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

export const hashCode = (secret, linkId, email, code) =>
  crypto.createHmac("sha256", secret).update(`${linkId}:${email}:${code}`).digest("hex");

export function sameHash(a, b) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- email ----------

export async function sendCodeEmail({ to, code, title, owner }) {
  if (process.env.DEV_LOG_CODES === "1") {
    console.log(`[dev] code for ${to}: ${code}`);
    return;
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const from = process.env.EMAIL_FROM || `${owner} <docs@tung.digital>`;
  const text = [
    `Your code to open "${title}" is ${code}.`,
    "",
    "It expires in 10 minutes.",
    "If you didn't ask for it, you can ignore this email.",
    "",
    owner,
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#13212e">
<p>Your code to open <strong>${escapeHtml(title)}</strong> is:</p>
<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p>
<p>It expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p>
<p>${escapeHtml(owner)}</p>
</div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: `${code} is your code for ${title}`, text, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
