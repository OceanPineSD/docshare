import * as pdfjsLib from "/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

const stage = document.getElementById("stage");
const canvas = document.getElementById("page");
const status = document.getElementById("status");
const count = document.getElementById("count");
const prev = document.getElementById("prev");
const next = document.getElementById("next");
const viewId = stage.dataset.view;
const mark = stage.dataset.mark;
const protect = stage.dataset.protect === "1";
const shield = document.getElementById("shield");
const shieldText = document.getElementById("shield-text");

let pdf = null;
let current = 1;
let rendering = null;

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

async function render(n) {
  if (rendering) await rendering;
  rendering = (async () => {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const pad = window.innerWidth < 640 ? 16 : 48;
    const maxW = stage.clientWidth - pad * 2;
    const maxH = stage.clientHeight - pad * 2;
    const scale = Math.min(maxW / base.width, maxH / base.height);
    const viewport = page.getViewport({ scale });
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (mark) drawWatermark(ctx, viewport.width, viewport.height);
  })();
  await rendering;
  rendering = null;
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

async function go(n) {
  if (!pdf || n < 1 || n > pdf.numPages || n === current) return;
  flush();
  current = n;
  updatePager();
  await render(current);
}

prev.addEventListener("click", () => go(current - 1));
next.addEventListener("click", () => go(current + 1));
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
    e.preventDefault();
    go(current + 1);
  } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
    e.preventDefault();
    go(current - 1);
  }
});

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

// Swipe on touch screens.
let touchX = null;
stage.addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
stage.addEventListener("touchend", (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 50) go(current + (dx < 0 ? 1 : -1));
  touchX = null;
});

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
