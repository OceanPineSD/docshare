import * as pdfjsLib from "/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

const stage = document.getElementById("stage");
const sheet = document.getElementById("sheet");
const canvas = document.getElementById("page");
const status = document.getElementById("status");
const count = document.getElementById("count");
const prev = document.getElementById("prev");
const next = document.getElementById("next");
const zoomIn = document.getElementById("zoom-in");
const zoomOut = document.getElementById("zoom-out");
const zoomFit = document.getElementById("zoom-fit");
const viewId = stage.dataset.view;
const mark = stage.dataset.mark;
const protect = stage.dataset.protect === "1";
const shield = document.getElementById("shield");
const shieldText = document.getElementById("shield-text");

const MIN_ZOOM = 1; // 1 = whole page fits the screen
const MAX_ZOOM = 5;
const MAX_CANVAS_PIXELS = 16_000_000; // stays under mobile Safari's canvas limit

let pdf = null;
let current = 1;
let zoom = 1;
let rendering = Promise.resolve();

// ---------- reading-time tracking ----------
// Time counts only while the tab is visible. It is flushed every 10 seconds,
// on page turn, and when the tab is hidden or closed.

let pageStart = document.visibilityState === "visible" ? performance.now() : null;
let pending = 0;

function settle() {
  if (pageStart !== null) {
    pending += performance.now() - pageStart;
    pageStart = document.visibilityState === "visible" ? performance.now() : null;
  }
}

function flush() {
  settle();
  if (!pdf || pending < 250) return;
  const body = JSON.stringify({ page: current, ms: Math.round(pending), pages: pdf.numPages });
  pending = 0;
  navigator.sendBeacon(`/t/${viewId}`, new Blob([body], { type: "application/json" }));
}

setInterval(flush, 10_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
  else pageStart = performance.now();
});
window.addEventListener("pagehide", flush);

// ---------- rendering ----------

function fitScale(base) {
  const pad = window.innerWidth <= 800 ? 16 : 48; // matches .sheet padding
  const maxW = stage.clientWidth - pad * 2;
  const maxH = stage.clientHeight - pad * 2;
  return Math.min(maxW / base.width, maxH / base.height);
}

// Renders page n at the current zoom. `focus` is a point in stage coordinates
// (0..1 of the visible area) that stays put while zooming.
function render(n, focus) {
  rendering = rendering.then(async () => {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: fitScale(base) * zoom });

    // Remember which part of the page sits under the focus point.
    const fx = focus ? focus.x : 0.5;
    const fy = focus ? focus.y : 0.5;
    const anchorX = (stage.scrollLeft + stage.clientWidth * fx) / Math.max(sheet.scrollWidth, 1);
    const anchorY = (stage.scrollTop + stage.clientHeight * fy) / Math.max(sheet.scrollHeight, 1);

    const dpr = window.devicePixelRatio || 1;
    const ratio = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.style.transform = "";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (mark) drawWatermark(ctx, viewport.width, viewport.height);

    stage.classList.toggle("zoomed", zoom > MIN_ZOOM);
    if (focus) {
      stage.scrollLeft = anchorX * sheet.scrollWidth - stage.clientWidth * fx;
      stage.scrollTop = anchorY * sheet.scrollHeight - stage.clientHeight * fy;
    }
    updateZoomUi();
  });
  return rendering;
}

// Tiled diagonal text with the viewer's email and the time, drawn into the page
// pixels so any screenshot or photo carries it.
function drawWatermark(ctx, w, h) {
  const size = Math.max(11, Math.round(Math.min(w, h) / 38));
  ctx.save();
  ctx.font = `600 ${size}px "Schibsted Grotesk", system-ui, sans-serif`;
  ctx.fillStyle = "rgba(19, 33, 46, 0.11)";
  ctx.textBaseline = "middle";
  const stepX = ctx.measureText(mark).width + size * 4;
  const stepY = size * 7;
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 7);
  const reach = Math.hypot(w, h);
  for (let y = -reach; y < reach; y += stepY) {
    const offset = (Math.round(y / stepY) % 2) * (stepX / 2);
    for (let x = -reach; x < reach; x += stepX) ctx.fillText(mark, x + offset, y);
  }
  ctx.restore();
  ctx.save();
  ctx.font = `600 ${Math.max(10, size - 2)}px "Schibsted Grotesk", system-ui, sans-serif`;
  ctx.fillStyle = "rgba(19, 33, 46, 0.45)";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(mark, w - size, h - size * 0.8);
  ctx.restore();
}

function updatePager() {
  count.textContent = `${current} of ${pdf.numPages}`;
  prev.disabled = current <= 1;
  next.disabled = current >= pdf.numPages;
}

function updateZoomUi() {
  zoomFit.textContent = zoom === MIN_ZOOM ? "Fit" : `${Math.round(zoom * 100)}%`;
  zoomFit.setAttribute("aria-label", zoom === MIN_ZOOM ? "Page fits screen" : "Fit page to screen");
  zoomOut.disabled = zoom <= MIN_ZOOM;
  zoomIn.disabled = zoom >= MAX_ZOOM;
}

async function go(n) {
  if (!pdf || n < 1 || n > pdf.numPages || n === current) return;
  flush();
  current = n;
  updatePager();
  await render(current);
  stage.scrollTo(0, 0);
}

function setZoom(value, focus) {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
  if (!pdf || z === zoom) return;
  zoom = z;
  render(current, focus || { x: 0.5, y: 0.5 });
}

// Converts a viewport point to 0..1 of the stage's visible area.
function stagePoint(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
}

prev.addEventListener("click", () => go(current - 1));
next.addEventListener("click", () => go(current + 1));
zoomIn.addEventListener("click", () => setZoom(zoom * 1.5));
zoomOut.addEventListener("click", () => setZoom(zoom / 1.5));
zoomFit.addEventListener("click", () => setZoom(MIN_ZOOM));

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey) {
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      setZoom(zoom * 1.5);
    } else if (e.key === "-") {
      e.preventDefault();
      setZoom(zoom / 1.5);
    } else if (e.key === "0") {
      e.preventDefault();
      setZoom(MIN_ZOOM);
    }
    return;
  }
  const zoomedIn = zoom > MIN_ZOOM;
  if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !zoomedIn)) {
    e.preventDefault();
    go(current + 1);
  } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
    e.preventDefault();
    go(current - 1);
  } else if (e.key === "+" || e.key === "=") {
    setZoom(zoom * 1.5);
  } else if (e.key === "-") {
    setZoom(zoom / 1.5);
  }
});

// Ctrl/Cmd + scroll and trackpad pinch (which browsers report as ctrl + wheel).
stage.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY / 200), stagePoint(e.clientX, e.clientY));
  },
  { passive: false },
);

// ---------- touch: pinch to zoom, double-tap, swipe ----------
// The stage takes over pinch so the page re-renders sharp instead of the
// browser magnifying a low-resolution image.

let pinch = null;
let swipeX = null;
let lastTap = 0;

const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

stage.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length === 2) {
      const m = mid(e.touches);
      const r = canvas.getBoundingClientRect();
      pinch = { start: dist(e.touches), scale: 1, mid: m, origin: `${m.x - r.left}px ${m.y - r.top}px` };
      canvas.style.transformOrigin = pinch.origin;
      swipeX = null;
    } else if (e.touches.length === 1) {
      swipeX = zoom === MIN_ZOOM ? e.touches[0].clientX : null;
    }
  },
  { passive: true },
);

stage.addEventListener(
  "touchmove",
  (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    pinch.scale = dist(e.touches) / pinch.start;
    const shown = Math.min(MAX_ZOOM / zoom, Math.max(MIN_ZOOM / zoom, pinch.scale));
    canvas.style.transform = `scale(${shown})`;
  },
  { passive: false },
);

stage.addEventListener("touchend", (e) => {
  if (pinch && e.touches.length < 2) {
    const { scale, mid: m } = pinch;
    pinch = null;
    if (Math.abs(scale - 1) > 0.05) setZoom(zoom * scale, stagePoint(m.x, m.y));
    else canvas.style.transform = "";
    return;
  }
  if (e.touches.length) return;
  const t = e.changedTouches[0];

  const now = Date.now();
  if (now - lastTap < 300) {
    lastTap = 0;
    setZoom(zoom > MIN_ZOOM ? MIN_ZOOM : 2.5, stagePoint(t.clientX, t.clientY));
    return;
  }
  lastTap = now;

  if (swipeX !== null) {
    const dx = t.clientX - swipeX;
    if (Math.abs(dx) > 50) go(current + (dx < 0 ? 1 : -1));
  }
  swipeX = null;
});

// Safari's own pinch gesture would zoom the whole page; the handlers above replace it.
for (const type of ["gesturestart", "gesturechange"]) {
  stage.addEventListener(type, (e) => e.preventDefault());
}

// ---------- screenshot deterrence ----------
// Browsers cannot block screenshots. This hides the page when a capture shortcut
// starts or the window loses focus, and turns off right-click, drag and print.

let shieldTimer;
function showShield(text, ms) {
  shieldText.textContent = text;
  shield.hidden = false;
  document.body.classList.add("shielded");
  clearTimeout(shieldTimer);
  if (ms) shieldTimer = setTimeout(hideShield, ms);
}
function hideShield() {
  if (protect && !document.hasFocus()) return;
  shield.hidden = true;
  document.body.classList.remove("shielded");
}

if (protect) {
  const capture = "Screenshots are turned off for this document.";
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("dragstart", (e) => e.preventDefault());
  document.addEventListener(
    "keydown",
    (e) => {
      const k = e.key.toLowerCase();
      const macCapture = e.metaKey && e.shiftKey; // Cmd+Shift+3/4/5 start with this
      const winSnip = (e.metaKey || e.getModifierState("OS")) && e.shiftKey && k === "s";
      const printOrSave = (e.metaKey || e.ctrlKey) && (k === "p" || k === "s");
      if (k === "printscreen" || macCapture || winSnip || printOrSave) {
        e.preventDefault();
        showShield(printOrSave ? "Printing and saving are turned off for this document." : capture);
      }
    },
    true,
  );
  document.addEventListener(
    "keyup",
    (e) => {
      if (e.key === "PrintScreen") {
        showShield(capture, 2500);
        navigator.clipboard?.writeText("").catch(() => {});
      } else if (!shield.hidden && (e.key === "Meta" || e.key === "Shift" || e.key === "Control")) {
        setTimeout(hideShield, 1200);
      }
    },
    true,
  );
  window.addEventListener("blur", () => showShield("Return to this window to keep reading."));
  window.addEventListener("focus", () => setTimeout(hideShield, 150));
  window.addEventListener("beforeprint", () => showShield("Printing is turned off for this document."));
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => pdf && render(current), 150);
});

try {
  pdf = await pdfjsLib.getDocument({ url: stage.dataset.file, disableAutoFetch: false }).promise;
  status.remove();
  updatePager();
  await render(1);
  stage.focus();
} catch (err) {
  console.error(err);
  status.textContent = "This document couldn't load. Reload the page to try again.";
}
