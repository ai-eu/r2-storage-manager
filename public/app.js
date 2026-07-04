import { createApp, ref, computed, onMounted, nextTick } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import { normalizeTag, parseTagsInput, tagToColors } from "./modules/utils/tags.js";
import { getExt, getExtIcon, isImage, isPdf } from "./modules/utils/files.js";
import { formatNum, formatBytes } from "./modules/utils/format.js";
import { decodeImageFile, autoProcessImageData, applySliderDeltas, autoPickQuality } from "./modules/image/process.js";
import { generateImageThumbBlob, generatePdfThumbBlob } from "./modules/image/thumb.js";
import { renderPageBlob, addJpegBlobToPdf, renderPdfBlob } from "./modules/pdf/build.js";
import { apiFetch, logout } from "./modules/api/client.js";
import { fetchUsage as fetchUsageData } from "./modules/api/usage.js";
import {
  fetchTopTags as fetchTopTagsData,
  fetchAllTags as fetchAllTagsData,
  fetchRelatedTags as fetchRelatedTagsData,
  fetchDocuments as fetchDocumentsData,
  deleteDocument as deleteDocumentApi,
  editTags as editTagsApi,
} from "./modules/api/documents.js";
import { useImageViewer } from "./modules/composables/useImageViewer.js";
import { usePdfViewer } from "./modules/composables/usePdfViewer.js";
import { usePdfModal } from "./modules/composables/usePdfModal.js";
import { useTagsModal } from "./modules/composables/useTagsModal.js";
import { usePagesView } from "./modules/composables/usePagesView.js";

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

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
    const workersPct = computed(() => {
      const w = usage.value?.workers;
      if (!w || !w.limit) return 0;
      return Math.min(100, Math.round((w.used / w.limit) * 100));
    });
    const storagePct = computed(() => {
      const s = usage.value?.r2_storage;
      if (!s || !s.limit_bytes) return 0;
      return Math.min(100, Math.round((s.used_bytes / s.limit_bytes) * 100));
    });

    // Menu functions
    const getMenuItems = (doc) => {
      const items = [];
      const filename = doc.title || doc.id;
      
      // Tags - всегда доступно
      items.push({ action: 'editTags', title: 'Tags' });
      
      // Если это НЕ изображение и НЕ PDF - показываем только Tags и Delete
      if (!isImage(filename) && !isPdf(filename)) {
        items.push({ action: 'delete', title: 'Delete' });
        return items;
      }
      
      // Для изображений и PDF - полное меню
      
      // Add pages - всегда доступно в полном меню
      items.push({ action: 'addPages', title: 'Add pages' });
      
      // Edit pages - всегда доступно в полном меню  
      items.push({ action: 'editPages', title: 'Edit pages' });
      
      // Re-process PDF - только для изображений
      if (isImage(filename)) {
        items.push({ action: 'regeneratePdf', title: 'Re-process PDF' });
      }
      
      // Delete
      items.push({ action: 'delete', title: 'Delete' });
      
      return items;
    };

    const handleMenuAction = (action, doc) => {
      switch (action) {
        case 'editTags':
          editTags(doc);
          break;
        case 'addPages':
          triggerAddPages(doc.id);
          break;
        case 'editPages':
          openPagesView(doc);
          break;
        case 'regeneratePdf':
          regeneratePdf(doc);
          break;
        case 'delete':
          deleteDocument(doc);
          break;
      }
    };
    const fetchUsage = async () => {
      try { usage.value = await fetchUsageData(); }
      catch { usage.value = null; }
    };

    // Pages view (multi-page document) — composable wired below after viewers.

    const normalizedTagQuery = computed(() => normalizeTag(tagQuery.value));
    const cloudTags = computed(() => {
      if (activeTag.value) return relatedTags.value;
      const q = normalizedTagQuery.value;
      if (!q) return topTags.value;
      return (allTags.value.length ? allTags.value : topTags.value)
        .filter((t) => normalizeTag(t?.tag || "").includes(q)).slice(0, 50);
    });

    // PDF processing modal (composable)
    const {
      pdfModalOpen, pdfModalProcessing, pdfModalPages, pdfModalPageIdx,
      pdfModalBrightness, pdfModalContrast, pdfModalSharpness,
      pdfModalSizeKb, pdfModalCanvas, pdfModalPreview, pdfModalCurrentPage,
      pdfModalOnSlider, pdfModalConfirm, pdfModalCancel,
      pdfZoom, pdfCanvasStyle, pdfZoomIn, pdfZoomOut, pdfZoomReset, onPdfPreviewWheel,
      onPdfDragStart, onPdfDragMove, onPdfDragEnd,
      openPdfModal,
    } = usePdfModal({
      decodeImageFile, autoProcessImageData, applySliderDeltas, autoPickQuality,
    });

    // Tags modal (composable)
    const {
      tagModalOpen, tagModalTitle, tagModalInput,
      openTagsModal, closeTagsModal,
    } = useTagsModal();

    // downloadBlob — needed by viewer composables (defined early)
    const downloadBlob = async (url, filename) => {
      try {
        const resp = await apiFetch(url);
        const blob = await resp.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl; a.download = filename || "download";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
      } catch (e) { console.error(e); }
    };

    // Image viewer (composable)
    const {
      viewerOpen, viewerUrl, viewerName, viewerStage, viewerImg, viewerImgStyle,
      viewerPages, viewerPageIndex, viewerScale,
      onViewerImgLoad, onViewerPointerDown, onViewerPointerMove, onViewerPointerUp,
      viewerPrev, viewerNext, closeViewer, viewerZoomIn, viewerZoomOut, viewerZoomReset,
      downloadCurrentImage, openViewer, onViewerKeydown,
      lockBodyScroll, unlockBodyScroll,
    } = useImageViewer({ downloadBlob });

    // PDF viewer (composable) — shares body scroll lock with image viewer
    const {
      pdfViewerOpen, pdfViewerName, pdfViewerLoading, pdfViewerError,
      pdfViewerPageCount, pdfViewerScale, pdfViewerScroll, pdfViewerSetCanvas,
      openPdfViewer, closePdfViewer,
      pdfViewerZoomIn, pdfViewerZoomOut, pdfViewerZoomReset,
      downloadCurrentPdf,
      onPdfViewerPointerDown, onPdfViewerPointerMove, onPdfViewerPointerUp,
      onPdfViewerKeydown,
    } = usePdfViewer({
      apiFetch,
      lockBodyScroll,
      unlockBodyScroll,
      downloadBlob,
    });

    // Pages view (composable)
    const {
      pagesViewOpen, pagesViewTitle, pagesViewList, pagesViewDocId,
      refreshPagesView, rebuildPdfForDoc, deletePage, movePageUp, movePageDown,
      openPagesView, closePagesView, openViewerFromPages,
    } = usePagesView({
      apiFetch,
      uploading,
      refreshAll,
      addJpegBlobToPdf,
      generatePdfThumbBlob,
      openViewer,
      openPdfViewer,
      downloadBlob,
      isImage,
      isPdf,
    });

    // Data fetching
    const fetchTopTags = async () => {
      try { topTags.value = await fetchTopTagsData(); }
      catch { topTags.value = []; }
    };
    const fetchAllTags = async () => {
      try { allTags.value = await fetchAllTagsData(); }
      catch { allTags.value = []; }
    };
    const fetchRelatedTags = async (tag) => {
      const n = normalizeTag(tag);
      if (!n) { relatedTags.value = []; return; }
      try { relatedTags.value = await fetchRelatedTagsData(tag); }
      catch { relatedTags.value = []; }
    };

    const fetchDocuments = async () => {
      loading.value = true;
      try {
        documents.value = await fetchDocumentsData(activeTag.value);
      } catch (e) { console.error(e); }
      finally { loading.value = false; }
    };

    const refreshAll = async () => {
      if (activeTag.value) {
        await Promise.all([fetchDocuments(), fetchRelatedTags(activeTag.value), fetchAllTags()]);
        return;
      }
      documents.value = [];
      await Promise.all([fetchTopTags(), fetchAllTags()]);
    };

    const setActiveTag = async (tag) => {
      activeTag.value = normalizeTag(tag); tagQuery.value = "";
      await Promise.all([fetchDocuments(), fetchRelatedTags(activeTag.value)]);
    };
    const clearActiveTag = async () => {
      activeTag.value = ""; tagQuery.value = ""; relatedTags.value = [];
      documents.value = [];
      await Promise.all([fetchTopTags(), fetchAllTags()]);
    };

    // Pages view (composable) — wired after refreshAll so the callback is initialized.
    const {
      pagesViewOpen, pagesViewTitle, pagesViewList, pagesViewDocId,
      refreshPagesView, rebuildPdfForDoc, deletePage, movePageUp, movePageDown,
      openPagesView, closePagesView, openViewerFromPages,
    } = usePagesView({
      apiFetch,
      uploading,
      refreshAll,
      addJpegBlobToPdf,
      generatePdfThumbBlob,
      openViewer,
      openPdfViewer,
      downloadBlob,
      isImage,
      isPdf,
    });

    // ── Upload / process ──

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

    // Document actions
    const viewDocument = async (doc) => {
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

    const editTags = async (doc) => {
      const initial = Array.isArray(doc.tags) ? doc.tags.join(" ") : "";
      const result = await openTagsModal({ title: "Edit tags", initialValue: initial });
      if (result === null) return;
      try {
        await editTagsApi(doc.id, result);
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

    onMounted(async () => {
      try {
        const r = await fetch("/api/auth/check");
        if (!r.ok) { window.location.href = "/"; return; }
      } catch { window.location.href = "/"; return; }
      fetchTopTags();
      fetchAllTags();
      fetchUsage();
      window.addEventListener("keydown", onViewerKeydown);
      window.addEventListener("keydown", onPdfViewerKeydown);
    });

    return {
      documents, loading, uploading, uploadProgress, uploadError,
      activeTag, tagQuery, topTags, relatedTags, cloudTags,
      tagModalOpen, tagModalTitle, tagModalInput,
      viewerOpen, viewerUrl, viewerName, viewerStage, viewerImg, viewerImgStyle,
      viewerPages, viewerPageIndex, viewerScale,
      onViewerImgLoad, onViewerPointerDown, onViewerPointerMove, onViewerPointerUp,
      viewerPrev, viewerNext, closeViewer, viewerZoomIn, viewerZoomOut, viewerZoomReset,
      downloadCurrentImage,
      pdfViewerOpen, pdfViewerName, pdfViewerLoading, pdfViewerError,
      pdfViewerPageCount, pdfViewerScale, pdfViewerSetCanvas, pdfViewerScroll,
      openPdfViewer, closePdfViewer, pdfViewerZoomIn, pdfViewerZoomOut, pdfViewerZoomReset,
      downloadCurrentPdf,
      onPdfViewerPointerDown, onPdfViewerPointerMove, onPdfViewerPointerUp,
      onPdfViewerKeydown,
      pagesViewOpen, pagesViewTitle, pagesViewList, pagesViewDocId, closePagesView, openViewerFromPages, openPagesView, deletePage, movePageUp, movePageDown,
      menuKey, tagToColors, refreshAll, setActiveTag, clearActiveTag,
      handleFileUpload, deleteDocument, isImage, isPdf, viewDocument,
      getExt, getExtIcon, closeTagsModal, editTags, downloadPage, logout,
      getMenuItems, handleMenuAction,
      isDragOver, onDragOver, onDragEnter, onDragLeave, onDrop,
      triggerAddPages, handleAddPagesInput,
      usage, workersPct, storagePct, formatNum, formatBytes,
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
