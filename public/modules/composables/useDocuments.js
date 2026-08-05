import { ref, computed } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";

// Documents orchestration: top-level state (documents list, tags, tag query),
// data fetching, tag filtering, and document actions (view, edit tags,
// regenerate PDF, delete, download page).
//
// Dependencies (passed in):
//   apiFetch, fetchDocumentsData, fetchTopTagsData, fetchAllTagsData,
//   fetchRelatedTagsData, deleteDocumentApi, editTagsApi
//   normalizeTag, parseTagsInput
//   uploading, uploadProgress, uploadError — shared upload refs
//   decodeImageFile, renderPageBlob, renderPdfBlob
//   generateImageThumbBlob, generatePdfThumbBlob
//   openPdfModal, openTagsModal
//   pdfModalPages, pdfModalBrightness, pdfModalContrast, pdfModalSharpness
//   openViewer, openPdfViewer, closeViewer, closePdfViewer, downloadBlob
//   pagesViewOpen, pagesViewList, pagesViewTitle, pagesViewDocId — shared refs
//   isImage, isPdf
export function useDocuments({
  apiFetch,
  fetchDocumentsData,
  fetchTopTagsData,
  fetchAllTagsData,
  fetchRelatedTagsData,
  deleteDocumentApi,
  editTagsApi,
  normalizeTag,
  parseTagsInput,
  uploading,
  uploadProgress,
  uploadError,
  decodeImageFile,
  renderPageBlob,
  renderPdfBlob,
  generateImageThumbBlob,
  generatePdfThumbBlob,
  openPdfModal,
  openTagsModal,
  pdfModalPages,
  pdfModalBrightness,
  pdfModalContrast,
  pdfModalSharpness,
  openViewer,
  openPdfViewer,
  closeViewer,
  closePdfViewer,
  downloadBlob,
  pagesViewOpen,
  pagesViewList,
  pagesViewTitle,
  pagesViewDocId,
  isImage,
  isPdf,
}) {
  const documents = ref([]);
  const loading = ref(false);
  const activeTags = ref([]);
  const tagQuery = ref("");
  const topTags = ref([]);
  const relatedTags = ref([]);
  const allTags = ref([]);

  // Doc navigation within the currently active tag's document list.
  // Captured at viewDocument time so the viewer can cycle prev/next.
  const viewerDocList = ref([]);
  const viewerDocIndex = ref(-1);
  const canNavDocs = computed(() => viewerDocList.value.length > 1);

  const normalizedTagQuery = computed(() => normalizeTag(tagQuery.value));
  const cloudTags = computed(() => {
    if (activeTags.value.length) return relatedTags.value;
    const q = normalizedTagQuery.value;
    if (!q) return topTags.value;
    return (allTags.value.length ? allTags.value : topTags.value)
      .filter((t) => normalizeTag(t?.tag || "").includes(q)).slice(0, 50);
  });

  const fetchTopTags = async () => {
    try { topTags.value = await fetchTopTagsData(); }
    catch { topTags.value = []; }
  };
  const fetchAllTags = async () => {
    try { allTags.value = await fetchAllTagsData(); }
    catch { allTags.value = []; }
  };
  const fetchRelatedTags = async () => {
    if (!activeTags.value.length) { relatedTags.value = []; return; }
    try { relatedTags.value = await fetchRelatedTagsData(activeTags.value); }
    catch { relatedTags.value = []; }
  };

  const fetchDocuments = async () => {
    loading.value = true;
    try {
      documents.value = await fetchDocumentsData(activeTags.value);
    } catch (e) { console.error(e); }
    finally { loading.value = false; }
  };

  const refreshAll = async () => {
    if (activeTags.value.length) {
      await Promise.all([fetchDocuments(), fetchRelatedTags(), fetchAllTags()]);
      return;
    }
    documents.value = [];
    await Promise.all([fetchTopTags(), fetchAllTags()]);
  };

  // Add a tag to the active filter (AND). No-op if already present.
  const setActiveTag = async (tag) => {
    const n = normalizeTag(tag);
    if (!n || activeTags.value.includes(n)) return;
    activeTags.value = [...activeTags.value, n]; tagQuery.value = "";
    await Promise.all([fetchDocuments(), fetchRelatedTags()]);
  };
  // Remove one tag from the active filter; clears all if it was the last.
  const removeActiveTag = async (tag) => {
    const n = normalizeTag(tag);
    if (!n) return;
    activeTags.value = activeTags.value.filter((t) => t !== n);
    if (!activeTags.value.length) {
      tagQuery.value = ""; relatedTags.value = []; documents.value = [];
      await Promise.all([fetchTopTags(), fetchAllTags()]);
    } else {
      await Promise.all([fetchDocuments(), fetchRelatedTags()]);
    }
  };

  const viewDocument = async (doc) => {
    // Remember which document of the current tag list is open so the viewer
    // header arrows can cycle prev/next. Only set when opened from the tag
    // list (openViewerFromPages bypasses viewDocument and leaves this as-is).
    const list = documents.value;
    const idx = list.findIndex((d) => d.id === doc.id);
    if (idx >= 0) { viewerDocList.value = list; viewerDocIndex.value = idx; }
    try {
      // If document has a PDF — open it inline so the WebView keeps the auth cookie
      if (doc.pdf_key) {
        const url = "/api/objects/download-url?key=" + encodeURIComponent(doc.pdf_key);
        const name = doc.title || doc.pdf_key.split("/").pop() || "Document";
        await openPdfViewer(url, name);
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
        else if (isPdf(name)) { await openPdfViewer(url, name); }
        else { await downloadBlob(url, name); }
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

  const viewDocumentByOffset = async (offset) => {
    const list = viewerDocList.value;
    if (list.length <= 1) return;
    const n = list.length;
    const next = (viewerDocIndex.value + offset + n) % n;
    const doc = list[next];
    // Close any open viewer so switching doc types (image↔pdf) doesn't stack overlays.
    if (closeViewer) closeViewer();
    if (closePdfViewer) closePdfViewer();
    await viewDocument(doc);
  };
  const viewDocumentPrev = () => viewDocumentByOffset(-1);
  const viewDocumentNext = () => viewDocumentByOffset(1);

  const editTags = async (doc) => {
    const initial = Array.isArray(doc.tags) ? doc.tags.join(" ") : "";
    const result = await openTagsModal({ title: "Edit tags", initialValue: initial, initialComment: doc.comment || "" });
    if (result === null) return;
    try {
      await editTagsApi(doc.id, result.tags, result.comment);
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

      // Download each page: use original_key (original is never transformed);
      // fall back to processed key for older docs without original
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
    const url = "/api/objects/download-url?key=" + encodeURIComponent(page.key);
    const name = page.filename || page.key.split("/").pop() || "download";
    await downloadBlob(url, name);
  };

  const deleteDocument = async (doc) => {
    const id = typeof doc === "string" ? doc : doc?.id;
    if (!id || !confirm("Delete this document" + (doc?.page_count > 1 ? " with " + doc.page_count + " pages?" : "?"))) return;
    try {
      await deleteDocumentApi(id);
      await refreshAll();
    } catch (e) { console.error(e); }
  };

  return {
    documents, loading, activeTags, tagQuery, topTags, relatedTags, allTags,
    cloudTags,
    viewerDocList, viewerDocIndex, canNavDocs,
    fetchTopTags, fetchAllTags,
    refreshAll, setActiveTag, removeActiveTag,
    viewDocument, viewDocumentPrev, viewDocumentNext,
    editTags, regeneratePdf, deleteDocument, downloadPage,
  };
}
