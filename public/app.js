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
import { useUpload } from "./modules/composables/useUpload.js";
import { useDocuments } from "./modules/composables/useDocuments.js";

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

createApp({
  setup() {
    const uploading = ref(false);
    const uploadProgress = ref(0);
    const uploadError = ref("");
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

    // Pages view state — shared between useDocuments and usePagesView
    const pagesViewOpen = ref(false);
    const pagesViewTitle = ref("");
    const pagesViewList = ref([]);
    const pagesViewDocId = ref(null);

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

    // Documents orchestration (composable) — provides refreshAll, viewDocument, etc.
    const {
      documents, loading, activeTag, tagQuery, topTags, relatedTags, allTags,
      cloudTags,
      fetchTopTags, fetchAllTags,
      refreshAll, setActiveTag, clearActiveTag,
      viewDocument, editTags, regeneratePdf, deleteDocument, downloadPage,
    } = useDocuments({
      apiFetch,
      fetchDocumentsData, fetchTopTagsData, fetchAllTagsData, fetchRelatedTagsData,
      deleteDocumentApi, editTagsApi,
      normalizeTag, parseTagsInput,
      uploading, uploadProgress, uploadError,
      decodeImageFile, renderPageBlob, renderPdfBlob,
      generateImageThumbBlob, generatePdfThumbBlob,
      openPdfModal, openTagsModal,
      pdfModalPages, pdfModalBrightness, pdfModalContrast, pdfModalSharpness,
      openViewer, openPdfViewer, downloadBlob,
      pagesViewOpen, pagesViewList, pagesViewTitle, pagesViewDocId,
      isImage, isPdf,
    });

    // Pages view (composable) — wired after useDocuments so refreshAll is available.
    const {
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
      pagesViewOpen,
      pagesViewTitle,
      pagesViewList,
      pagesViewDocId,
    });

    // ── Upload / process (composable) ──
    const {
      isDragOver,
      uploadFiles, handleFileUpload,
      triggerAddPages, handleAddPagesInput,
      onDragOver, onDragEnter, onDragLeave, onDrop,
      processAndUploadPages,
    } = useUpload({
      apiFetch,
      uploading, uploadProgress, uploadError,
      refreshAll, refreshPagesView,
      renderPageBlob, renderPdfBlob, addJpegBlobToPdf,
      generateImageThumbBlob, generatePdfThumbBlob,
      openPdfModal, openTagsModal,
      pdfModalPages,
      parseTagsInput,
      isImage, isPdf,
    });

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
