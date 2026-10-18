import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";

import { getOrCreateSetting, migrate, q } from "./db.js";
import * as g from "./guard.js";
import * as v from "./views.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const HOME_URL = process.env.HOME_URL || "https://tung.digital";
// When set (e.g. docs.tung.digital), every other host redirects here and share links use it.
const CANONICAL_HOST = (process.env.CANONICAL_HOST || "").trim().toLowerCase();
const OWNER = process.env.OWNER_NAME || "Tung Nguyen";
const MAX_UPLOAD_MB = 50;

await migrate();

// The cookie-signing secret is generated once and kept in the database,
// unless SESSION_SECRET is set.
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (await getOrCreateSetting("session_secret", () => crypto.randomBytes(32).toString("hex")));

if (!ADMIN_PASSWORD) {
  console.warn("ADMIN_PASSWORD is not set. Sign-in stays closed until it is added in Secrets.");
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
// "/" stays reachable on every host because Replit health checks use it.
app.use((req, res, next) => {
  if (!CANONICAL_HOST || req.path === "/" || req.hostname === CANONICAL_HOST) return next();
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
});
app.use(cookieParser(SESSION_SECRET));
app.use(express.urlencoded({ extended: false }));
app.use("/static", express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.use(
  "/pdfjs",
  express.static(path.join(__dirname, "node_modules/pdfjs-dist/build"), { maxAge: "7d" }),
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const newId = (bytes = 9) => crypto.randomBytes(bytes).toString("base64url");
const cookieOpts = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  signed: true,
};
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- admin auth ----------

const loginAttempts = new Map();

function requireAdmin(req, res, next) {
  if (req.signedCookies.admin === "1") return next();
  res.redirect("/admin/login");
}

const NO_PASSWORD = "Sign-in is closed. Add ADMIN_PASSWORD in Replit Secrets, then restart.";

app.get("/admin/login", (req, res) => res.send(v.login(ADMIN_PASSWORD ? undefined : NO_PASSWORD)));

app.post("/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).send(v.login(NO_PASSWORD));
  const key = req.ip;
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (recent.length >= 10) {
    return res.status(429).send(v.login("Too many attempts. Try again in 15 minutes."));
  }
  const given = Buffer.from(String(req.body.password || ""));
  const expected = Buffer.from(ADMIN_PASSWORD);
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) {
    loginAttempts.set(key, [...recent, now]);
    return res.status(401).send(v.login("That password is wrong."));
  }
  loginAttempts.delete(key);
  res.cookie("admin", "1", { ...cookieOpts, maxAge: 30 * 24 * 3600 * 1000 });
  res.redirect("/admin");
});

app.post("/admin/logout", (req, res) => {
  res.clearCookie("admin");
  res.redirect("/admin/login");
});

// ---------- admin pages ----------

app.get(
  "/admin",
  requireAdmin,
  wrap(async (req, res) => {
    const { rows } = await q(`
      select d.*,
        (select count(*) from views vw join links l on l.id = vw.link_id where l.document_id = d.id)::int as view_count,
        (select max(vw.last_seen_at) from views vw join links l on l.id = vw.link_id where l.document_id = d.id) as last_viewed
      from documents d order by d.created_at desc`);
    res.send(v.dashboard(rows, req.query.error));
  }),
);

app.post(
  "/admin/documents",
  requireAdmin,
  (req, res, next) =>
    upload.single("file")(req, res, (err) => {
      if (err) return res.redirect(`/admin?error=${encodeURIComponent(`Files must be under ${MAX_UPLOAD_MB} MB.`)}`);
      next();
    }),
  wrap(async (req, res) => {
    const file = req.file;
    if (!file || file.buffer.subarray(0, 5).toString() !== "%PDF-") {
      return res.redirect(`/admin?error=${encodeURIComponent("Upload a PDF file.")}`);
    }
    const id = newId();
    const title = (req.body.title || "").trim() || file.originalname.replace(/\.pdf$/i, "");
    await q("insert into documents (id, title, filename, size_bytes) values ($1, $2, $3, $4)", [
      id,
      title.slice(0, 200),
      file.originalname.slice(0, 200),
      file.size,
    ]);
    await q("insert into document_files (document_id, data) values ($1, $2)", [id, file.buffer]);
    res.redirect(`/admin/documents/${id}`);
  }),
);

app.get(
  "/admin/documents/:id",
  requireAdmin,
  wrap(async (req, res) => {
    const doc = (await q("select * from documents where id = $1", [req.params.id])).rows[0];
    if (!doc) return res.status(404).send(v.notFound());
    const links = (
      await q(
        `select l.*, (select count(*) from views where link_id = l.id)::int as view_count
         from links l where document_id = $1 order by created_at desc`,
        [doc.id],
      )
    ).rows;
    const views = (
      await q(
        `select vw.id, vw.email, vw.started_at, vw.last_seen_at, l.label,
           coalesce(sum(pv.duration_ms), 0)::int as total_ms,
           count(pv.page) filter (where pv.duration_ms >= 1000)::int as pages_seen
         from views vw
         join links l on l.id = vw.link_id
         left join page_views pv on pv.view_id = vw.id
         where l.document_id = $1
         group by vw.id, l.label
         order by vw.started_at desc
         limit 200`,
        [doc.id],
      )
    ).rows;
    const pages = (
      await q(
        `select pv.page, avg(pv.duration_ms)::int as avg_ms, count(*)::int as viewers
         from page_views pv
         join views vw on vw.id = pv.view_id
         join links l on l.id = vw.link_id
         where l.document_id = $1
         group by pv.page order by pv.page`,
        [doc.id],
      )
    ).rows;
    const baseUrl = CANONICAL_HOST ? `https://${CANONICAL_HOST}` : `${req.protocol}://${req.get("host")}`;
    res.send(v.documentPage({ doc, links, views, pages, baseUrl }));
  }),
);

app.post(
  "/admin/documents/:id/links",
  requireAdmin,
  wrap(async (req, res) => {
    const b = req.body;
    const expiresAt = b.expires_on ? new Date(`${b.expires_on}T23:59:59Z`) : null;
    const allowed = g.parseAllowList(b.allowed_emails).join(", ").slice(0, 2000);
    await q(
      `insert into links (id, document_id, label, require_email, allow_download, expires_at,
         allowed_emails, verify_email, lock_email, watermark, screen_protect)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        newId(6),
        req.params.id,
        (b.label || "").trim().slice(0, 120) || "Untitled link",
        b.require_email === "on",
        b.allow_download === "on",
        expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
        allowed,
        b.verify_email === "on",
        b.lock_email === "on",
        b.watermark === "on",
        b.screen_protect === "on",
      ],
    );
    res.redirect(`/admin/documents/${req.params.id}`);
  }),
);

app.post(
  "/admin/links/:id/toggle",
  requireAdmin,
  wrap(async (req, res) => {
    const { rows } = await q(
      "update links set disabled = not disabled where id = $1 returning document_id",
      [req.params.id],
    );
    res.redirect(rows[0] ? `/admin/documents/${rows[0].document_id}` : "/admin");
  }),
);

app.post(
  "/admin/links/:id/unlock",
  requireAdmin,
  wrap(async (req, res) => {
    const { rows } = await q(
      "update links set locked_email = null where id = $1 returning document_id",
      [req.params.id],
    );
    res.redirect(rows[0] ? `/admin/documents/${rows[0].document_id}` : "/admin");
  }),
);

app.get(
  "/admin/documents/:id/delete",
  requireAdmin,
  wrap(async (req, res) => {
    const doc = (await q("select * from documents where id = $1", [req.params.id])).rows[0];
    if (!doc) return res.status(404).send(v.notFound());
    res.send(v.confirmDelete(doc));
  }),
);

app.post(
  "/admin/documents/:id/delete",
  requireAdmin,
  wrap(async (req, res) => {
    await q("delete from documents where id = $1", [req.params.id]);
    res.redirect("/admin");
  }),
);

// ---------- viewer ----------

async function getLiveLink(slug) {
  const { rows } = await q(
    `select l.*, d.title, d.page_count from links l
     join documents d on d.id = l.document_id where l.id = $1`,
    [slug],
  );
  const link = rows[0];
  if (!link || link.disabled) return null;
  if (link.expires_at && new Date(link.expires_at) < new Date()) return null;
  return link;
}

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
const MIN = 60_000;
const lockedMsg = `This link is reserved for someone else. Ask ${OWNER} for your own link.`;
const notAllowedMsg = "This email doesn't have access. Use the address this link was sent to.";

// Bots and scripted clients never see documents.
function blockBots(req, res, next) {
  if (g.isBot(req.get("user-agent"))) return res.status(404).send(v.notFound());
  next();
}

async function grant(res, link, email) {
  if (link.lock_email) {
    await q("update links set locked_email = $2 where id = $1 and locked_email is null", [link.id, email]);
    const { rows } = await q("select locked_email from links where id = $1", [link.id]);
    if (rows[0].locked_email !== email) return res.status(403).send(v.gate(link, lockedMsg));
  }
  res.cookie(`e_${link.id}`, email, { ...cookieOpts, maxAge: 90 * 24 * 3600 * 1000 });
  res.redirect(`/d/${link.id}`);
}

app.get(
  "/d/:slug",
  blockBots,
  wrap(async (req, res) => {
    const link = await getLiveLink(req.params.slug);
    if (!link) return res.status(404).send(v.notFound());
    let email = null;
    if (link.require_email) {
      email = req.signedCookies[`e_${link.id}`] || null;
      // A saved email still has to pass the current lock and allow list.
      const access = email ? g.accessFor(link, email) : null;
      if (access === "locked") return res.send(v.gate(link, lockedMsg));
      if (access === "not_allowed") return res.send(v.gate(link, notAllowedMsg));
      if (!email) return res.send(v.gate(link));
      if (link.lock_email && !link.locked_email) {
        await q("update links set locked_email = $2 where id = $1 and locked_email is null", [link.id, email]);
      }
    }
    const viewId = newId(12);
    await q("insert into views (id, link_id, email, user_agent) values ($1, $2, $3, $4)", [
      viewId,
      link.id,
      email,
      (req.get("user-agent") || "").slice(0, 300),
    ]);
    res.set("Cache-Control", "no-store");
    res.send(v.viewer(link, viewId, email));
  }),
);

app.post(
  "/d/:slug",
  blockBots,
  wrap(async (req, res) => {
    const link = await getLiveLink(req.params.slug);
    if (!link) return res.status(404).send(v.notFound());
    if (g.limited(`gate:${req.ip}`, 20, 10 * MIN)) {
      return res.status(429).send(v.gate(link, "Too many attempts. Wait 10 minutes and try again."));
    }
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).send(v.gate(link, "Enter a valid email address."));

    const access = g.accessFor(link, email);
    if (access === "locked") return res.status(403).send(v.gate(link, lockedMsg));
    if (access === "not_allowed") return res.status(403).send(v.gate(link, notAllowedMsg));
    if (access === "ok") return grant(res, link, email);

    // access === "code"
    if (
      g.limited(`send:${link.id}:${email}`, 3, 15 * MIN) ||
      g.limited(`send-ip:${req.ip}`, 10, 60 * MIN)
    ) {
      return res.status(429).send(v.codeForm(link, email, "We already sent a code. Check your inbox, or wait 15 minutes."));
    }
    const code = g.newCode();
    await q(
      `insert into email_codes (link_id, email, code_hash, expires_at)
       values ($1, $2, $3, now() + interval '10 minutes')
       on conflict (link_id, email) do update
       set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = now()`,
      [link.id, email, g.hashCode(SESSION_SECRET, link.id, email, code)],
    );
    try {
      await g.sendCodeEmail({ to: email, code, title: link.title, owner: OWNER });
    } catch (err) {
      console.error("code email failed:", err.message);
      return res.status(502).send(v.gate(link, "We couldn't send a code right now. Try again in a minute."));
    }
    res.send(v.codeForm(link, email));
  }),
);

app.post(
  "/d/:slug/verify",
  blockBots,
  wrap(async (req, res) => {
    const link = await getLiveLink(req.params.slug);
    if (!link) return res.status(404).send(v.notFound());
    const email = String(req.body.email || "").trim().toLowerCase();
    const code = String(req.body.code || "").replace(/\D/g, "");
    if (!isEmail(email)) return res.status(400).send(v.gate(link));
    if (g.limited(`verify:${req.ip}`, 30, 10 * MIN)) {
      return res.status(429).send(v.codeForm(link, email, "Too many attempts. Wait 10 minutes and try again."));
    }
    const row = (
      await q(
        "select code_hash, attempts, expires_at > now() as live from email_codes where link_id = $1 and email = $2",
        [link.id, email],
      )
    ).rows[0];
    if (!row || !row.live || row.attempts >= 5) {
      await q("delete from email_codes where link_id = $1 and email = $2", [link.id, email]);
      return res.status(400).send(v.gate(link, "That code expired. Enter your email to get a new one."));
    }
    if (!g.sameHash(row.code_hash, g.hashCode(SESSION_SECRET, link.id, email, code))) {
      await q("update email_codes set attempts = attempts + 1 where link_id = $1 and email = $2", [link.id, email]);
      return res.status(400).send(v.codeForm(link, email, "That code is wrong. Check the email and try again."));
    }
    await q("delete from email_codes where link_id = $1 and email = $2", [link.id, email]);
    const fresh = await getLiveLink(link.id);
    if (g.accessFor(fresh, email) === "locked") return res.status(403).send(v.gate(link, lockedMsg));
    return grant(res, fresh, email);
  }),
);

app.get(
  "/d/:slug/file",
  blockBots,
  wrap(async (req, res) => {
    if (g.limited(`file:${req.ip}`, 30, MIN)) return res.status(429).end();
    const link = await getLiveLink(req.params.slug);
    if (!link) return res.status(404).end();
    const view = (
      await q(
        "select id from views where id = $1 and link_id = $2 and started_at > now() - interval '12 hours'",
        [req.query.v, link.id],
      )
    ).rows[0];
    if (!view) return res.status(403).end();
    const download = req.query.dl === "1" && link.allow_download;
    // Without download rights, the file only goes to the viewer script, not to a browser tab.
    if (!download && !link.allow_download && req.get("sec-fetch-dest") === "document") {
      return res.status(403).send(v.notFound());
    }
    const { rows } = await q(
      "select f.data, d.filename from document_files f join documents d on d.id = f.document_id where f.document_id = $1",
      [link.document_id],
    );
    if (!rows[0]) return res.status(404).end();
    res.set({
      "Content-Type": "application/pdf",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${rows[0].filename.replace(/[^\w.\- ]/g, "_")}"`,
    });
    res.send(rows[0].data);
  }),
);

// Viewer beacons: { page, ms, pages }. Time per beacon is capped so a tab left open
// doesn't inflate reading time.
app.post(
  "/t/:viewId",
  express.json({ type: () => true, limit: "2kb" }),
  wrap(async (req, res) => {
    if (g.limited(`beacon:${req.ip}`, 240, MIN)) return res.status(204).end();
    const page = Number.parseInt(req.body?.page, 10);
    const ms = Math.min(Math.max(Number.parseInt(req.body?.ms, 10) || 0, 0), 60_000);
    const pages = Number.parseInt(req.body?.pages, 10);
    const view = (
      await q(
        `select vw.id, l.document_id from views vw join links l on l.id = vw.link_id where vw.id = $1`,
        [req.params.viewId],
      )
    ).rows[0];
    if (!view || !(page >= 1 && page <= 2000)) return res.status(204).end();
    await q(
      `insert into page_views (view_id, page, duration_ms) values ($1, $2, $3)
       on conflict (view_id, page) do update set duration_ms = page_views.duration_ms + excluded.duration_ms`,
      [view.id, page, ms],
    );
    await q("update views set last_seen_at = now() where id = $1", [view.id]);
    if (pages >= 1 && pages <= 2000) {
      await q("update documents set page_count = $2 where id = $1 and page_count is null", [
        view.document_id,
        pages,
      ]);
    }
    res.status(204).end();
  }),
);

// Replit health checks hit "/" and need a fast 200, so this page never redirects.
app.get("/", (req, res) => {
  if (req.signedCookies.admin === "1") return res.redirect("/admin");
  res.send(v.home(HOME_URL));
});

app.use((req, res) => res.status(404).send(v.notFound()));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(v.errorPage());
});

app.listen(PORT, "0.0.0.0", () => console.log(`docshare listening on ${PORT}`));
