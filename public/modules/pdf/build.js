// ── PDF build helpers ──

import { applySliderDeltas, autoPickQuality } from "../image/process.js";

const blobToDataUrl = (blob) => new Promise((r) => {
  const reader = new FileReader();
  reader.onload = () => r(reader.result);
  reader.readAsDataURL(blob);
});

// Render one page to a JPEG blob using already-auto-processed baseImageData + slider deltas.
// Returns { blob, width, height }.
export const renderPageBlob = async (page, settings) => {
  const { brightness, contrast, sharpness } = settings;
  const w = page.img.naturalWidth, h = page.img.naturalHeight;
  const offscreen = document.createElement("canvas");
  offscreen.width = w;
  offscreen.height = h;
  const ctx = offscreen.getContext("2d", { alpha: false });
  // baseImageData already has auto-processing applied (from modal); just apply slider deltas
  applySliderDeltas(ctx, page.baseImageData, w, h, brightness, contrast, sharpness);
  const { blob } = await autoPickQuality(offscreen);
  return { blob, width: w, height: h };
};

// Add one JPEG blob as a page to jsPDF — reads dimensions from Image.
export const addJpegBlobToPdf = async (pdf, blob, jspdf) => {
  const dataUrl = await blobToDataUrl(blob);
  const img = await new Promise((r) => {
    const i = new Image();
    i.onload = () => r(i);
    i.src = dataUrl;
  });
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!pdf) {
    pdf = new jspdf({ orientation: w > h ? "l" : "p", unit: "px", format: [w, h], hotfixes: ["px_scaling"] });
  } else {
    pdf.addPage([w, h], w > h ? "l" : "p");
  }
  pdf.addImage(dataUrl, "JPEG", 0, 0, w, h);
  return pdf;
};

// Generate PDF blob from already-processed pages (have baseImageData).
export const renderPdfBlob = async (pages, settings) => {
  const jspdf = window.jspdf?.jsPDF;
  if (!jspdf) throw new Error("jsPDF not loaded");

  let pdf = null;
  for (const page of pages) {
    const { blob, width: w, height: h } = await renderPageBlob(page, settings);
    if (!blob) continue;
    const dataUrl = await blobToDataUrl(blob);
    if (!pdf) {
      pdf = new jspdf({ orientation: w > h ? "l" : "p", unit: "px", format: [w, h], hotfixes: ["px_scaling"] });
    } else {
      pdf.addPage([w, h], w > h ? "l" : "p");
    }
    pdf.addImage(dataUrl, "JPEG", 0, 0, w, h);
  }
  if (!pdf) return null;
  return pdf.output("blob");
};
