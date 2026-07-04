import { createApp, ref, computed, onMounted } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import { normalizeTag, parseTagsInput, tagToColors } from "./modules/utils/tags.js";
import { getExt, getExtIcon, isImage, isPdf } from "./modules/utils/files.js";
import { formatNum, formatBytes, formatCompact } from "./modules/utils/format.js";
import { decodeImageFile, autoProcessImageData, applySliderDeltas, autoPickQuality } from "./modules/image/process.js";
import { generateImageThumbBlob, generatePdfThumbBlob } from "./modules/image/thumb.js";
import { renderPageBlob, addJpegBlobToPdf, renderPdfBlob } from "./modules/pdf/build.js";
import { apiFetch, logout, downloadBlob } from "./modules/api/client.js";
import { fetchUsage as fetchUsageData } from "./modules/api/usage.js";
import {
  fetchTopTags as fetchTopTagsData,
  fetchAllTags as fetchAllTagsData,
  fetchRelatedTags as fetchRelatedTagsData,
  fetchDocuments as fetchDocumentsData,
  deleteDocument as deleteDocumentApi,
  editTags as editTagsApi,
} from "./modules/api/documents.js";
import { useUsage } from "./modules/composables/useUsage.js";
import { useImageViewer } from "./modules/composables/useImageViewer.js";
import { usePdfViewer } from "./modules/composables/usePdfViewer.js";
import { usePdfModal } from "./modules/composables/usePdfModal.js";
import { useTagsModal } from "./modules/composables/useTagsModal.js";
import { usePagesView } from "./modules/composables/usePagesView.js";
import { useUpload } from "./modules/composables/useUpload.js";
import { useDocuments } from "./modules/composables/useDocuments.js";
import { useDocMenu } from "./modules/composables/useDocMenu.js";

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

createApp({
  setup() {
    // Shared state bridging composables with circular deps (composition root's job)
    const uploading = ref(false);
    const uploadProgress = ref(0);
    const uploadError = ref("");
    const pagesViewOpen = ref(false);
    const pagesViewTitle = ref("");
    const pagesViewList = ref([]);
    const pagesViewDocId = ref(null);
    const deployedAt = ref("");
    const deployedAtLabel = computed(() =>
      deployedAt.value
        ? new Date(deployedAt.value).toLocaleString()
        : "",
    );

    const usage = useUsage({ fetchUsageData });
    const pdfModal = usePdfModal({ decodeImageFile, autoProcessImageData, applySliderDeltas, autoPickQuality });
    const tagsModal = useTagsModal();
    const imageViewer = useImageViewer({ downloadBlob });
    const pdfViewer = usePdfViewer({
      apiFetch,
      lockBodyScroll: imageViewer.lockBodyScroll,
      unlockBodyScroll: imageViewer.unlockBodyScroll,
      downloadBlob,
    });
    const documents = useDocuments({
      apiFetch,
      fetchDocumentsData, fetchTopTagsData, fetchAllTagsData, fetchRelatedTagsData,
      deleteDocumentApi, editTagsApi,
      normalizeTag, parseTagsInput,
      uploading, uploadProgress, uploadError,
      decodeImageFile, renderPageBlob, renderPdfBlob,
      generateImageThumbBlob, generatePdfThumbBlob,
      openPdfModal: pdfModal.openPdfModal,
      openTagsModal: tagsModal.openTagsModal,
      pdfModalPages: pdfModal.pdfModalPages,
      pdfModalBrightness: pdfModal.pdfModalBrightness,
      pdfModalContrast: pdfModal.pdfModalContrast,
      pdfModalSharpness: pdfModal.pdfModalSharpness,
      openViewer: imageViewer.openViewer,
      openPdfViewer: pdfViewer.openPdfViewer,
      downloadBlob,
      pagesViewOpen, pagesViewList, pagesViewTitle, pagesViewDocId,
      isImage, isPdf,
    });
    const pagesView = usePagesView({
      apiFetch,
      uploading,
      refreshAll: documents.refreshAll,
      addJpegBlobToPdf,
      generatePdfThumbBlob,
      openViewer: imageViewer.openViewer,
      openPdfViewer: pdfViewer.openPdfViewer,
      downloadBlob,
      isImage, isPdf,
      pagesViewOpen, pagesViewTitle, pagesViewList, pagesViewDocId,
    });
    const upload = useUpload({
      apiFetch,
      uploading, uploadProgress, uploadError,
      refreshAll: documents.refreshAll,
      refreshPagesView: pagesView.refreshPagesView,
      renderPageBlob, renderPdfBlob, addJpegBlobToPdf,
      generateImageThumbBlob, generatePdfThumbBlob,
      openPdfModal: pdfModal.openPdfModal,
      openTagsModal: tagsModal.openTagsModal,
      pdfModalPages: pdfModal.pdfModalPages,
      parseTagsInput,
      isImage, isPdf,
    });
    const docMenu = useDocMenu({
      isImage, isPdf,
      editTags: documents.editTags,
      triggerAddPages: upload.triggerAddPages,
      openPagesView: pagesView.openPagesView,
      regeneratePdf: documents.regeneratePdf,
      deleteDocument: documents.deleteDocument,
    });

    onMounted(async () => {
      try {
        const r = await fetch("/api/auth/check");
        if (!r.ok) { window.location.href = "/"; return; }
      } catch { window.location.href = "/"; return; }
      fetch("/deploy-info.json")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d && d.deployedAt) deployedAt.value = d.deployedAt; })
        .catch(() => {});
      documents.fetchTopTags();
      documents.fetchAllTags();
      usage.fetchUsage();
      window.addEventListener("keydown", imageViewer.onViewerKeydown);
      window.addEventListener("keydown", pdfViewer.onPdfViewerKeydown);
    });

    return {
      ...usage, ...pdfModal, ...tagsModal, ...imageViewer, ...pdfViewer,
      ...documents, ...pagesView, ...upload, ...docMenu,
      uploading, uploadProgress, uploadError,
      tagToColors, formatNum, formatBytes, formatCompact,
      getExt, getExtIcon, isImage, isPdf, logout,
      deployedAt, deployedAtLabel,
    };
  },
}).mount("#app");
