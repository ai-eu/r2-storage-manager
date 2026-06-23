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

    const files = ref([]);
    const loading = ref(false);
    const uploading = ref(false);
    const uploadProgress = ref(0);
    const activeTag = ref("");
    const tagQuery = ref("");
    const topTags = ref([]);
    const relatedTags = ref([]);
    const allTags = ref([]);
    const menuKey = ref(null);

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
    const openViewer = async (url, name) => {
      viewerUrl.value = url || ""; viewerName.value = name || "";
      viewerOpen.value = true; resetViewerTransform(); await nextTick();
    };
    const closeViewer = () => {
      viewerOpen.value = false; viewerUrl.value = ""; viewerName.value = "";
      resetViewerTransform();
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

    const fetchFiles = async () => {
      loading.value = true;
      try {
        const qs = activeTag.value ? "?tag=" + encodeURIComponent(activeTag.value) : "";
        const data = await apiFetch("/api/objects" + qs).then((r) => r.json());
        const objs = data.objects || [];

        // Resolve thumb URLs for objects that have thumb_key
        const withThumbs = objs.map((o) => ({
          ...o,
          thumb_url: o.thumb_key
            ? "/api/objects/thumb-download-url?thumb_key=" + encodeURIComponent(o.thumb_key) + "&token=" + encodeURIComponent(localStorage.getItem("api_key") || "")
            : null,
        }));

        files.value = withThumbs;
      } catch (e) { console.error(e); }
      finally { loading.value = false; }
    };

    const refreshAll = async () => {
      if (activeTag.value) {
        await Promise.all([fetchFiles(), fetchRelatedTags(activeTag.value), fetchAllTags()]);
        return;
      }
      await Promise.all([fetchFiles(), fetchTopTags(), fetchAllTags()]);
    };

    const setActiveTag = async (tag) => {
      activeTag.value = normalizeTag(tag); tagQuery.value = "";
      await Promise.all([fetchFiles(), fetchRelatedTags(activeTag.value)]);
    };
    const clearActiveTag = async () => {
      activeTag.value = ""; tagQuery.value = ""; relatedTags.value = [];
      await Promise.all([fetchFiles(), fetchTopTags(), fetchAllTags()]);
    };

    // Upload
    const uploadFiles = async (filesToUpload, opts) => {
      const list = Array.from(filesToUpload || []).filter((f) => f instanceof File);
      if (!list.length) return;

      const title = opts?.tagsTitle || (list.length === 1 ? "Enter tags for file" : "Enter tags for all files");
      const result = await openTagsModal({ title, initialValue: "" });
      if (result === null) return;
      const tags = parseTagsInput(result);

      uploading.value = true; uploadProgress.value = 0;
      try {
        for (let i = 0; i < list.length; i++) {
          const file = list[i];
          // Upload file to R2 via Worker
          const uploadResp = await apiFetch("/api/objects/upload?filename=" + encodeURIComponent(file.name) + "&content_type=" + encodeURIComponent(file.type || "application/octet-stream"), {
            method: "POST",
            body: file,
          }).then((r) => r.json());
          const fileKey = uploadResp.key;

          // Register metadata first (without thumb)
          await apiFetch("/api/objects/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              key: fileKey, filename: file.name, content_type: file.type,
              size: file.size, tags, thumb_key: null,
            }),
          });

          // Generate and upload thumb after file is registered
          try {
            const thumb = isImage(file.name) ? await generateImageThumbBlob(file)
              : isPdf(file.name) ? await generatePdfThumbBlob(file)
              : null;
            if (thumb?.blob && thumb?.ext) {
              const thumbResp = await apiFetch("/api/objects/thumb-upload?key=" + encodeURIComponent(fileKey) + "&ext=" + encodeURIComponent(thumb.ext), {
                method: "POST",
                headers: { "Content-Type": thumb.ext === "webp" ? "image/webp" : "image/jpeg" },
                body: thumb.blob,
              }).then((r) => r.json());

              await apiFetch("/api/objects/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  key: fileKey, filename: file.name, content_type: file.type,
                  size: file.size, tags, thumb_key: thumbResp.thumb_key,
                }),
              });
            }
          } catch (e) { console.error("thumb generation failed:", e); }

          uploadProgress.value = Math.round(((i + 1) / list.length) * 100);
        }
        await refreshAll();
      } catch (e) { console.error(e); }
      finally { uploading.value = false; uploadProgress.value = 0; }
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

    // File actions
    const viewFile = async (file) => {
      try {
        const name = file.filename || file.key || "";
        const url = "/api/objects/download-url?key=" + encodeURIComponent(file.key) + "&token=" + encodeURIComponent(localStorage.getItem("api_key") || "");
        if (isImage(name)) { openViewer(url, name); }
        else { window.open(url, "_blank"); }
      } catch (e) { console.error(e); }
    };

    const editTags = async (file) => {
      const initial = Array.isArray(file.tags) ? file.tags.join(" ") : "";
      const result = await openTagsModal({ title: "Edit tags", initialValue: initial });
      if (result === null) return;
      try {
        await apiFetch("/api/objects/tags", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: file.key, tags: parseTagsInput(result) }),
        });
        await refreshAll();
      } catch (e) { console.error(e); }
    };

    const downloadFile = async (file) => {
      try {
        const url = "/api/objects/download-url?key=" + encodeURIComponent(file.key) + "&token=" + encodeURIComponent(localStorage.getItem("api_key") || "");
        const a = document.createElement("a");
        a.href = url; a.download = file.filename || file.key.split("/").pop() || "download";
        a.target = "_blank"; document.body.appendChild(a); a.click(); document.body.removeChild(a);
      } catch (e) { console.error(e); }
    };

    const deleteFile = async (file) => {
      const key = typeof file === "string" ? file : file?.key;
      if (!key || !confirm("Delete this file?")) return;
      try {
        await apiFetch("/api/objects/" + encodeURIComponent(key), { method: "DELETE" });
        await refreshAll();
      } catch (e) { console.error(e); }
    };

    const generateMissingPdfThumbs = async () => {
      const pdfsWithoutThumb = files.value.filter(
        (f) => !f.thumb_key && isPdf(f.filename || f.key)
      );
      if (!pdfsWithoutThumb.length) return;
      for (const file of pdfsWithoutThumb) {
        try {
          const resp = await apiFetch("/api/objects/download-url?key=" + encodeURIComponent(file.key));
          const blob = await resp.blob();
          const thumb = await generatePdfThumbBlob(blob);
          if (!thumb?.blob) continue;
          const thumbResp = await apiFetch("/api/objects/thumb-upload?key=" + encodeURIComponent(file.key) + "&ext=" + encodeURIComponent(thumb.ext), {
            method: "POST",
            headers: { "Content-Type": "image/jpeg" },
            body: thumb.blob,
          }).then((r) => r.json());
          await apiFetch("/api/objects/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              key: file.key,
              filename: file.filename,
              content_type: file.content_type,
              size: file.size,
              uploaded_at: file.uploaded_at,
              tags: file.tags || [],
              thumb_key: thumbResp.thumb_key,
            }),
          });
          const idx = files.value.findIndex((f) => f.key === file.key);
          if (idx !== -1) {
            files.value[idx] = { ...files.value[idx], thumb_key: thumbResp.thumb_key, thumb_url: "/api/objects/thumb-download-url?thumb_key=" + encodeURIComponent(thumbResp.thumb_key) + "&token=" + encodeURIComponent(localStorage.getItem("api_key") || "") };
          }
        } catch (e) { console.error("pdf thumb gen failed for", file.key, e); }
      }
    };

    onMounted(() => { fetchFiles().then(generateMissingPdfThumbs); fetchTopTags(); fetchAllTags(); });

    return {
      files, loading, uploading, uploadProgress,
      activeTag, tagQuery, topTags, relatedTags, cloudTags,
      tagModalOpen, tagModalTitle, tagModalInput,
      viewerOpen, viewerUrl, viewerName, viewerStage, viewerImg, viewerImgStyle,
      onViewerImgLoad, onViewerPointerDown, onViewerPointerMove, onViewerPointerUp,
      menuKey, tagToColors, refreshAll, setActiveTag, clearActiveTag,
      handleFileUpload, deleteFile, isImage, isPdf, viewFile, closeViewer,
      getExt, getExtIcon, closeTagsModal, editTags, downloadFile, logout,
      isDragOver, onDragOver, onDragEnter, onDragLeave, onDrop,
    };
  },
}).mount("#app");
