const { createApp, ref, computed, onMounted, nextTick } = Vue;

const API_BASE = "";

const getAuthHeader = () => {
  const k = localStorage.getItem("api_key");
  return k ? "Bearer " + k : null;
};
const checkAuth = () => !!localStorage.getItem("api_key");

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
    if (!checkAuth()) { window.location.href = "/"; return {}; }

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
    const logout = () => { localStorage.removeItem("api_key"); window.location.href = "/"; };

    // API helper
    const apiFetch = (url, opts) => {
      const h = { ...(opts?.headers || {}), Authorization: getAuthHeader() };
      return fetch(API_BASE + url, { ...opts, headers: h }).then((r) => {
        if (r.status === 401) { logout(); throw new Error("Unauthorized"); }
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
            ? "/api/objects/thumb-download-url?thumb_key=" + encodeURIComponent(d.thumb_key) + "&token=" + encodeURIComponent(localStorage.getItem("api_key") || "")
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

    // Upload
    const uploadFiles = async (filesToUpload) => {
      const list = Array.from(filesToUpload || []).filter((f) => f instanceof File);
      if (!list.length) return;

      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      const title = list.length === 1 ? "Enter tags for file" : "Enter tags for all files";
      const result = await openTagsModal({ title, initialValue: "" });
      if (result === null) return;
      const tags = parseTagsInput(result);

      uploading.value = true;
      uploadProgress.value = 0;
      uploadError.value = "";

      const uploadedKeys = [];
      try {
        for (let i = 0; i < list.length; i++) {
          const file = list[i];
          const uploadResp = await apiFetch(
            "/api/objects/upload?filename=" + encodeURIComponent(file.name) +
            "&content_type=" + encodeURIComponent(file.type || "application/octet-stream"),
            { method: "POST", body: file },
          ).then((r) => r.json());
          uploadedKeys.push(uploadResp.key);
          uploadProgress.value = Math.round(((i + 1) / list.length) * 100);
        }

        let thumbKey = null;
        const firstFile = list[0];
        try {
          const thumb = isImage(firstFile.name) ? await generateImageThumbBlob(firstFile)
            : isPdf(firstFile.name) ? await generatePdfThumbBlob(firstFile)
            : null;
          if (thumb?.blob && thumb?.ext) {
            const firstKey = uploadedKeys[0];
            const thumbResp = await apiFetch(
              "/api/objects/thumb-upload?key=" + encodeURIComponent(firstKey) +
              "&ext=" + encodeURIComponent(thumb.ext),
              { method: "POST", headers: { "Content-Type": thumb.ext === "webp" ? "image/webp" : "image/jpeg" }, body: thumb.blob },
            ).then((r) => r.json());
            thumbKey = thumbResp.thumb_key;
          }
        } catch (e) { console.error("thumb generation failed:", e); }

        const docId = "doc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
        const pages = list.map((file, i) => ({
          key: uploadedKeys[i],
          filename: file.name,
          content_type: file.type,
          size: file.size,
          page_number: i + 1,
        }));

        await apiFetch("/api/documents/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: docId,
            title: firstFile.name,
            pages,
            tags,
            thumb_key: thumbKey,
          }),
        });

        await refreshAll();
      } catch (e) {
        console.error("upload failed:", e);
        uploadError.value = e?.message || "Upload failed. All files will be cleaned up.";
        for (const key of uploadedKeys) {
          try { await apiFetch("/api/objects/" + encodeURIComponent(key), { method: "DELETE" }); } catch {}
        }
      } finally {
        uploading.value = false;
        uploadProgress.value = 0;
      }
    };

    const handleFileUpload = async (event) => {
      const input = event?.target;
      if (!input?.files?.length) return;
      try { await uploadFiles(input.files); } finally { try { input.value = ""; } catch {} }
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

    // Document actions
    const viewDocument = async (doc) => {
      try {
        if (doc.page_count === 1) {
          const resp = await apiFetch("/api/documents/" + encodeURIComponent(doc.id) + "/pages").then((r) => r.json());
          const page = (resp.pages || [])[0];
          if (!page) return;
          const name = page.filename || page.key || "";
          const url = "/api/objects/download-url?key=" + encodeURIComponent(page.key) + "&token=" + encodeURIComponent(localStorage.getItem("api_key") || "");
          if (isImage(name)) { openViewer(url, name); }
          else { window.open(url, "_blank"); }
        } else {
          const resp = await apiFetch("/api/documents/" + encodeURIComponent(doc.id) + "/pages").then((r) => r.json());
          pagesViewList.value = (resp.pages || []).map((p) => ({
            ...p,
            thumb_url: p.thumb_key
              ? "/api/objects/thumb-download-url?thumb_key=" + encodeURIComponent(p.thumb_key) + "&token=" + encodeURIComponent(localStorage.getItem("api_key") || "")
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
      const token = encodeURIComponent(localStorage.getItem("api_key") || "");
      const urls = pagesViewList.value.map((p) =>
        "/api/objects/download-url?key=" + encodeURIComponent(p.key) + "&token=" + token
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

    const downloadPage = async (page) => {
      try {
        const url = "/api/objects/download-url?key=" + encodeURIComponent(page.key) + "&token=" + encodeURIComponent(localStorage.getItem("api_key") || "");
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

    onMounted(() => {
      fetchDocuments();
      fetchTopTags();
      fetchAllTags();
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
      pagesViewOpen, pagesViewTitle, pagesViewList, closePagesView, openViewerFromPages,
      menuKey, tagToColors, refreshAll, setActiveTag, clearActiveTag,
      handleFileUpload, deleteDocument, isImage, isPdf, viewDocument,
      getExt, getExtIcon, closeTagsModal, editTags, downloadPage, logout,
      isDragOver, onDragOver, onDragEnter, onDragLeave, onDrop,
    };
  },
}).mount("#app");
