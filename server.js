import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";

import { migrate, q } from "./db.js";
import * as v from "./views.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const HOME_URL = process.env.HOME_URL || "https://tung.digital";
const MAX_UPLOAD_MB = 50;

if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  throw new Error("Set ADMIN_PASSWORD and SESSION_SECRET in Replit Secrets.");
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
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

app.get("/admin/login", (req, res) => res.send(v.login()));

app.post("/admin/login", (req, res) => {
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
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.send(v.documentPage({ doc, links, views, pages, baseUrl }));
  }),
);

app.post(
  "/admin/documents/:id/links",
  requireAdmin,
  wrap(async (req, res) => {
    const { label, require_email, allow_download, expires_on } = req.body;
    const expiresAt = expires_on ? new Date(`${expires_on}T23:59:59Z`) : null;
    await q(
      `insert into links (id, document_id, label, require_email, allow_download, expires_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        newId(6),
        req.params.id,
        (label || "").trim().slice(0, 120) || "Untitled link",
        require_email === "on",
        allow_download === "on",
        expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
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

app.get(
  "/d/:slug",
  wrap(async (req, res) => {
    const link = await getLiveLink(req.params.slug);
    if (!link) return res.status(404).send(v.notFound());
    const email = req.signedCookies[`e_${link.id}`];
    if (link.require_email && !email) return res.send(v.gate(link));
    const viewId = newId(12);
    await q("insert into views (id, link_id, email, user_agent) values ($1, $2, $3, $4)", [
      viewId,
      link.id,
      email || null,
      (req.get("user-agent") || "").slice(0, 300),
    ]);
    res.set("Cache-Control", "no-store");
    res.send(v.viewer(link, viewId));
  }),
);

app.post(
  "/d/:slug",
  wrap(async (req, res) => {
    const link = await getLiveLink(req.params.slug);
    if (!link) return res.status(404).send(v.notFound());
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).send(v.gate(link, "Enter a valid email address."));
    res.cookie(`e_${link.id}`, email, { ...cookieOpts, maxAge: 90 * 24 * 3600 * 1000 });
    res.redirect(`/d/${link.id}`);
  }),
);

app.get(
  "/d/:slug/file",
  wrap(async (req, res) => {
    const link = await getLiveLink(req.params.slug);
    if (!link) return res.status(404).end();
    const view = (await q("select id from views where id = $1 and link_id = $2", [req.query.v, link.id])).rows[0];
    if (!view) return res.status(403).end();
    const download = req.query.dl === "1" && link.allow_download;
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

app.get("/", (req, res) =>
  res.redirect(req.signedCookies.admin === "1" ? "/admin" : HOME_URL),
);

app.use((req, res) => res.status(404).send(v.notFound()));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(v.errorPage());
});

await migrate();
app.listen(PORT, "0.0.0.0", () => console.log(`docshare listening on ${PORT}`));
