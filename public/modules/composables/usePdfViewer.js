// ── usePdfViewer: PDF viewer state + actions ──
//
// Uses usePanZoom in "scroll" mode (scale only; pan via scroll container).
// Dependencies passed in: { apiFetch, lockBodyScroll, unlockBodyScroll, downloadBlob }.
// lockBodyScroll/unlockBodyScroll are shared with image viewer (defined in app.js
// for now; will be consolidated later).

import { ref, nextTick } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import { usePanZoom } from "./usePanZoom.js";

export const usePdfViewer = ({ apiFetch, lockBodyScroll, unlockBodyScroll, downloadBlob }) => {
  const pdfViewerOpen = ref(false);
  const pdfViewerName = ref("");
  const pdfViewerLoading = ref(false);
  const pdfViewerError = ref("");
  const pdfViewerPageCount = ref(0);
  const pdfViewerCanvases = ref([]);
  const pdfViewerScroll = ref(null);
  let pdfViewerFitScale = 1;
  let pdfViewerDoc = null;
  let pdfViewerObjectUrl = null;
  let pdfViewerDownloadUrl = "";

  const renderPdfViewerPages = async () => {
    if (!pdfViewerDoc || !pdfViewerCanvases.value.length) return;
    for (let i = 1; i <= pdfViewerDoc.numPages; i++) {
      const canvas = pdfViewerCanvases.value[i - 1];
      if (!canvas) continue;
      try {
        const page = await pdfViewerDoc.getPage(i);
        const viewport = page.getViewport({ scale: panZoom.scale.value });
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = Math.floor(viewport.width) + "px";
        canvas.style.height = Math.floor(viewport.height) + "px";
        const ctx = canvas.getContext("2d");
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch (e) {
        console.error("pdf viewer render page failed", i, e);
      }
    }
    // After canvases resize, re-apply scroll target from wheel zoom so the
    // point under the cursor stays fixed once content bounds grow.
    const ps = panZoom.consumePendingScroll?.();
    const container = pdfViewerScroll.value;
    if (ps && container) {
      container.scrollLeft = ps.left;
      container.scrollTop = ps.top;
    }
  };

  const panZoom = usePanZoom({
    minScale: 0.5,
    maxScale: 3,
    enabled: () => pdfViewerOpen.value,
    panMode: "scroll",
    roundScale: true,
    onScaleChange: () => renderPdfViewerPages(),
    scrollContainer: () => pdfViewerScroll.value,
    dragThreshold: 0,
  });

  const closePdfViewer = () => {
    pdfViewerOpen.value = false;
    pdfViewerName.value = "";
    pdfViewerPageCount.value = 0;
    pdfViewerError.value = "";
    pdfViewerLoading.value = false;
    pdfViewerCanvases.value = [];
    pdfViewerDownloadUrl = "";
    unlockBodyScroll();
    if (pdfViewerDoc) {
      try { pdfViewerDoc.destroy(); } catch {}
      pdfViewerDoc = null;
    }
    if (pdfViewerObjectUrl) {
      URL.revokeObjectURL(pdfViewerObjectUrl);
      pdfViewerObjectUrl = null;
    }
  };

  const downloadCurrentPdf = () => {
    if (pdfViewerDownloadUrl) downloadBlob(pdfViewerDownloadUrl, pdfViewerName.value || "document.pdf");
  };

  const pdfViewerSetCanvas = (el, n) => {
    if (el) pdfViewerCanvases.value[n - 1] = el;
  };

  const pdfViewerZoomIn = () => panZoom.zoomIn(0.25);
  const pdfViewerZoomOut = () => panZoom.zoomOut(0.25);
  const pdfViewerZoomReset = () => {
    panZoom.scale.value = pdfViewerFitScale;
    renderPdfViewerPages();
  };

  const openPdfViewer = async (url, name) => {
    if (typeof pdfjsLib === "undefined") {
      pdfViewerError.value = "PDF viewer library is not loaded.";
      pdfViewerOpen.value = true;
      return;
    }
    closePdfViewer();
    pdfViewerOpen.value = true;
    pdfViewerLoading.value = true;
    pdfViewerName.value = name || "Document";
    pdfViewerDownloadUrl = url;
    lockBodyScroll();
    try {
      const resp = await apiFetch(url);
      const blob = await resp.blob();
      pdfViewerObjectUrl = URL.createObjectURL(blob);
      const task = pdfjsLib.getDocument(pdfViewerObjectUrl);
      pdfViewerDoc = await task.promise;
      pdfViewerPageCount.value = pdfViewerDoc.numPages;
      pdfViewerLoading.value = false;
      await nextTick();
      const container = pdfViewerScroll.value;
      if (container && pdfViewerDoc.numPages > 0) {
        const page0 = await pdfViewerDoc.getPage(1);
        const vp = page0.getViewport({ scale: 1 });
        const pad = 48;
        pdfViewerFitScale = Math.max(0.5, Math.min((container.clientWidth - pad) / vp.width, 2));
      } else {
        pdfViewerFitScale = 1;
      }
      panZoom.scale.value = pdfViewerFitScale;
      await renderPdfViewerPages();
    } catch (e) {
      console.error("pdf viewer open failed", e);
      pdfViewerError.value = "Could not open PDF: " + (e?.message || String(e));
      pdfViewerLoading.value = false;
    }
  };

  const onPdfViewerKeydown = (e) => {
    if (!pdfViewerOpen.value) return;
    if (e.key === "Escape") closePdfViewer();
    else if (e.key === "+" || e.key === "=") pdfViewerZoomIn();
    else if (e.key === "-") pdfViewerZoomOut();
    else if (e.key === "0") pdfViewerZoomReset();
  };

  return {
    pdfViewerOpen, pdfViewerName, pdfViewerLoading, pdfViewerError,
    pdfViewerPageCount, pdfViewerScale: panZoom.scale,
    pdfViewerCanvases, pdfViewerScroll, pdfViewerSetCanvas,
    openPdfViewer, closePdfViewer,
    pdfViewerZoomIn, pdfViewerZoomOut, pdfViewerZoomReset,
    downloadCurrentPdf,
    onPdfViewerPointerDown: panZoom.onPointerDown,
    onPdfViewerPointerMove: panZoom.onPointerMove,
    onPdfViewerPointerUp: panZoom.onPointerUp,
    onPdfViewerWheel: panZoom.onWheel,
    onPdfViewerKeydown,
  };
};
