import { ref } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";

// Pages view: list of pages for a multi-page document, with reorder/delete
// operations and PDF rebuild after structural changes.
//
// Dependencies (passed in):
//   apiFetch            — authorized fetch wrapper
//   uploading           — shared ref<boolean> for global upload indicator
//   refreshAll          — top-level refresh callback (documents + tags)
//   addJpegBlobToPdf    — appends a JPEG blob to a jsPDF instance
//   generatePdfThumbBlob — produces a thumbnail blob from a PDF file
//   openViewer          — image viewer opener (url, name, urls, index)
//   openPdfViewer       — PDF viewer opener (url, name)
//   downloadBlob        — downloads a blob by URL
//   isImage, isPdf      — file-type predicates
export function usePagesView({
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
}) {
  const pagesViewOpen = ref(false);
  const pagesViewTitle = ref("");
  const pagesViewList = ref([]);
  const pagesViewDocId = ref(null);

  const mapPages = (pages) => (pages || []).map((p) => ({
    ...p,
    thumb_url: p.thumb_key
      ? "/api/objects/thumb-download-url?thumb_key=" + encodeURIComponent(p.thumb_key)
      : null,
  }));

  const refreshPagesView = async () => {
    if (!pagesViewOpen.value || !pagesViewDocId.value) return;
    try {
      const resp = await apiFetch("/api/documents/" + encodeURIComponent(pagesViewDocId.value) + "/pages").then((r) => r.json());
      pagesViewList.value = mapPages(resp.pages);
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
      pagesViewList.value = mapPages(resp.pages);
      pagesViewTitle.value = doc.title || "Document";
      pagesViewDocId.value = doc.id;
      pagesViewOpen.value = true;
    } catch (e) { console.error(e); }
  };

  const closePagesView = () => {
    pagesViewOpen.value = false;
    pagesViewList.value = [];
    pagesViewTitle.value = "";
    pagesViewDocId.value = null;
  };

  const openViewerFromPages = async (pageIndex) => {
    const page = pagesViewList.value[pageIndex];
    if (!page) return;
    const name = page.filename || page.key || "";
    const urls = pagesViewList.value.map((p) =>
      "/api/objects/download-url?key=" + encodeURIComponent(p.key)
    );
    if (isImage(name)) {
      openViewer(urls[pageIndex], name, urls, pageIndex);
    } else if (isPdf(name)) {
      await openPdfViewer(urls[pageIndex], name);
    } else {
      await downloadBlob(urls[pageIndex], name);
    }
  };

  return {
    pagesViewOpen, pagesViewTitle, pagesViewList, pagesViewDocId,
    refreshPagesView, rebuildPdfForDoc, deletePage, movePageUp, movePageDown,
    openPagesView, closePagesView, openViewerFromPages,
  };
}
