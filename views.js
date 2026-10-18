const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const OWNER = process.env.OWNER_NAME || "Tung Nguyen";

const fmtDate = (d) =>
  d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: process.env.TZ_DISPLAY || "America/New_York" }) : "";
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");
const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

function layout({ title, body, mode = "admin", head = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">
${head}
</head>
<body class="${mode}">
${body}
</body>
</html>`;
}

function adminShell(title, content) {
  return layout({
    title: `${title} | Docs`,
    body: `<header class="topbar">
  <a class="brand" href="/admin">Docs</a>
  <form method="post" action="/admin/logout"><button class="link-btn" type="submit">Sign out</button></form>
</header>
<main class="admin-main">${content}</main>`,
  });
}

export function login(error) {
  return layout({
    title: "Sign in | Docs",
    mode: "gate",
    body: `<main class="gate-main">
  <h1 class="gate-title">Docs</h1>
  <form method="post" action="/admin/login" class="gate-form">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    <button type="submit">Sign in</button>
  </form>
</main>`,
  });
}

export function dashboard(docs, error) {
  const rows = docs.length
    ? docs
        .map(
          (d) => `<tr>
      <td><a href="/admin/documents/${d.id}">${esc(d.title)}</a></td>
      <td class="num">${d.page_count ?? ""}</td>
      <td class="num">${d.view_count}</td>
      <td class="when">${d.last_viewed ? fmtDate(d.last_viewed) : '<span class="muted">Not opened yet</span>'}</td>
      <td class="muted">${fmtDay(d.created_at)}</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Upload a PDF to create your first share link.</td></tr>`;

  return adminShell(
    "Documents",
    `<section class="upload">
  <h1>Documents</h1>
  <form method="post" action="/admin/documents" enctype="multipart/form-data" class="upload-form">
    <label>Title <input name="title" placeholder="Uses the file name if left blank" maxlength="200"></label>
    <label>PDF <input name="file" type="file" accept="application/pdf" required></label>
    <button type="submit">Upload</button>
  </form>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
</section>
<table class="data">
  <thead><tr><th>Title</th><th class="num">Pages</th><th class="num">Visits</th><th>Last opened</th><th>Added</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`,
  );
}

export function documentPage({ doc, links, views, pages, baseUrl }) {
  const now = new Date();
  const linkRows = links.length
    ? links
        .map((l) => {
          const url = `${baseUrl}/d/${l.id}`;
          const expired = l.expires_at && new Date(l.expires_at) < now;
          const status = l.disabled ? "Turned off" : expired ? "Expired" : "Live";
          const access = !l.require_email
            ? "Open to anyone with the link"
            : l.allowed_emails
              ? `Only ${l.allowed_emails}`
              : l.verify_email
                ? "Any verified email"
                : "Any email";
          const rules = [
            access,
            l.require_email && l.lock_email ? (l.locked_email ? `Locked to ${l.locked_email}` : "Locks to first email") : null,
            l.watermark ? "Watermark" : null,
            l.screen_protect ? "Screenshot protection" : null,
            l.allow_download ? "Download on" : null,
            l.expires_at ? `Expires ${fmtDay(l.expires_at)}` : null,
          ]
            .filter(Boolean)
            .map(esc)
            .join("<br>");
          return `<tr class="${status === "Live" ? "" : "inactive"}">
      <td>${esc(l.label)}</td>
      <td><input class="url" value="${esc(url)}" readonly aria-label="Link for ${esc(l.label)}"> <button type="button" class="copy" data-url="${esc(url)}">Copy</button></td>
      <td class="muted small-text">${rules}</td>
      <td class="num">${l.view_count}</td>
      <td>${status}</td>
      <td class="actions"><form method="post" action="/admin/links/${l.id}/toggle"><button class="link-btn" type="submit">${l.disabled ? "Turn on" : "Turn off"}</button></form>${
        l.locked_email
          ? `<form method="post" action="/admin/links/${l.id}/unlock"><button class="link-btn" type="submit">Unlock</button></form>`
          : ""
      }</td>
    </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="empty">Create a link for each person or firm, so you can tell who read what.</td></tr>`;

  const total = doc.page_count || Math.max(0, ...pages.map((p) => p.page));
  const viewRows = views.length
    ? views
        .map(
          (vw) => `<tr>
      <td>${vw.email ? esc(vw.email) : '<span class="muted">No email asked</span>'}</td>
      <td>${esc(vw.label)}</td>
      <td class="when">${fmtDate(vw.started_at)}</td>
      <td class="num">${fmtDuration(vw.total_ms)}</td>
      <td class="num">${vw.pages_seen}${total ? ` of ${total}` : ""}</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Visits show up here once someone opens a link.</td></tr>`;

  const maxAvg = Math.max(1, ...pages.map((p) => p.avg_ms));
  const pageBars = pages.length
    ? `<ol class="bars">${pages
        .map(
          (p) => `<li>
        <span class="bar-label">Page ${p.page}</span>
        <span class="bar-track"><span class="bar" style="width:${Math.max(2, Math.round((p.avg_ms / maxAvg) * 100))}%"></span></span>
        <span class="bar-value">${fmtDuration(p.avg_ms)}</span>
      </li>`,
        )
        .join("")}</ol>`
    : `<p class="empty">Average time per page appears after the first visit.</p>`;

  return adminShell(
    doc.title,
    `<p class="crumb"><a href="/admin">Documents</a></p>
<div class="doc-head">
  <h1>${esc(doc.title)}</h1>
  <p class="muted">${esc(doc.filename)}, ${fmtSize(doc.size_bytes)}${doc.page_count ? `, ${doc.page_count} pages` : ""}</p>
</div>

<section>
  <h2>Links</h2>
  <form method="post" action="/admin/documents/${doc.id}/links" class="link-form">
    <label class="grow">Who is it for? <input name="label" placeholder="e.g. Jane Park, Sequoia" maxlength="120" required></label>
    <label>Expires <input type="date" name="expires_on"></label>
    <label class="full">Allowed emails or domains <input name="allowed_emails" placeholder="jane@fund.com, fund.com. Listed emails skip the code. Leave blank to allow anyone who verifies." maxlength="2000"></label>
    <fieldset class="checks">
      <label class="check"><input type="checkbox" name="require_email" checked> Ask for email</label>
      <label class="check"><input type="checkbox" name="verify_email" checked> Email a code to unlisted emails</label>
      <label class="check"><input type="checkbox" name="lock_email" checked> Lock to first email</label>
      <label class="check"><input type="checkbox" name="watermark" checked> Watermark pages</label>
      <label class="check"><input type="checkbox" name="screen_protect" checked> Screenshot protection</label>
      <label class="check"><input type="checkbox" name="allow_download"> Allow download</label>
    </fieldset>
    <button type="submit">Create link</button>
  </form>
  <table class="data">
    <thead><tr><th>For</th><th>Link</th><th>Rules</th><th class="num">Visits</th><th>Status</th><th></th></tr></thead>
    <tbody>${linkRows}</tbody>
  </table>
</section>

<section class="split">
  <div>
    <h2>Visits</h2>
    <table class="data">
      <thead><tr><th>Email</th><th>Link</th><th>Opened</th><th class="num">Time</th><th class="num">Pages</th></tr></thead>
      <tbody>${viewRows}</tbody>
    </table>
  </div>
  <div>
    <h2>Time per page</h2>
    <p class="muted small">Average across visits</p>
    ${pageBars}
  </div>
</section>

<p class="danger-zone"><a href="/admin/documents/${doc.id}/delete">Delete this document</a></p>
<script>
document.querySelectorAll(".copy").forEach((b) => b.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(b.dataset.url); b.textContent = "Copied"; }
  catch { b.previousElementSibling.select(); }
  setTimeout(() => (b.textContent = "Copy"), 1500);
}));
</script>`,
  );
}

export function confirmDelete(doc) {
  return adminShell(
    "Delete",
    `<p class="crumb"><a href="/admin/documents/${doc.id}">${esc(doc.title)}</a></p>
<h1>Delete ${esc(doc.title)}?</h1>
<p>This removes the file, every link to it, and all visit history. Links you already sent will stop working.</p>
<form method="post" action="/admin/documents/${doc.id}/delete" class="inline-actions">
  <button type="submit" class="danger">Delete document</button>
  <a href="/admin/documents/${doc.id}">Keep it</a>
</form>`,
  );
}

export function gate(link, error) {
  return layout({
    title: link.title,
    mode: "gate",
    body: `<main class="gate-main">
  <p class="gate-from">Shared by ${esc(OWNER)}</p>
  <h1 class="gate-title">${esc(link.title)}</h1>
  <form method="post" action="/d/${link.id}" class="gate-form">
    <label for="email">Your email</label>
    <input id="email" name="email" type="email" autocomplete="email" required autofocus>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    <button type="submit">Open document</button>
    <p class="fine">${esc(OWNER)} will see that you opened this document.</p>
  </form>
</main>`,
  });
}

export function codeForm(link, email, error) {
  return layout({
    title: link.title,
    mode: "gate",
    body: `<main class="gate-main">
  <p class="gate-from">Shared by ${esc(OWNER)}</p>
  <h1 class="gate-title">${esc(link.title)}</h1>
  <form method="post" action="/d/${link.id}/verify" class="gate-form">
    <input type="hidden" name="email" value="${esc(email)}">
    <label for="code">Enter the 6-digit code sent to ${esc(email)}</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    <button type="submit">Open document</button>
    <p class="fine">The code expires in 10 minutes. <a class="on-dark" href="/d/${link.id}">Use a different email</a></p>
  </form>
</main>`,
  });
}

const stamp = () =>
  new Date().toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: process.env.TZ_DISPLAY || "America/New_York",
  });

export function viewer(link, viewId, email) {
  const fileUrl = `/d/${link.id}/file?v=${viewId}`;
  const mark = link.watermark ? `${email || link.label}  ${stamp()}` : "";
  return layout({
    title: link.title,
    mode: link.screen_protect ? "viewer protect" : "viewer",
    head: `<script type="module" src="/static/viewer.js"></script>`,
    body: `<header class="viewer-bar">
  <div class="viewer-title"><strong>${esc(link.title)}</strong><span>Shared by ${esc(OWNER)}</span></div>
  ${link.allow_download ? `<a class="viewer-dl" href="${fileUrl}&dl=1">Download PDF</a>` : ""}
</header>
<main id="stage" class="stage" data-file="${fileUrl}" data-view="${viewId}" data-mark="${esc(mark)}" data-protect="${link.screen_protect ? "1" : ""}" tabindex="-1">
  <canvas id="page" aria-label="Document page"></canvas>
  <p id="status" class="stage-status">Loading document</p>
  <div id="shield" class="shield" hidden><p id="shield-text">Return to this window to keep reading.</p></div>
</main>
<nav class="pager" aria-label="Pages">
  <button id="prev" type="button" aria-label="Previous page">Previous</button>
  <span id="count" aria-live="polite"></span>
  <button id="next" type="button" aria-label="Next page">Next</button>
</nav>`,
  });
}

export function home(homeUrl) {
  return layout({
    title: "Docs",
    mode: "gate",
    body: `<main class="gate-main">
  <p class="gate-from">${esc(OWNER)}</p>
  <h1 class="gate-title">Documents are shared by private link</h1>
  <p class="gate-copy">If you were sent a link, open it directly. Otherwise, visit <a class="on-dark" href="${esc(homeUrl)}">${esc(homeUrl.replace(/^https?:\/\//, ""))}</a>.</p>
</main>`,
  });
}

export function notFound() {
  return layout({
    title: "Link not available",
    mode: "gate",
    body: `<main class="gate-main">
  <h1 class="gate-title">This link isn't available</h1>
  <p class="gate-copy">It may have expired or been turned off. Ask the person who sent it for a new one.</p>
</main>`,
  });
}

export function errorPage() {
  return layout({
    title: "Something broke",
    mode: "gate",
    body: `<main class="gate-main">
  <h1 class="gate-title">Something broke on our side</h1>
  <p class="gate-copy">Reload the page in a minute. If it keeps happening, tell the person who sent the link.</p>
</main>`,
  });
}
