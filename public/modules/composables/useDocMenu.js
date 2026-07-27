// ── useDocMenu: document context menu ──
//
// Builds the per-document menu items based on file type and dispatches
// the selected action to the appropriate composable handler.
//
// Dependencies passed in:
//   isImage, isPdf           — file-type predicates
//   editTags                 — (doc) => void
//   openPagesView            — (doc) => void
//   regeneratePdf            — (doc) => void
//   deleteDocument           — (doc) => void

import { ref } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";

export const useDocMenu = ({
  isImage,
  isPdf,
  editTags,
  openPagesView,
  regeneratePdf,
  deleteDocument,
}) => {
  const menuKey = ref(null);
  const commentModalOpen = ref(false);
  const commentModalText = ref("");

  const getMenuItems = (doc) => {
    const items = [];
    const filename = doc.title || doc.id;

    items.push({ action: 'editTags', title: 'Tags' });

    if (!isImage(filename) && !isPdf(filename)) {
      if (doc.comment) items.push({ action: 'viewComment', title: 'Comment' });
      items.push({ action: 'delete', title: 'Delete' });
      return items;
    }

    if (doc.comment) items.push({ action: 'viewComment', title: 'Comment' });
    items.push({ action: 'editPages', title: 'Edit pages' });

    if (isImage(filename)) {
      items.push({ action: 'regeneratePdf', title: 'Re-process PDF' });
    }

    items.push({ action: 'delete', title: 'Delete' });
    return items;
  };

  const handleMenuAction = (action, doc) => {
    switch (action) {
      case 'editTags':       editTags(doc); break;
      case 'viewComment':    commentModalText.value = doc.comment || ""; commentModalOpen.value = true; break;
      case 'editPages':      openPagesView(doc); break;
      case 'regeneratePdf':  regeneratePdf(doc); break;
      case 'delete':         deleteDocument(doc); break;
    }
  };

  const closeCommentModal = () => { commentModalOpen.value = false; commentModalText.value = ""; };

  return { menuKey, getMenuItems, handleMenuAction, commentModalOpen, commentModalText, closeCommentModal };
};
