const { createApp, ref, computed, onMounted, nextTick } = Vue;

const API_BASE = "";

const normalizeTag = (t) => (typeof t === "string" ? t.trim().toLowerCase() : "");
const normalizeTags = (tags) => {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(normalizeTag).filter(Boolean))];
};
const parseTagsInput = (input) => {
  if (typeof input !== "string") return [];
  return normalizeTags(input.split(/[,\s]+/g).map((s) => s.trim()).filter(Boolean));
};

const getExt = (f) => {
  if (typeof f !== "string") return "";
  const b = f.split("/").pop() || f;
  const i = b.lastIndexOf(".");
  return i === -1 ? "" : b.slice(i + 1).toLowerCase();
};
const getExtIcon = (ext) => {
  const m = { pdf:"PDF",doc:"DOC",docx:"DOCX",xls:"XLS",xlsx:"XLSX",ppt:"PPT",pptx:"PPTX",
    txt:"TXT",md:"MD",zip:"ZIP",rar:"RAR","7z":"7Z",mp3:"MP3",wav:"WAV",mp4:"MP4",mov:"MOV" };
  return m[ext] || (ext ? ext.toUpperCase() : "FILE");
};

const hashTag = (tag) => {
  const s = normalizeTag(tag);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i));
  return h >>> 0;
};
const tagToColors = (tag) => {
  const p = [
    {bg:"#2D6A4F",fg:"#FFF"},{bg:"#1D3557",fg:"#FFF"},{bg:"#6D597A",fg:"#FFF"},
    {bg:"#9C6644",fg:"#FFF"},{bg:"#0077B6",fg:"#FFF"},{bg:"#E07A5F",fg:"#FFF"},
    {bg:"#3D405B",fg:"#FFF"},{bg:"#2A9D8F",fg:"#FFF"},{bg:"#F4A261",fg:"#1B1B1B"},
    {bg:"#8D99AE",fg:"#1B1B1B"},
  ];
  return p[hashTag(tag) % p.length];
};

const isImage = (f) => /\.(jpg|jpeg|png|gif|webp)$/i.test(f);
const isPdf = (f) => /\.pdf$/i.test(f);

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// ── Image processing ──

const decodeImageFile = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("read error"));
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => reject(new Error("decode error"));
    img.onload = () => resolve(img);
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// Apply grayscale + auto-normalize + auto-brightness to ImageData in-place.
// Returns { brightnessAuto, contrastAuto, sharpnessAuto } — computed values for sliders.
const autoProcessImageData = (data) => {
  const d = data.data;
  const len = d.length;

  // Step 1: grayscale (luminance)
  for (let i = 0; i < len; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = g;
  }

  // Step 2: find min/max for normalize
  let min = 255, max = 0, sum = 0, count = len / 4;
  for (let i = 0; i < len; i += 4) {
    const v = d[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / count;
  const range = max - min || 1;

  // Step 3: normalize (stretch histogram to 0–255)
  for (let i = 0; i < len; i += 4) {
    const v = Math.round(((d[i] - min) / range) * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
  }

  // Step 4: auto-brightness correction — only brighten, never darken documents.
  // Target mean 170 (documents are mostly white/light — keep them bright).
  const targetMean = 170;
  let newSum = 0;
  for (let i = 0; i < len; i += 4) newSum += d[i];
  const newMean = newSum / count;
  // Apply only if image is darker than target (don't dim already-bright scans)
  const brightnessDelta = newMean < targetMean ? Math.round(targetMean - newMean) : 0;
  if (brightnessDelta > 0) {
    for (let i = 0; i < len; i += 4) {
      const v = Math.max(0, Math.min(255, d[i] + brightnessDelta));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }

  return {
    brightnessAuto: brightnessDelta,
    contrastAuto: 0,
    sharpnessAuto: 30,
  };
};

// Apply user slider deltas on top of already-processed ImageData (copy → apply → putImageData).
// processedData is the auto-processed base; brightness/contrast/sharpness are user deltas.
const applySliderDeltas = (ctx, baseImageData, width, height, brightness, contrast, sharpness) => {
  const src = new Uint8ClampedArray(baseImageData.data);
  const out = new ImageData(new Uint8ClampedArray(src), width, height);
  const d = out.data;
  const len = d.length;

  // Brightness delta
  if (brightness !== 0) {
    for (let i = 0; i < len; i += 4) {
      const v = Math.max(0, Math.min(255, d[i] + brightness));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }

  // Contrast factor: factor = (259 * (contrast + 255)) / (255 * (259 - contrast))
  if (contrast !== 0) {
    const f = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (let i = 0; i < len; i += 4) {
      const v = Math.max(0, Math.min(255, Math.round(f * (d[i] - 128) + 128)));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }

  // Unsharp mask (simple 3x3 blur → subtract)
  if (sharpness > 0) {
    const amount = sharpness / 100;
    const blurred = new Uint8ClampedArray(len);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              s += d[(ny * width + nx) * 4]; c++;
            }
          }
        }
        blurred[(y * width + x) * 4] = Math.round(s / c);
      }
    }
    for (let i = 0; i < len; i += 4) {
      const sharpened = Math.max(0, Math.min(255, Math.round(d[i] + amount * (d[i] - blurred[i]))));
      d[i] = d[i + 1] = d[i + 2] = sharpened;
    }
  }

  ctx.putImageData(out, 0, 0);
  return out;
};

// Auto-pick JPEG quality to target ≤ 500KB (max 1MB).
// Returns { blob, quality, oversized }.
const autoPickQuality = (canvas) => new Promise((resolve) => {
  const tryQ = (qualities, idx) => {
    if (idx >= qualities.length) {
      canvas.toBlob((b) => resolve({ blob: b, quality: qualities[qualities.length - 1], oversized: true }), "image/jpeg", qualities[qualities.length - 1]);
      return;
    }
    const q = qualities[idx];
    canvas.toBlob((b) => {
      if (!b) { resolve({ blob: b, quality: q, oversized: false }); return; }
      if (b.size <= 512 * 1024 || idx === qualities.length - 1) {
        resolve({ blob: b, quality: q, oversized: b.size > 1024 * 1024 });
      } else if (b.size > 1024 * 1024) {
        tryQ(qualities, idx + 1);
      } else {
        tryQ(qualities, idx + 1);
      }
    }, "image/jpeg", q);
  };
  tryQ([0.85, 0.80, 0.72, 0.60], 0);
});

const generateImageThumbBlob = async (file) => {
  if (!(file instanceof File)) return null;
  const img = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error("read"));
    r.onload = () => {
      const i = new Image();
      i.onerror = () => rej(new Error("dec"));
      i.onload = () => res(i);
      i.src = r.result;
    };
    r.readAsDataURL(file);
  });
  const tw = 240, th = 320;
  const canvas = document.createElement("canvas");
  canvas.width = tw; canvas.height = th;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  const sc = Math.max(tw / img.width, th / img.height);
  ctx.drawImage(img, (tw - img.width * sc) / 2, (th - img.height * sc) / 2, img.width * sc, img.height * sc);
  const blob = await new Promise((r) => {
    try { canvas.toBlob((b) => r(b), "image/jpeg", 0.7); } catch { r(null); }
  });
  if (blob instanceof Blob && blob.size > 0) return { blob, ext: "jpg" };
  const webp = await new Promise((r) => {
    try { canvas.toBlob((b) => r(b), "image/webp", 0.75); } catch { r(null); }
  });
  if (webp instanceof Blob && webp.size > 0) return { blob: webp, ext: "webp" };
  return null;
};

const generatePdfThumbBlob = async (file) => {
  if (typeof pdfjsLib === "undefined") return null;
  if (!(file instanceof File) && !(file instanceof Blob)) return null;
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const tw = 240, th = 320;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(tw / baseViewport.width, th / baseViewport.height);
    const viewport = page.getViewport({ scale });
    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = Math.ceil(viewport.width);
    tmpCanvas.height = Math.ceil(viewport.height);
    const tmpCtx = tmpCanvas.getContext("2d", { alpha: false });
    if (!tmpCtx) return null;
    tmpCtx.fillStyle = "#fff";
    tmpCtx.fillRect(0, 0, tmpCanvas.width, tmpCanvas.height);
    await page.render({ canvasContext: tmpCtx, viewport }).promise;
    const canvas = document.createElement("canvas");
    canvas.width = tw; canvas.height = th;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, tw, th);
    const offsetX = (tw - viewport.width) / 2;
    const offsetY = (th - viewport.height) / 2;
    ctx.drawImage(tmpCanvas, offsetX, offsetY);
    const blob = await new Promise((r) => {
      try { canvas.toBlob((b) => r(b), "image/jpeg", 0.7); } catch { r(null); }
    });
    if (blob instanceof Blob && blob.size > 0) return { blob, ext: "jpg" };
    return null;
  } catch (e) { console.error("pdf thumb failed:", e); return null; }
};

createApp({
  setup() {
    const documents = ref([]);
    const loading = ref(false);
    const uploading = ref(false);
    const uploadProgress = ref(0);
    const uploadError = ref("");
    const activeTag = ref("");
    const tagQuery = ref("");
    const topTags = ref([]);
    const relatedTags = ref([]);
    const allTags = ref([]);
    const menuKey = ref(null);
    const usage = ref(null);
    const usagePct = computed(() => {
      if (!usage.value || !usage.value.limit) return 0;
      return Math.min(100, Math.round((usage.value.used / usage.value.limit) * 100));
    });
    const formatNum = (n) => {
      if (typeof n !== "number") return "0";
      return n.toLocaleString("en-US");
    };
    const fetchUsage = async () => {
      try {
        const d = await apiFetch("/api/usage").then((r) => r.json());
        usage.value = d;
      } catch { usage.value = null; }
    };

    // Pages view (multi-page document)
    const pagesViewOpen = ref(false);
    const pagesViewTitle = ref("");
    const pagesViewList = ref([]);
    const pagesViewDocId = ref(null);

    const normalizedTagQuery = computed(() => normalizeTag(tagQuery.value));
    const cloudTags = computed(() => {
      if (activeTag.value) return relatedTags.value;
      const q = normalizedTagQuery.value;
      if (!q) return topTags.value;
      return (allTags.value.length ? allTags.value : topTags.value)
        .filter((t) => normalizeTag(t?.tag || "").includes(q)).slice(0, 50);
    });

    // PDF processing modal
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

    // Tag modal
    const tagModalOpen = ref(false);
    const tagModalTitle = ref("Tags");
    const tagModalInput = ref("");
    let tagModalResolve = null;
    const openTagsModal = ({ title, initialValue }) => {
      tagModalTitle.value = title || "Tags";
      tagModalInput.value = initialValue || "";
      tagModalOpen.value = true;
      return new Promise((r) => { tagModalResolve = r; });
    };
    const closeTagsModal = (result) => {
      tagModalOpen.value = false;
      const r = tagModalResolve; tagModalResolve = null;
      if (r) r(result);
    };

    // Image viewer
    const viewerOpen = ref(false);
    const viewerUrl = ref("");
    const viewerName = ref("");
    const viewerPages = ref([]);
    const viewerPageIndex = ref(0);
    const viewerStage = ref(null);
    const viewerImg = ref(null);
    const viewerScale = ref(1);
    const viewerTx = ref(0);
    const viewerTy = ref(0);
    const viewerBaseW = ref(0);
    const viewerBaseH = ref(0);
    const viewerPointers = new Map();
    let viewerPinchStart = null;
    let viewerDragLast = null;

    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    const clampViewerTranslate = () => {
      const s = viewerStage.value;
      if (!s) return;
      const sr = s.getBoundingClientRect();
      const sw = viewerBaseW.value * viewerScale.value;
      const sh = viewerBaseH.value * viewerScale.value;
      const mx = Math.max(0, (sw - sr.width) / 2);
      const my = Math.max(0, (sh - sr.height) / 2);
      viewerTx.value = clamp(viewerTx.value, -mx, mx);
      viewerTy.value = clamp(viewerTy.value, -my, my);
    };
    const resetViewerTransform = () => {
      viewerScale.value = 1; viewerTx.value = 0; viewerTy.value = 0;
      viewerPinchStart = null; viewerDragLast = null; viewerPointers.clear();
    };
    const onViewerImgLoad = async () => {
      await nextTick();
      const r = viewerImg.value?.getBoundingClientRect();
      if (r) { viewerBaseW.value = r.width; viewerBaseH.value = r.height; }
      resetViewerTransform();
    };
    const viewerImgStyle = computed(() => ({
      transform: `translate3d(${viewerTx.value}px,${viewerTy.value}px,0) scale(${viewerScale.value})`,
      transformOrigin: "center center", willChange: "transform",
    }));
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    const onViewerPointerDown = (e) => {
      if (!viewerOpen.value) return;
      try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch {}
      viewerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (viewerPointers.size === 2) {
        const [p1, p2] = Array.from(viewerPointers.values());
        viewerPinchStart = { dist: dist(p1, p2) || 1, mid: mid(p1, p2), scale: viewerScale.value, tx: viewerTx.value, ty: viewerTy.value };
        viewerDragLast = null; return;
      }
      if (viewerPointers.size === 1) viewerDragLast = { x: e.clientX, y: e.clientY };
    };
    const onViewerPointerMove = (e) => {
      if (!viewerOpen.value || !viewerPointers.has(e.pointerId)) return;
      viewerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (viewerPointers.size === 2 && viewerPinchStart) {
        try { e.preventDefault(); } catch {}
        const [p1, p2] = Array.from(viewerPointers.values());
        const d = dist(p1, p2) || 1, m = mid(p1, p2);
        viewerScale.value = clamp(viewerPinchStart.scale * (d / viewerPinchStart.dist), 1, 5);
        viewerTx.value = viewerPinchStart.tx + (m.x - viewerPinchStart.mid.x);
        viewerTy.value = viewerPinchStart.ty + (m.y - viewerPinchStart.mid.y);
        clampViewerTranslate(); return;
      }
      if (viewerPointers.size === 1 && viewerDragLast && viewerScale.value > 1) {
        try { e.preventDefault(); } catch {}
        viewerTx.value += e.clientX - viewerDragLast.x;
        viewerTy.value += e.clientY - viewerDragLast.y;
        viewerDragLast = { x: e.clientX, y: e.clientY };
        clampViewerTranslate();
      }
    };
    const onViewerPointerUp = (e) => {
      if (!viewerPointers.has(e.pointerId)) return;
      viewerPointers.delete(e.pointerId);
      if (viewerPointers.size < 2) viewerPinchStart = null;
      if (viewerPointers.size === 0) viewerDragLast = null;
    };
    const openViewer = async (url, name, pages, startIndex) => {
      viewerUrl.value = url || ""; viewerName.value = name || "";
      viewerPages.value = Array.isArray(pages) ? pages : [];
      viewerPageIndex.value = startIndex || 0;
      viewerOpen.value = true; resetViewerTransform(); await nextTick();
    };
    const closeViewer = () => {
      viewerOpen.value = false; viewerUrl.value = ""; viewerName.value = "";
      viewerPages.value = []; viewerPageIndex.value = 0;
      resetViewerTransform();
    };
    const viewerPrev = () => {
      if (viewerPageIndex.value > 0) {
        viewerPageIndex.value--;
        viewerUrl.value = viewerPages.value[viewerPageIndex.value];
        resetViewerTransform();
      }
    };
    const viewerNext = () => {
      if (viewerPageIndex.value < viewerPages.value.length - 1) {
        viewerPageIndex.value++;
        viewerUrl.value = viewerPages.value[viewerPageIndex.value];
        resetViewerTransform();
      }
    };
    const onViewerKeydown = (e) => {
      if (!viewerOpen.value) return;
      if (e.key === "ArrowLeft") viewerPrev();
      else if (e.key === "ArrowRight") viewerNext();
      else if (e.key === "Escape") closeViewer();
    };

    // Auth
    const logout = () => {
      fetch("/api/logout", { method: "POST" }).finally(() => { window.location.href = "/"; });
    };

    // API helper
    const apiFetch = (url, opts) => {
      return fetch(API_BASE + url, opts).then((r) => {
        if (r.status === 401) { window.location.href = "/"; throw new Error("Unauthorized"); }
        return r;
      });
    };

    // Data fetching
    const fetchTopTags = async () => {
      try { const d = await apiFetch("/api/tags/top?limit=10").then((r) => r.json()); topTags.value = d.tags || []; }
      catch { topTags.value = []; }
    };
    const fetchAllTags = async () => {
      try { const d = await apiFetch("/api/tags/all?limit=500").then((r) => r.json()); allTags.value = d.tags || []; }
      catch { allTags.value = []; }
    };
    const fetchRelatedTags = async (tag) => {
      const n = normalizeTag(tag);
      if (!n) { relatedTags.value = []; return; }
      try {
        const d = await apiFetch("/api/tags/related?tag=" + encodeURIComponent(n) + "&limit=10").then((r) => r.json());
        relatedTags.value = d.tags || [];
      } catch { relatedTags.value = []; }
    };

    const fetchDocuments = async () => {
      loading.value = true;
      try {
        const qs = activeTag.value ? "?tag=" + encodeURIComponent(activeTag.value) : "";
        const data = await apiFetch("/api/documents" + qs).then((r) => r.json());
        const docs = data.documents || [];
        const withThumbs = docs.map((d) => ({
          ...d,
          thumb_url: d.thumb_key
            ? "/api/objects/thumb-download-url?thumb_key=" + encodeURIComponent(d.thumb_key)
            : null,
        }));
        documents.value = withThumbs;
      } catch (e) { console.error(e); }
      finally { loading.value = false; }
    };

    const refreshAll = async () => {
      if (activeTag.value) {
        await Promise.all([fetchDocuments(), fetchRelatedTags(activeTag.value), fetchAllTags()]);
        return;
      }
      await Promise.all([fetchDocuments(), fetchTopTags(), fetchAllTags()]);
    };

    const setActiveTag = async (tag) => {
      activeTag.value = normalizeTag(tag); tagQuery.value = "";
      await Promise.all([fetchDocuments(), fetchRelatedTags(activeTag.value)]);
    };
    const clearActiveTag = async () => {
      activeTag.value = ""; tagQuery.value = ""; relatedTags.value = [];
      await Promise.all([fetchDocuments(), fetchTopTags(), fetchAllTags()]);
    };

    // ── Upload / process ──

    // Render one page to a JPEG blob using already-auto-processed baseImageData + slider deltas.
    // Returns { blob, width, height }.
    const renderPageBlob = async (page, settings) => {
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

    const blobToDataUrl = (blob) => new Promise((r) => {
      const reader = new FileReader();
      reader.onload = () => r(reader.result);
      reader.readAsDataURL(blob);
    });

    // Add one JPEG blob as a page to jsPDF — reads dimensions from Image.
    const addJpegBlobToPdf = async (pdf, blob, jspdf) => {
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
    const renderPdfBlob = async (pages, settings) => {
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

    // Core upload function: handles both new doc and add-pages flows.
    // imageFiles: File[] of images already decoded (non-image files go through old path).
    // settings: { brightness, contrast, sharpness } from modal.
    // addDocId: existing doc id to add pages to, or null for new doc.
    const processAndUploadPages = async (list, settings, addDocId, tags) => {
      uploading.value = true;
      uploadProgress.value = 0;
      uploadError.value = "";

      const uploadedKeys = [];
      const originalKeys = [];
      try {
        const totalSteps = list.length * 3 + 1; // upload orig + upload processed + thumb + pdf
        let step = 0;
        const tick = () => { step++; uploadProgress.value = Math.round((step / totalSteps) * 100); };

        const pageThumbKeys = [];
        const processedBlobs = [];

        for (let i = 0; i < list.length; i++) {
          const { file, img } = list[i];

          // Upload original (unprocessed) to originals/
          const origKey = await apiFetch(
            "/api/objects/upload?filename=" + encodeURIComponent("originals/" + file.name) +
            "&content_type=" + encodeURIComponent(file.type || "image/jpeg"),
            { method: "POST", body: file },
          ).then((r) => r.json()).then((j) => j.key);
          originalKeys.push(origKey);
          tick();

          // Render processed version using baseImageData already prepared by modal (no double auto-processing)
          const { blob: procBlob } = await renderPageBlob(list[i], settings);
          processedBlobs.push({ blob: procBlob, img });

          // Upload processed image to files/
          const procName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
          const procResp = await apiFetch(
            "/api/objects/upload?filename=" + encodeURIComponent(procName) +
            "&content_type=image/jpeg",
            { method: "POST", body: procBlob },
          ).then((r) => r.json());
          uploadedKeys.push(procResp.key);
          tick();

          // Generate thumb from processed blob
          let thumbKey = null;
          try {
            const thumbResult = await generateImageThumbBlob(new File([procBlob], procName, { type: "image/jpeg" }));
            if (thumbResult?.blob) {
              const thumbResp = await apiFetch(
                "/api/objects/thumb-upload?key=" + encodeURIComponent(procResp.key) +
                "&ext=" + encodeURIComponent(thumbResult.ext),
                { method: "POST", headers: { "Content-Type": thumbResult.ext === "webp" ? "image/webp" : "image/jpeg" }, body: thumbResult.blob },
              ).then((r) => r.json());
              thumbKey = thumbResp.thumb_key;
            }
          } catch (e) { console.error("thumb failed", e); }
          pageThumbKeys.push(thumbKey);
          tick();
        }

        // Generate and upload PDF
        const pdfBlob = await renderPdfBlob(list, settings);
        let pdfKey = null;
        let pdfThumbKey = null;
        if (pdfBlob) {
          const docIdForPdf = addDocId || ("doc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
          const pdfResp = await apiFetch(
            "/api/objects/upload?filename=" + encodeURIComponent(docIdForPdf + ".pdf") +
            "&content_type=application/pdf",
            { method: "POST", body: pdfBlob },
          ).then((r) => r.json());
          pdfKey = pdfResp.key;
          // Generate thumb from PDF (first page)
          try {
            const pdfThumbResult = await generatePdfThumbBlob(new File([pdfBlob], docIdForPdf + ".pdf", { type: "application/pdf" }));
            if (pdfThumbResult?.blob) {
              const pdfThumbResp = await apiFetch(
                "/api/objects/thumb-upload?key=" + encodeURIComponent(pdfKey) +
                "&ext=" + encodeURIComponent(pdfThumbResult.ext),
                { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: pdfThumbResult.blob },
              ).then((r) => r.json());
              pdfThumbKey = pdfThumbResp.thumb_key;
            }
          } catch (e) { console.error("pdf thumb failed", e); }
        }
        tick();

        const docThumbKey = pdfThumbKey || pageThumbKeys[0];
        const pages = list.map(({ file }, i) => ({
          key: uploadedKeys[i],
          filename: file.name.replace(/\.[^.]+$/, "") + ".jpg",
          content_type: "image/jpeg",
          size: processedBlobs[i]?.blob?.size || null,
          page_number: i + 1,
          thumb_key: pageThumbKeys[i],
          original_key: originalKeys[i],
        }));

        if (addDocId) {
          // Register new pages first so page_count is correct
          await apiFetch("/api/documents/" + encodeURIComponent(addDocId) + "/pages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pages }),
          });

          // Rebuild full PDF: fetch existing pages from DB, download their processed files,
          // then append new pages (already rendered as processedBlobs) — all in page_number order.
          const jspdf = window.jspdf?.jsPDF;
          if (jspdf) {
            try {
              const existingResp = await apiFetch(
                "/api/documents/" + encodeURIComponent(addDocId) + "/pages",
              ).then((r) => r.json());
              const allPages = (existingResp.pages || []).sort((a, b) => (a.page_number || 0) - (b.page_number || 0));

              // Separate existing pages (already in R2) from the just-added new ones
              const newKeys = new Set(uploadedKeys);
              let fullPdf = null;

              for (const p of allPages) {
                if (newKeys.has(p.key)) {
                  // New page — use already-rendered blob
                  const idx = uploadedKeys.indexOf(p.key);
                  const blob = processedBlobs[idx]?.blob;
                  if (blob) fullPdf = await addJpegBlobToPdf(fullPdf, blob, jspdf);
                } else {
                  // Existing page — download processed file from R2
                  const blob = await apiFetch(
                    "/api/objects/download-url?key=" + encodeURIComponent(p.key),
                  ).then((r) => r.blob());
                  if (blob?.size) fullPdf = await addJpegBlobToPdf(fullPdf, blob, jspdf);
                }
              }

              if (fullPdf) {
                const fullPdfBlob = fullPdf.output("blob");
                // Get existing pdf_key to overwrite, or create new
                const docSettings = await apiFetch(
                  "/api/documents/" + encodeURIComponent(addDocId) + "/pdf-settings",
                ).then((r) => r.json());
                let fullPdfKey;
                if (docSettings.pdf_key) {
                  await apiFetch(
                    "/api/objects/replace?key=" + encodeURIComponent(docSettings.pdf_key) +
                    "&content_type=application/pdf",
                    { method: "PUT", body: fullPdfBlob },
                  ).then((r) => r.json());
                  fullPdfKey = docSettings.pdf_key;
                } else {
                  const r = await apiFetch(
                    "/api/objects/upload?filename=" + encodeURIComponent(addDocId + ".pdf") +
                    "&content_type=application/pdf",
                    { method: "POST", body: fullPdfBlob },
                  ).then((r) => r.json());
                  fullPdfKey = r.key;
                }
                // Generate PDF thumb from full PDF
                let fullPdfThumbKey = null;
                try {
                  const t = await generatePdfThumbBlob(new File([fullPdfBlob], addDocId + ".pdf", { type: "application/pdf" }));
                  if (t?.blob) {
                    const tr = await apiFetch(
                      "/api/objects/thumb-upload?key=" + encodeURIComponent(fullPdfKey) +
                      "&ext=" + encodeURIComponent(t.ext),
                      { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: t.blob },
                    ).then((r) => r.json());
                    fullPdfThumbKey = tr.thumb_key;
                  }
                } catch (e) { console.error("full pdf thumb failed", e); }

                await apiFetch("/api/documents/" + encodeURIComponent(addDocId) + "/pdf", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    pdf_key: fullPdfKey,
                    correction_settings: settings,
                    ...(fullPdfThumbKey ? { thumb_key: fullPdfThumbKey } : {}),
                    pages: pages.map((p, i) => ({ key: p.key, original_key: originalKeys[i] })),
                  }),
                });
              }
            } catch (e) { console.error("full pdf rebuild failed", e); }
          }

          await refreshAll();
          await refreshPagesView();
        } else {
          const docId = "doc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
          await apiFetch("/api/documents/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: docId,
              title: list[0].file.name,
              pages,
              tags: tags || [],
              thumb_key: docThumbKey,
            }),
          });
          if (pdfKey) {
            await apiFetch("/api/documents/" + encodeURIComponent(docId) + "/pdf", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pdf_key: pdfKey, correction_settings: settings, thumb_key: pdfThumbKey || undefined, pages: pages.map((p, i) => ({ key: p.key, original_key: originalKeys[i] })) }),
            });
          }
          await refreshAll();
        }
      } catch (e) {
        console.error("upload failed:", e);
        uploadError.value = e?.message || "Upload failed.";
        for (const key of [...uploadedKeys, ...originalKeys]) {
          try { await apiFetch("/api/objects/" + encodeURIComponent(key), { method: "DELETE" }); } catch {}
        }
      } finally {
        uploading.value = false;
        uploadProgress.value = 0;
      }
    };

    const uploadFiles = async (filesToUpload) => {
      const allFiles = Array.from(filesToUpload || []).filter((f) => f instanceof File);
      if (!allFiles.length) return;
      allFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      const imageFiles = allFiles.filter((f) => isImage(f.name));
      const otherFiles = allFiles.filter((f) => !isImage(f.name));

      // Non-image files: use simple upload (no processing modal)
      if (otherFiles.length) {
        const title = otherFiles.length === 1 ? "Enter tags" : "Enter tags for all files";
        const result = await openTagsModal({ title, initialValue: "" });
        if (result === null) return;
        const tags = parseTagsInput(result);
        uploading.value = true; uploadProgress.value = 0; uploadError.value = "";
        const uploadedKeys = [];
        try {
          for (let i = 0; i < otherFiles.length; i++) {
            const file = otherFiles[i];
            const resp = await apiFetch(
              "/api/objects/upload?filename=" + encodeURIComponent(file.name) +
              "&content_type=" + encodeURIComponent(file.type || "application/octet-stream"),
              { method: "POST", body: file },
            ).then((r) => r.json());
            uploadedKeys.push(resp.key);
            uploadProgress.value = Math.round(((i + 1) / otherFiles.length) * 100);
          }
          const pageThumbKeys = [];
          for (let i = 0; i < otherFiles.length; i++) {
            let thumbKey = null;
            try {
              const t = isPdf(otherFiles[i].name) ? await generatePdfThumbBlob(otherFiles[i]) : null;
              if (t?.blob) {
                const tr = await apiFetch(
                  "/api/objects/thumb-upload?key=" + encodeURIComponent(uploadedKeys[i]) + "&ext=" + encodeURIComponent(t.ext),
                  { method: "POST", headers: { "Content-Type": t.ext === "webp" ? "image/webp" : "image/jpeg" }, body: t.blob },
                ).then((r) => r.json());
                thumbKey = tr.thumb_key;
              }
            } catch {}
            pageThumbKeys.push(thumbKey);
          }
          const docId = "doc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
          await apiFetch("/api/documents/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: docId,
              title: otherFiles[0].name,
              pages: otherFiles.map((f, i) => ({ key: uploadedKeys[i], filename: f.name, content_type: f.type, size: f.size, page_number: i + 1, thumb_key: pageThumbKeys[i] })),
              tags,
              thumb_key: pageThumbKeys[0],
            }),
          });
          await refreshAll();
        } catch (e) {
          uploadError.value = e?.message || "Upload failed.";
          for (const k of uploadedKeys) { try { await apiFetch("/api/objects/" + encodeURIComponent(k), { method: "DELETE" }); } catch {} }
        } finally { uploading.value = false; uploadProgress.value = 0; }
      }

      // Image files: show processing modal
      if (imageFiles.length) {
        const pages = await openPdfModal(imageFiles);
        if (!pages) return; // cancelled
        const title = imageFiles.length === 1 ? "Enter tags" : "Enter tags for all files";
        const tagsResult = await openTagsModal({ title, initialValue: "" });
        if (tagsResult === null) return;
        const decodedList = pdfModalPages.value.slice(0, imageFiles.length);
        await processAndUploadPages(decodedList, pages, null, parseTagsInput(tagsResult));
      }
    };

    const handleFileUpload = async (event) => {
      const input = event?.target;
      if (!input?.files?.length) return;
      try { await uploadFiles(input.files); } finally { try { input.value = ""; } catch {} }
    };

    let addPagesTargetDocId = null;
    const triggerAddPages = (docId) => {
      addPagesTargetDocId = docId;
      const input = document.querySelector('input[data-role="add-pages"]');
      if (input) { input.value = ""; input.click(); }
    };
    const handleAddPagesInput = async (event) => {
      const input = event?.target;
      if (!input?.files?.length || !addPagesTargetDocId) return;
      const docId = addPagesTargetDocId;
      addPagesTargetDocId = null;
      try {
        const files = Array.from(input.files).filter((f) => f instanceof File && isImage(f.name));
        if (!files.length) return;
        const settings = await openPdfModal(files, docId);
        if (!settings) return;
        const decodedList = pdfModalPages.value.slice(0, files.length);
        await processAndUploadPages(decodedList, settings, docId, null);
      } finally { try { input.value = ""; } catch {} }
    };

    const isDragOver = ref(false);
    let dragCounter = 0;
    const onDragOver = (e) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const onDragEnter = (e) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        dragCounter++;
        isDragOver.value = true;
      }
    };
    const onDragLeave = (e) => {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) isDragOver.value = false;
    };
    const onDrop = async (e) => {
      dragCounter = 0;
      isDragOver.value = false;
      const droppedFiles = e.dataTransfer?.files;
      if (droppedFiles?.length) {
        await uploadFiles(droppedFiles);
      }
    };

    const refreshPagesView = async () => {
      if (!pagesViewOpen.value || !pagesViewDocId.value) return;
      try {
        const resp = await apiFetch("/api/documents/" + encodeURIComponent(pagesViewDocId.value) + "/pages").then((r) => r.json());
        pagesViewList.value = (resp.pages || []).map((p) => ({
          ...p,
          thumb_url: p.thumb_key
            ? "/api/objects/thumb-download-url?thumb_key=" + encodeURIComponent(p.thumb_key)
            : null,
        }));
      } catch (e) { console.error(e); }
    };

    // Rebuild PDF from the current pagesViewList order, upload/overwrite, update thumb + D1.
    const rebuildPdfForDoc = async (docId, pageList, docPdfKey) => {
      const jspdf = window.jspdf?.jsPDF;
      if (!jspdf || !pageList.length) return;
      try {
        uploading.value = true;
        let fullPdf = null;
        for (const p of pageList) {
          const blob = await apiFetch(
            "/api/objects/download-url?key=" + encodeURIComponent(p.key),
          ).then((r) => r.blob());
          if (blob?.size) fullPdf = await addJpegBlobToPdf(fullPdf, blob, jspdf);
        }
        if (!fullPdf) return;
        const fullPdfBlob = fullPdf.output("blob");

        let pdfKey;
        if (docPdfKey) {
          await apiFetch(
            "/api/objects/replace?key=" + encodeURIComponent(docPdfKey) + "&content_type=application/pdf",
            { method: "PUT", body: fullPdfBlob },
          );
          pdfKey = docPdfKey;
        } else {
          const r = await apiFetch(
            "/api/objects/upload?filename=" + encodeURIComponent(docId + ".pdf") + "&content_type=application/pdf",
            { method: "POST", body: fullPdfBlob },
          ).then((r) => r.json());
          pdfKey = r.key;
        }

        let newThumbKey = null;
        try {
          const t = await generatePdfThumbBlob(new File([fullPdfBlob], docId + ".pdf", { type: "application/pdf" }));
          if (t?.blob) {
            const tr = await apiFetch(
              "/api/objects/thumb-upload?key=" + encodeURIComponent(pdfKey) + "&ext=" + encodeURIComponent(t.ext),
              { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: t.blob },
            ).then((r) => r.json());
            newThumbKey = tr.thumb_key;
          }
        } catch (e) { console.error("pdf thumb failed", e); }

        const putBody = { pdf_key: pdfKey };
        if (newThumbKey) putBody.thumb_key = newThumbKey;
        await apiFetch("/api/documents/" + encodeURIComponent(docId) + "/pdf", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(putBody),
        });
        await refreshAll();
      } catch (e) { console.error("rebuildPdf failed", e); }
      finally { uploading.value = false; }
    };

    const deletePage = async (page) => {
      if (!page?.key || !pagesViewDocId.value) return;
      if (!confirm("Delete this page?")) return;
      const docId = pagesViewDocId.value;
      try {
        const resp = await apiFetch(
          "/api/documents/" + encodeURIComponent(docId) + "/pages?key=" + encodeURIComponent(page.key),
          { method: "DELETE" },
        ).then((r) => r.json());
        if (resp.document_deleted) {
          closePagesView();
          await refreshAll();
          return;
        }
        await refreshPagesView();
        // Rebuild PDF without the deleted page
        const docSettings = await apiFetch(
          "/api/documents/" + encodeURIComponent(docId) + "/pdf-settings",
        ).then((r) => r.json());
        if (docSettings.pdf_key !== undefined) {
          await rebuildPdfForDoc(docId, pagesViewList.value, docSettings.pdf_key);
        }
        await refreshAll();
      } catch (e) { console.error(e); }
    };

    const movePageUp = async (idx) => {
      if (idx <= 0) return;
      const docId = pagesViewDocId.value;
      const list = [...pagesViewList.value];
      [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
      pagesViewList.value = list;
      try {
        await apiFetch("/api/documents/" + encodeURIComponent(docId) + "/page-order", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keys: list.map((p) => p.key) }),
        });
        const docSettings = await apiFetch(
          "/api/documents/" + encodeURIComponent(docId) + "/pdf-settings",
        ).then((r) => r.json());
        await rebuildPdfForDoc(docId, list, docSettings.pdf_key);
      } catch (e) { console.error(e); }
    };

    const movePageDown = async (idx) => {
      const list = [...pagesViewList.value];
      if (idx >= list.length - 1) return;
      const docId = pagesViewDocId.value;
      [list[idx], list[idx + 1]] = [list[idx + 1], list[idx]];
      pagesViewList.value = list;
      try {
        await apiFetch("/api/documents/" + encodeURIComponent(docId) + "/page-order", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keys: list.map((p) => p.key) }),
        });
        const docSettings = await apiFetch(
          "/api/documents/" + encodeURIComponent(docId) + "/pdf-settings",
        ).then((r) => r.json());
        await rebuildPdfForDoc(docId, list, docSettings.pdf_key);
      } catch (e) { console.error(e); }
    };

    const openPagesView = async (doc) => {
      try {
        const resp = await apiFetch("/api/documents/" + encodeURIComponent(doc.id) + "/pages").then((r) => r.json());
        pagesViewList.value = (resp.pages || []).map((p) => ({
          ...p,
          thumb_url: p.thumb_key
            ? "/api/objects/thumb-download-url?thumb_key=" + encodeURIComponent(p.thumb_key)
            : null,
        }));
        pagesViewTitle.value = doc.title || "Document";
        pagesViewDocId.value = doc.id;
        pagesViewOpen.value = true;
      } catch (e) { console.error(e); }
    };

    // Document actions
    const viewDocument = async (doc) => {
      try {
        // If document has a PDF — always open it directly
        if (doc.pdf_key) {
          const url = "/api/objects/download-url?key=" + encodeURIComponent(doc.pdf_key);
          window.open(url, "_blank");
          return;
        }
        // Fallback for non-PDF documents
        if (doc.page_count === 1) {
          const resp = await apiFetch("/api/documents/" + encodeURIComponent(doc.id) + "/pages").then((r) => r.json());
          const page = (resp.pages || [])[0];
          if (!page) return;
          const name = page.filename || page.key || "";
          const url = "/api/objects/download-url?key=" + encodeURIComponent(page.key);
          if (isImage(name)) { openViewer(url, name); }
          else { window.open(url, "_blank"); }
        } else {
          const resp = await apiFetch("/api/documents/" + encodeURIComponent(doc.id) + "/pages").then((r) => r.json());
          pagesViewList.value = (resp.pages || []).map((p) => ({
            ...p,
            thumb_url: p.thumb_key
              ? "/api/objects/thumb-download-url?thumb_key=" + encodeURIComponent(p.thumb_key)
              : null,
          }));
          pagesViewTitle.value = doc.title || "Document";
          pagesViewDocId.value = doc.id;
          pagesViewOpen.value = true;
        }
      } catch (e) { console.error(e); }
    };

    const closePagesView = () => {
      pagesViewOpen.value = false;
      pagesViewList.value = [];
      pagesViewTitle.value = "";
      pagesViewDocId.value = null;
    };

    const openViewerFromPages = (pageIndex) => {
      const page = pagesViewList.value[pageIndex];
      if (!page) return;
      const name = page.filename || page.key || "";
      const urls = pagesViewList.value.map((p) =>
        "/api/objects/download-url?key=" + encodeURIComponent(p.key)
      );
      if (isImage(name)) {
        openViewer(urls[pageIndex], name, urls, pageIndex);
      } else {
        window.open(urls[pageIndex], "_blank");
      }
    };

    const editTags = async (doc) => {
      const initial = Array.isArray(doc.tags) ? doc.tags.join(" ") : "";
      const result = await openTagsModal({ title: "Edit tags", initialValue: initial });
      if (result === null) return;
      try {
        await apiFetch("/api/documents/" + encodeURIComponent(doc.id) + "/tags", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags: parseTagsInput(result) }),
        });
        await refreshAll();
      } catch (e) { console.error(e); }
    };

    const regeneratePdf = async (doc) => {
      uploading.value = true;
      uploadError.value = "";
      try {
        // Fetch original keys and saved settings
        const settings = await apiFetch(
          "/api/documents/" + encodeURIComponent(doc.id) + "/pdf-settings",
        ).then((r) => r.json());

        if (!settings.pages?.length) {
          uploadError.value = "No pages found for this document.";
          uploading.value = false;
          return;
        }

        // Download each page: use original_key if available, else fall back to processed key
        uploading.value = false;
        uploadProgress.value = 0;
        const decodedPages = [];
        for (const p of settings.pages) {
          const sourceKey = p.original_key || p.key;
          const blob = await apiFetch(
            "/api/objects/download-url?key=" + encodeURIComponent(sourceKey),
          ).then((r) => r.blob());
          const filename = sourceKey.split("/").pop() || "page.jpg";
          const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
          const img = await decodeImageFile(file);
          decodedPages.push({ file, img, baseImageData: null, autoVals: null, sourceKey });
        }

        // Open modal — modal runs auto-processing and populates baseImageData for each page
        const confirmed = await openPdfModal(decodedPages.map((p) => p.file));
        if (!confirmed) return;

        uploading.value = true;
        uploadProgress.value = 0;

        const pageList = pdfModalPages.value;
        const finalSettings = { brightness: pdfModalBrightness.value, contrast: pdfModalContrast.value, sharpness: pdfModalSharpness.value };
        const totalSteps = pageList.length * 2 + 1; // processed file + thumb + pdf
        let step = 0;
        const tick = () => { step++; uploadProgress.value = Math.round((step / totalSteps) * 100); };

        // Re-render and overwrite each processed file; update thumb
        const updatedPages = [];
        let newThumbKey = null;
        for (let i = 0; i < pageList.length; i++) {
          const page = pageList[i];
          const srcPage = settings.pages[i];
          const { blob: procBlob } = await renderPageBlob(page, finalSettings);
          const pageFilename = (srcPage.key || "").split("/").pop() || "page.jpg";

          // Overwrite the existing processed file in R2 at the same key
          await apiFetch(
            "/api/objects/replace?key=" + encodeURIComponent(srcPage.key) +
            "&content_type=image/jpeg",
            { method: "PUT", body: procBlob },
          ).then((r) => r.json());
          tick();

          // Regenerate thumb
          let thumbKey = srcPage.thumb_key || null;
          try {
            const thumbResult = await generateImageThumbBlob(new File([procBlob], pageFilename, { type: "image/jpeg" }));
            if (thumbResult?.blob) {
              const thumbResp = await apiFetch(
                "/api/objects/thumb-upload?key=" + encodeURIComponent(srcPage.key) +
                "&ext=" + encodeURIComponent(thumbResult.ext),
                { method: "POST", headers: { "Content-Type": thumbResult.ext === "webp" ? "image/webp" : "image/jpeg" }, body: thumbResult.blob },
              ).then((r) => r.json());
              thumbKey = thumbResp.thumb_key;
              if (i === 0) newThumbKey = thumbKey;
            }
          } catch (e) { console.error("thumb regen failed", e); }
          tick();

          // Pass original_key only if we have a real original — COALESCE in DB protects existing values
          updatedPages.push({ key: srcPage.key, original_key: srcPage.original_key || null, thumb_key: thumbKey });
        }

        // Regenerate PDF — overwrite existing pdf_key if present, else create new
        const pdfBlob = await renderPdfBlob(pageList, finalSettings);
        if (!pdfBlob) { uploadError.value = "PDF generation failed."; return; }
        let pdfKey;
        if (doc.pdf_key) {
          await apiFetch(
            "/api/objects/replace?key=" + encodeURIComponent(doc.pdf_key) +
            "&content_type=application/pdf",
            { method: "PUT", body: pdfBlob },
          ).then((r) => r.json());
          pdfKey = doc.pdf_key;
        } else {
          const pdfResp = await apiFetch(
            "/api/objects/upload?filename=" + encodeURIComponent(doc.id + ".pdf") +
            "&content_type=application/pdf",
            { method: "POST", body: pdfBlob },
          ).then((r) => r.json());
          pdfKey = pdfResp.key;
        }

        // Generate thumb from PDF first page
        let pdfThumbKey = null;
        try {
          const pdfThumbResult = await generatePdfThumbBlob(new File([pdfBlob], doc.id + ".pdf", { type: "application/pdf" }));
          if (pdfThumbResult?.blob) {
            const pdfThumbResp = await apiFetch(
              "/api/objects/thumb-upload?key=" + encodeURIComponent(pdfKey) +
              "&ext=" + encodeURIComponent(pdfThumbResult.ext),
              { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: pdfThumbResult.blob },
            ).then((r) => r.json());
            pdfThumbKey = pdfThumbResp.thumb_key;
          }
        } catch (e) { console.error("pdf thumb regen failed", e); }
        tick();

        // Persist: use PDF thumb as document thumb; fallback to page thumb
        const putBody = { pdf_key: pdfKey, correction_settings: finalSettings, pages: updatedPages };
        putBody.thumb_key = pdfThumbKey || newThumbKey || undefined;
        await apiFetch("/api/documents/" + encodeURIComponent(doc.id) + "/pdf", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(putBody),
        });

        uploadProgress.value = 100;
        await refreshAll();
      } catch (e) {
        console.error("regenerate failed:", e);
        uploadError.value = e?.message || "Regeneration failed.";
      } finally {
        uploading.value = false;
        uploadProgress.value = 0;
      }
    };

    const downloadPage = async (page) => {
      try {
        const url = "/api/objects/download-url?key=" + encodeURIComponent(page.key);
        const a = document.createElement("a");
        a.href = url; a.download = page.filename || page.key.split("/").pop() || "download";
        a.target = "_blank"; document.body.appendChild(a); a.click(); document.body.removeChild(a);
      } catch (e) { console.error(e); }
    };

    const deleteDocument = async (doc) => {
      const id = typeof doc === "string" ? doc : doc?.id;
      if (!id || !confirm("Delete this document" + (doc?.page_count > 1 ? " with " + doc.page_count + " pages?" : "?"))) return;
      try {
        await apiFetch("/api/documents/" + encodeURIComponent(id), { method: "DELETE" });
        await refreshAll();
      } catch (e) { console.error(e); }
    };

    onMounted(async () => {
      try {
        const r = await fetch("/api/auth/check");
        if (!r.ok) { window.location.href = "/"; return; }
      } catch { window.location.href = "/"; return; }
      fetchDocuments();
      fetchTopTags();
      fetchAllTags();
      fetchUsage();
      window.addEventListener("keydown", onViewerKeydown);
    });

    return {
      documents, loading, uploading, uploadProgress, uploadError,
      activeTag, tagQuery, topTags, relatedTags, cloudTags,
      tagModalOpen, tagModalTitle, tagModalInput,
      viewerOpen, viewerUrl, viewerName, viewerStage, viewerImg, viewerImgStyle,
      viewerPages, viewerPageIndex,
      onViewerImgLoad, onViewerPointerDown, onViewerPointerMove, onViewerPointerUp,
      viewerPrev, viewerNext, closeViewer,
      pagesViewOpen, pagesViewTitle, pagesViewList, pagesViewDocId, closePagesView, openViewerFromPages, openPagesView, deletePage, movePageUp, movePageDown,
      menuKey, tagToColors, refreshAll, setActiveTag, clearActiveTag,
      handleFileUpload, deleteDocument, isImage, isPdf, viewDocument,
      getExt, getExtIcon, closeTagsModal, editTags, downloadPage, logout,
      isDragOver, onDragOver, onDragEnter, onDragLeave, onDrop,
      triggerAddPages, handleAddPagesInput,
      usage, usagePct, formatNum,
      pdfModalOpen, pdfModalProcessing, pdfModalPages, pdfModalPageIdx,
      pdfModalBrightness, pdfModalContrast, pdfModalSharpness,
      pdfModalSizeKb, pdfModalCanvas, pdfModalCurrentPage,
      pdfModalOnSlider, pdfModalConfirm, pdfModalCancel,
      pdfModalPreview, pdfZoom, pdfCanvasStyle, pdfZoomIn, pdfZoomOut, pdfZoomReset, onPdfPreviewWheel,
      onPdfDragStart, onPdfDragMove, onPdfDragEnd,
      regeneratePdf,
    };
  },
}).mount("#app");
