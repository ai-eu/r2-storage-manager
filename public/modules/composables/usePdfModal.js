// ── usePdfModal: PDF processing modal state + actions ──
//
// Multi-page image processing modal: decodes input files, runs auto
// enhancement, exposes brightness/contrast/sharpness sliders with live
// canvas redraw, zoom/pan of the preview, and a Promise-based confirm/cancel.
//
// Dependencies passed in: { decodeImageFile, autoProcessImageData,
// applySliderDeltas, autoPickQuality }.

import { ref, computed } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";

export const usePdfModal = ({
  decodeImageFile,
  autoProcessImageData,
  applySliderDeltas,
  autoPickQuality,
}) => {
  const pdfModalOpen = ref(false);
  const pdfModalPages = ref([]); // [{ file, img, baseImageData, canvas, autoVals }]
  const pdfModalPageIdx = ref(0);
  const pdfModalBrightness = ref(0);
  const pdfModalContrast = ref(0);
  const pdfModalSharpness = ref(30);
  const pdfModalSizeKb = ref(null);
  const pdfModalProcessing = ref(false);
  const pdfModalCanvas = ref(null); // template ref
  const pdfModalPreview = ref(null); // template ref — scroll container
  let pdfModalResolve = null;
  let pdfModalAddDocId = null;

  // Zoom state
  const pdfZoom = ref(1);
  const pdfZoomMin = 0.25;
  const pdfZoomMax = 8;
  const pdfZoomStep = 0.25;

  const pdfZoomSet = (z) => {
    pdfZoom.value = Math.max(pdfZoomMin, Math.min(pdfZoomMax, Math.round(z * 100) / 100));
  };
  const pdfZoomIn = () => pdfZoomSet(pdfZoom.value + pdfZoomStep);
  const pdfZoomOut = () => pdfZoomSet(pdfZoom.value - pdfZoomStep);
  const pdfZoomReset = () => pdfZoomSet(1);

  // Pan (drag) state — only active when zoomed in
  let pdfDragging = false;
  let pdfDragStart = null;
  let pdfScrollStart = null;

  const onPdfDragStart = (e) => {
    if (pdfZoom.value <= 1) return;
    const container = pdfModalPreview.value;
    if (!container) return;
    pdfDragging = true;
    pdfDragStart = { x: e.clientX, y: e.clientY };
    pdfScrollStart = { left: container.scrollLeft, top: container.scrollTop };
    e.preventDefault();
  };
  const onPdfDragMove = (e) => {
    if (!pdfDragging || !pdfDragStart || !pdfScrollStart) return;
    const container = pdfModalPreview.value;
    if (!container) return;
    container.scrollLeft = pdfScrollStart.left - (e.clientX - pdfDragStart.x);
    container.scrollTop = pdfScrollStart.top - (e.clientY - pdfDragStart.y);
  };
  const onPdfDragEnd = () => {
    pdfDragging = false;
    pdfDragStart = null;
    pdfScrollStart = null;
  };

  const pdfCanvasStyle = computed(() => ({
    transform: `scale(${pdfZoom.value})`,
    transformOrigin: "top center",
    cursor: pdfDragging ? "grabbing" : (pdfZoom.value > 1 ? "grab" : "default"),
    userSelect: "none",
  }));

  const onPdfPreviewWheel = (e) => {
    const delta = e.deltaY > 0 ? -pdfZoomStep : pdfZoomStep;
    pdfZoomSet(pdfZoom.value + delta);
  };

  const pdfModalCurrentPage = computed(() =>
    pdfModalPages.value[pdfModalPageIdx.value] || null
  );

  // Draw current page with current slider values into canvas
  const pdfModalRedraw = () => {
    const page = pdfModalCurrentPage.value;
    const canvas = pdfModalCanvas.value;
    if (!page || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    applySliderDeltas(
      ctx, page.baseImageData, canvas.width, canvas.height,
      pdfModalBrightness.value, pdfModalContrast.value, pdfModalSharpness.value,
    );
  };

  // Estimate PDF size (rough: sum of all pages at current quality)
  const pdfModalEstimateSize = async () => {
    const page = pdfModalCurrentPage.value;
    const canvas = pdfModalCanvas.value;
    if (!page || !canvas) return;
    const { blob } = await autoPickQuality(canvas);
    pdfModalSizeKb.value = blob ? Math.round(blob.size / 1024) : null;
  };

  // Load one image onto the offscreen canvas and run auto-processing
  const pdfModalLoadPage = async (pageObj) => {
    const canvas = pdfModalCanvas.value;
    if (!canvas || !pageObj) return;
    const img = pageObj.img;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(img, 0, 0);
    const rawData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const autoVals = autoProcessImageData(rawData);
    ctx.putImageData(rawData, 0, 0);
    pageObj.baseImageData = rawData;
    pageObj.autoVals = autoVals;
    pdfModalBrightness.value = autoVals.brightnessAuto;
    pdfModalContrast.value = autoVals.contrastAuto;
    pdfModalSharpness.value = autoVals.sharpnessAuto;
    pdfZoomReset();
    pdfModalRedraw();
    pdfModalEstimateSize();
  };

  const pdfModalOnSlider = () => {
    pdfModalRedraw();
    pdfModalEstimateSize();
  };

  // Open modal: process files, return Promise<settings|null>
  const openPdfModal = async (files, addDocId = null) => {
    pdfModalProcessing.value = true;
    pdfModalOpen.value = true;
    pdfModalAddDocId = addDocId || null;
    pdfModalPageIdx.value = 0;
    pdfModalPages.value = [];
    pdfModalSizeKb.value = null;

    const pages = [];
    for (const file of files) {
      try {
        const img = await decodeImageFile(file);
        pages.push({ file, img, baseImageData: null, autoVals: null });
      } catch (e) { console.error("decode failed", file.name, e); }
    }
    pdfModalPages.value = pages;
    pdfModalProcessing.value = false;

    // Wait for canvas to mount, then load first page
    await new Promise((r) => setTimeout(r, 50));
    await pdfModalLoadPage(pdfModalPages.value[0]);

    return new Promise((r) => { pdfModalResolve = r; });
  };

  const pdfModalConfirm = () => {
    const r = pdfModalResolve; pdfModalResolve = null;
    pdfModalOpen.value = false;
    if (r) r({ brightness: pdfModalBrightness.value, contrast: pdfModalContrast.value, sharpness: pdfModalSharpness.value });
  };

  const pdfModalCancel = () => {
    const r = pdfModalResolve; pdfModalResolve = null;
    pdfModalOpen.value = false;
    if (r) r(null);
  };

  return {
    pdfModalOpen, pdfModalProcessing, pdfModalPages, pdfModalPageIdx,
    pdfModalBrightness, pdfModalContrast, pdfModalSharpness,
    pdfModalSizeKb, pdfModalCanvas, pdfModalPreview, pdfModalCurrentPage,
    pdfModalOnSlider, pdfModalConfirm, pdfModalCancel,
    pdfZoom, pdfCanvasStyle, pdfZoomIn, pdfZoomOut, pdfZoomReset, onPdfPreviewWheel,
    onPdfDragStart, onPdfDragMove, onPdfDragEnd,
    openPdfModal,
  };
};
