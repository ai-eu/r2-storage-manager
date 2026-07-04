// ── usePanZoom: shared pointer/pinch/drag composable ──
//
// Generalizes the pan/zoom/pinch logic duplicated between image viewer
// (transform-based: scale + tx/ty) and PDF viewer (scale + scroll-container pan).
//
// options:
//   minScale, maxScale     — scale bounds (defaults: 1, 5)
//   enabled                — () => boolean gate (e.g. () => viewerOpen.value)
//   panMode                — "translate" | "scroll" (default: "translate")
//   roundScale             — round scale to 2 decimals (default: false)
//   onScaleChange          — (newScale) => void, called after pinch/zoom changes
//   clampTranslate         — () => void, called after translate changes (translate mode)
//   scrollContainer        — () => HTMLElement | null (scroll mode)
//   dragThreshold          — minimum scale to allow single-pointer drag (default: 1)
//
// Returns refs + pointer handlers + zoom helpers. Not connected to viewers yet
// (stage 5); wiring happens in stage 6 via useImageViewer / usePdfViewer.

import { ref } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export const usePanZoom = (options = {}) => {
  const {
    minScale = 1,
    maxScale = 5,
    enabled = () => true,
    panMode = "translate",
    roundScale = false,
    onScaleChange = null,
    clampTranslate = null,
    scrollContainer = null,
    dragThreshold = 1,
  } = options;

  const scale = ref(1);
  const tx = ref(0);
  const ty = ref(0);
  const pointers = new Map();
  let pinchStart = null;
  let dragLast = null;
  // Scroll position to re-apply after async content resize (scroll mode wheel zoom).
  let pendingScroll = null;

  const applyScale = (raw) => {
    let s = clamp(raw, minScale, maxScale);
    if (roundScale) s = Math.round(s * 100) / 100;
    if (s === scale.value) return;
    scale.value = s;
    if (onScaleChange) onScaleChange(s);
  };

  const reset = () => {
    scale.value = 1; tx.value = 0; ty.value = 0;
    pinchStart = null; dragLast = null; pointers.clear();
    pendingScroll = null;
  };

  // Re-apply a pending scroll target after async content resize (e.g. PDF re-render).
  // Returns the pending target if any (so callers can apply it on their container).
  const consumePendingScroll = () => {
    const ps = pendingScroll;
    pendingScroll = null;
    return ps;
  };

  // Wheel zoom centered on cursor. For "translate" mode adjusts tx/ty so the
  // point under the cursor stays fixed. For "scroll" mode adjusts scrollLeft/
  // scrollTop and stashes a pending target for re-application after async resize.
  const onWheel = (e) => {
    if (!enabled()) return;
    try { e.preventDefault(); } catch {}
    const factor = Math.exp(-e.deltaY * 0.0015);
    const s0 = scale.value;
    let s = clamp(s0 * factor, minScale, maxScale);
    if (roundScale) s = Math.round(s * 100) / 100;
    if (s === s0) return;
    const k = s / s0;
    if (panMode === "scroll") {
      const container = scrollContainer?.();
      if (container) {
        const rect = container.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const targetLeft = container.scrollLeft * k + cx * (k - 1);
        const targetTop = container.scrollTop * k + cy * (k - 1);
        pendingScroll = { left: targetLeft, top: targetTop };
        scale.value = s;
        if (onScaleChange) onScaleChange(s);
        // Apply immediately (may be clamped before content resizes).
        container.scrollLeft = targetLeft;
        container.scrollTop = targetTop;
      } else {
        scale.value = s;
        if (onScaleChange) onScaleChange(s);
      }
      if (s <= minScale) { tx.value = 0; ty.value = 0; }
    } else {
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      tx.value = tx.value * k + cx * (1 - k);
      ty.value = ty.value * k + cy * (1 - k);
      scale.value = s;
      if (onScaleChange) onScaleChange(s);
      if (clampTranslate) clampTranslate();
    }
  };

  const zoomIn = (step = 0.5) => {
    applyScale(scale.value + step);
    if (clampTranslate) clampTranslate();
  };
  const zoomOut = (step = 0.5) => {
    applyScale(scale.value - step);
    if (scale.value <= minScale) { tx.value = 0; ty.value = 0; }
    if (clampTranslate) clampTranslate();
  };
  const zoomReset = () => reset();

  const onPointerDown = (e) => {
    if (!enabled()) return;
    try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [p1, p2] = Array.from(pointers.values());
      pinchStart = {
        dist: dist(p1, p2) || 1,
        mid: mid(p1, p2),
        scale: scale.value,
        tx: tx.value,
        ty: ty.value,
      };
      dragLast = null;
      return;
    }
    if (pointers.size === 1) {
      if (panMode === "scroll") {
        const container = scrollContainer?.();
        dragLast = container
          ? { x: e.clientX, y: e.clientY, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop }
          : { x: e.clientX, y: e.clientY, scrollLeft: 0, scrollTop: 0 };
      } else {
        dragLast = { x: e.clientX, y: e.clientY };
      }
      pinchStart = null;
    }
  };

  const onPointerMove = (e) => {
    if (!enabled() || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStart) {
      try { e.preventDefault(); } catch {}
      const [p1, p2] = Array.from(pointers.values());
      const d = dist(p1, p2) || 1;
      if (panMode === "scroll") {
        applyScale(pinchStart.scale * (d / pinchStart.dist));
        return;
      }
      const m = mid(p1, p2);
      applyScale(pinchStart.scale * (d / pinchStart.dist));
      tx.value = pinchStart.tx + (m.x - pinchStart.mid.x);
      ty.value = pinchStart.ty + (m.y - pinchStart.mid.y);
      if (clampTranslate) clampTranslate();
      return;
    }
    if (pointers.size === 1 && dragLast && scale.value > dragThreshold) {
      try { e.preventDefault(); } catch {}
      if (panMode === "scroll") {
        const container = scrollContainer?.();
        if (!container) return;
        container.scrollLeft = dragLast.scrollLeft - (e.clientX - dragLast.x);
        container.scrollTop = dragLast.scrollTop - (e.clientY - dragLast.y);
      } else {
        tx.value += e.clientX - dragLast.x;
        ty.value += e.clientY - dragLast.y;
        dragLast = { x: e.clientX, y: e.clientY };
        if (clampTranslate) clampTranslate();
      }
    }
  };

  const onPointerUp = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) dragLast = null;
  };

  return {
    scale, tx, ty,
    reset, zoomIn, zoomOut, zoomReset,
    onPointerDown, onPointerMove, onPointerUp,
    onWheel, consumePendingScroll,
  };
};
