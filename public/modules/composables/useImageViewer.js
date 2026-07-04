// ── useImageViewer: image viewer state + actions ──
//
// Uses usePanZoom in "translate" mode (transform: translate3d + scale).
// Dependencies passed in: { downloadBlob }.

import { ref, computed, nextTick } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import { usePanZoom } from "./usePanZoom.js";

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export const useImageViewer = ({ downloadBlob }) => {
  const viewerOpen = ref(false);
  const viewerUrl = ref("");
  const viewerName = ref("");
  const viewerPages = ref([]);
  const viewerPageIndex = ref(0);
  const viewerStage = ref(null);
  const viewerImg = ref(null);
  const viewerBaseW = ref(0);
  const viewerBaseH = ref(0);

  const clampViewerTranslate = () => {
    const s = viewerStage.value;
    if (!s) return;
    const sr = s.getBoundingClientRect();
    const sw = viewerBaseW.value * panZoom.scale.value;
    const sh = viewerBaseH.value * panZoom.scale.value;
    const mx = Math.max(0, (sw - sr.width) / 2);
    const my = Math.max(0, (sh - sr.height) / 2);
    panZoom.tx.value = clamp(panZoom.tx.value, -mx, mx);
    panZoom.ty.value = clamp(panZoom.ty.value, -my, my);
  };

  const panZoom = usePanZoom({
    minScale: 1,
    maxScale: 5,
    enabled: () => viewerOpen.value,
    panMode: "translate",
    clampTranslate: clampViewerTranslate,
    dragThreshold: 1,
  });

  const onViewerImgLoad = async () => {
    await nextTick();
    const r = viewerImg.value?.getBoundingClientRect();
    if (r) { viewerBaseW.value = r.width; viewerBaseH.value = r.height; }
    panZoom.reset();
  };

  const viewerImgStyle = computed(() => ({
    transform: `translate3d(${panZoom.tx.value}px,${panZoom.ty.value}px,0) scale(${panZoom.scale.value})`,
    transformOrigin: "center center", willChange: "transform",
  }));

  let savedScrollY = 0;
  let savedScrollX = 0;
  const lockBodyScroll = () => {
    savedScrollX = window.scrollX;
    savedScrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = -savedScrollY + 'px';
    document.body.style.left = -savedScrollX + 'px';
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
  };
  const unlockBodyScroll = () => {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.width = '';
    document.body.style.overflow = '';
    window.scrollTo(savedScrollX, savedScrollY);
  };

  const openViewer = async (url, name, pages, startIndex) => {
    viewerUrl.value = url || ""; viewerName.value = name || "";
    viewerPages.value = Array.isArray(pages) ? pages : [];
    viewerPageIndex.value = startIndex || 0;
    viewerOpen.value = true; panZoom.reset(); lockBodyScroll(); await nextTick();
  };

  const downloadCurrentImage = () => {
    if (viewerUrl.value) downloadBlob(viewerUrl.value, viewerName.value || "image");
  };

  const closeViewer = () => {
    viewerOpen.value = false; viewerUrl.value = ""; viewerName.value = "";
    viewerPages.value = []; viewerPageIndex.value = 0;
    panZoom.reset(); unlockBodyScroll();
  };

  const viewerPrev = () => {
    if (viewerPageIndex.value > 0) {
      viewerPageIndex.value--;
      viewerUrl.value = viewerPages.value[viewerPageIndex.value];
      panZoom.reset();
    }
  };
  const viewerNext = () => {
    if (viewerPageIndex.value < viewerPages.value.length - 1) {
      viewerPageIndex.value++;
      viewerUrl.value = viewerPages.value[viewerPageIndex.value];
      panZoom.reset();
    }
  };

  const onViewerKeydown = (e) => {
    if (!viewerOpen.value) return;
    if (e.key === "ArrowLeft") viewerPrev();
    else if (e.key === "ArrowRight") viewerNext();
    else if (e.key === "Escape") closeViewer();
  };

  return {
    viewerOpen, viewerUrl, viewerName, viewerStage, viewerImg, viewerImgStyle,
    viewerPages, viewerPageIndex,
    viewerScale: panZoom.scale, viewerTx: panZoom.tx, viewerTy: panZoom.ty,
    onViewerImgLoad,
    onViewerPointerDown: panZoom.onPointerDown,
    onViewerPointerMove: panZoom.onPointerMove,
    onViewerPointerUp: panZoom.onPointerUp,
    onViewerWheel: panZoom.onWheel,
    viewerPrev, viewerNext, closeViewer,
    viewerZoomIn: panZoom.zoomIn, viewerZoomOut: panZoom.zoomOut, viewerZoomReset: panZoom.zoomReset,
    downloadCurrentImage, openViewer, onViewerKeydown,
    lockBodyScroll, unlockBodyScroll,
  };
};
