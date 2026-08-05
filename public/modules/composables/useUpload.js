import { ref } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";

// Upload pipeline: drag&drop, file input, add-pages flow, and the core
// processAndUploadPages routine (split into focused helpers).
//
// Dependencies (passed in):
//   apiFetch              — authorized fetch wrapper
//   uploading             — shared ref<boolean>
//   uploadProgress        — shared ref<number>
//   uploadError           — shared ref<string>
//   refreshAll            — top-level refresh callback
//   refreshPagesView      — pages view refresh callback
//   activeTags            — shared ref<string[]> of currently active filter tags
//   setActiveTag          — adds a tag to the active filter (fetches docs + related)
//   renderPageBlob        — renders a processed page blob from a decoded list item
//   renderPdfBlob         — builds a PDF blob from a list + settings
//   addJpegBlobToPdf      — appends a JPEG blob to a jsPDF instance
//   generateImageThumbBlob, generatePdfThumbBlob
//   openPdfModal          — opens processing modal, returns settings or null
//   openTagsModal         — opens tags modal, returns string or null
//   pdfModalPages         — ref of decoded pages populated by openPdfModal
//   parseTagsInput        — parses tags string into array
//   isImage, isPdf        — file-type predicates
export function useUpload({
  apiFetch,
  uploading,
  uploadProgress,
  uploadError,
  refreshAll,
  refreshPagesView,
  activeTags,
  setActiveTag,
  renderPageBlob,
  renderPdfBlob,
  addJpegBlobToPdf,
  generateImageThumbBlob,
  generatePdfThumbBlob,
  openPdfModal,
  openTagsModal,
  pdfModalPages,
  parseTagsInput,
  isImage,
  isPdf,
}) {
  const isDragOver = ref(false);
  let dragCounter = 0;

  const genDocId = () => "doc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

  // After a new doc is registered, make its thumbnail visible. If no tag is
  // currently active, activate the first assigned tag so the gallery shows the
  // freshly uploaded file alongside other documents sharing that tag. Otherwise
  // just refresh the current view.
  const revealUploaded = async (tags) => {
    if (!activeTags.value.length && tags && tags.length) {
      await setActiveTag(tags[0]);
    } else {
      await refreshAll();
    }
  };

  // Upload one original file → returns R2 key.
  const uploadOriginal = async (file) => {
    const j = await apiFetch(
      "/api/objects/upload?filename=" + encodeURIComponent("originals/" + file.name) +
      "&content_type=" + encodeURIComponent(file.type || "image/jpeg"),
      { method: "POST", body: file },
    ).then((r) => r.json());
    return j.key;
  };

  // Render + upload one processed page; upload its thumb.
  // Returns { procKey, procName, procBlob, thumbKey }.
  const renderAndUploadProcessed = async (item, settings) => {
    const { blob: procBlob } = await renderPageBlob(item, settings);
    const procName = item.file.name.replace(/\.[^.]+$/, "") + ".jpg";
    const procResp = await apiFetch(
      "/api/objects/upload?filename=" + encodeURIComponent(procName) +
      "&content_type=image/jpeg",
      { method: "POST", body: procBlob },
    ).then((r) => r.json());

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

    return { procKey: procResp.key, procName, procBlob, thumbKey };
  };

  // Build the doc-level PDF from the list + settings, upload it, generate its thumb.
  // Returns { pdfKey, pdfThumbKey } or { null, null }.
  const generatePdfAndThumbs = async (list, settings, docIdForPdf) => {
    const pdfBlob = await renderPdfBlob(list, settings);
    if (!pdfBlob) return { pdfKey: null, pdfThumbKey: null };
    const pdfResp = await apiFetch(
      "/api/objects/upload?filename=" + encodeURIComponent(docIdForPdf + ".pdf") +
      "&content_type=application/pdf",
      { method: "POST", body: pdfBlob },
    ).then((r) => r.json());
    const pdfKey = pdfResp.key;

    let pdfThumbKey = null;
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

    return { pdfKey, pdfThumbKey };
  };

  // After new pages are registered on an existing doc, rebuild the full PDF
  // (existing pages downloaded from R2 + newly rendered blobs) in page_number
  // order, then PUT /pdf with the new pdf_key + thumb.
  const registerPagesAndRebuildPdf = async (addDocId, pages, uploadedKeys, originalKeys, processedBlobs, settings) => {
    // Register new pages first so page_count is correct
    await apiFetch("/api/documents/" + encodeURIComponent(addDocId) + "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pages }),
    });

    const jspdf = window.jspdf?.jsPDF;
    if (!jspdf) {
      await refreshAll();
      await refreshPagesView();
      return;
    }

    try {
      const existingResp = await apiFetch(
        "/api/documents/" + encodeURIComponent(addDocId) + "/pages",
      ).then((r) => r.json());
      const allPages = (existingResp.pages || []).sort((a, b) => (a.page_number || 0) - (b.page_number || 0));

      const newKeys = new Set(uploadedKeys);
      let fullPdf = null;
      for (const p of allPages) {
        if (newKeys.has(p.key)) {
          const idx = uploadedKeys.indexOf(p.key);
          const blob = processedBlobs[idx]?.blob;
          if (blob) fullPdf = await addJpegBlobToPdf(fullPdf, blob, jspdf);
        } else {
          const blob = await apiFetch(
            "/api/objects/download-url?key=" + encodeURIComponent(p.key),
          ).then((r) => r.blob());
          if (blob?.size) fullPdf = await addJpegBlobToPdf(fullPdf, blob, jspdf);
        }
      }

      if (!fullPdf) {
        await refreshAll();
        await refreshPagesView();
        return;
      }

      const fullPdfBlob = fullPdf.output("blob");
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
    } catch (e) { console.error("full pdf rebuild failed", e); }

    await refreshAll();
    await refreshPagesView();
  };

  // Core upload function: handles both new doc and add-pages flows.
  // list: decoded items { file, img, ... } from the processing modal.
  // settings: { brightness, contrast, sharpness } from modal.
  // addDocId: existing doc id to add pages to, or null for new doc.
  // tags: array of tags (new doc only).
  // comment: string (new doc only).
  const processAndUploadPages = async (list, settings, addDocId, tags, comment) => {
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

        const origKey = await uploadOriginal(file);
        originalKeys.push(origKey);
        tick();

        const { procKey, procBlob, thumbKey } = await renderAndUploadProcessed(list[i], settings);
        uploadedKeys.push(procKey);
        processedBlobs.push({ blob: procBlob, img });
        pageThumbKeys.push(thumbKey);
        tick();
        tick();
      }

      const docIdForPdf = addDocId || genDocId();
      const { pdfKey, pdfThumbKey } = await generatePdfAndThumbs(list, settings, docIdForPdf);
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
        await registerPagesAndRebuildPdf(addDocId, pages, uploadedKeys, originalKeys, processedBlobs, settings);
      } else {
        const docId = genDocId();
        await apiFetch("/api/documents/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: docId,
            title: list[0].file.name,
            pages,
            tags: tags || [],
            comment: comment || "",
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
        await revealUploaded(tags);
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

  // Simple (non-image) upload path: no processing modal, optional PDF thumb.
  const uploadNonImageFiles = async (otherFiles, tags, comment) => {
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
      const docId = genDocId();
      await apiFetch("/api/documents/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: docId,
          title: otherFiles[0].name,
          pages: otherFiles.map((f, i) => ({ key: uploadedKeys[i], filename: f.name, content_type: f.type, size: f.size, page_number: i + 1, thumb_key: pageThumbKeys[i] })),
          tags,
          comment: comment || "",
          thumb_key: pageThumbKeys[0],
        }),
      });
      await revealUploaded(tags);
    } catch (e) {
      uploadError.value = e?.message || "Upload failed.";
      for (const k of uploadedKeys) { try { await apiFetch("/api/objects/" + encodeURIComponent(k), { method: "DELETE" }); } catch {} }
    } finally { uploading.value = false; uploadProgress.value = 0; }
  };

  const uploadFiles = async (filesToUpload) => {
    const allFiles = Array.from(filesToUpload || []).filter((f) => f instanceof File);
    if (!allFiles.length) return;
    allFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const imageFiles = allFiles.filter((f) => isImage(f.name));
    const otherFiles = allFiles.filter((f) => !isImage(f.name));

    if (otherFiles.length) {
      const title = otherFiles.length === 1 ? "Enter tags" : "Enter tags for all files";
      const result = await openTagsModal({ title, initialValue: "" });
      if (result === null) return;
      await uploadNonImageFiles(otherFiles, parseTagsInput(result.tags), result.comment);
    }

    if (imageFiles.length) {
      const pages = await openPdfModal(imageFiles);
      if (!pages) return; // cancelled
      const title = imageFiles.length === 1 ? "Enter tags" : "Enter tags for all files";
      const tagsResult = await openTagsModal({ title, initialValue: "" });
      if (tagsResult === null) return;
      const decodedList = pdfModalPages.value.slice(0, imageFiles.length);
      await processAndUploadPages(decodedList, pages, null, parseTagsInput(tagsResult.tags), tagsResult.comment);
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

  return {
    isDragOver,
    uploadFiles, handleFileUpload,
    triggerAddPages, handleAddPagesInput,
    onDragOver, onDragEnter, onDragLeave, onDrop,
    processAndUploadPages,
  };
}
