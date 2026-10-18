import * as pdfjsLib from "/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

const stage = document.getElementById("stage");
const canvas = document.getElementById("page");
const status = document.getElementById("status");
const count = document.getElementById("count");
const prev = document.getElementById("prev");
const next = document.getElementById("next");
const viewId = stage.dataset.view;

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
  })();
  await rendering;
  rendering = null;
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
