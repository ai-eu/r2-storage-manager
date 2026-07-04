// ── useDocMenu: document context menu ──
//
// Builds the per-document menu items based on file type and dispatches
// the selected action to the appropriate composable handler.
//
// Dependencies passed in:
//   isImage, isPdf           — file-type predicates
//   editTags                 — (doc) => void
//   triggerAddPages          — (docId) => void
//   openPagesView            — (doc) => void
//   regeneratePdf            — (doc) => void
//   deleteDocument           — (doc) => void

import { ref } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";

export const useDocMenu = ({
  isImage,
  isPdf,
  editTags,
  triggerAddPages,
  openPagesView,
  regeneratePdf,
  deleteDocument,
}) => {
  const menuKey = ref(null);

  const getMenuItems = (doc) => {
    const items = [];
    const filename = doc.title || doc.id;

    items.push({ action: 'editTags', title: 'Tags' });

    if (!isImage(filename) && !isPdf(filename)) {
      items.push({ action: 'delete', title: 'Delete' });
      return items;
    }

    items.push({ action: 'addPages', title: 'Add pages' });
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
      case 'addPages':       triggerAddPages(doc.id); break;
      case 'editPages':      openPagesView(doc); break;
      case 'regeneratePdf':  regeneratePdf(doc); break;
      case 'delete':         deleteDocument(doc); break;
    }
  };

  return { menuKey, getMenuItems, handleMenuAction };
};
