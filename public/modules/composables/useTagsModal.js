// ── useTagsModal: tags input modal state + actions ──
//
// Promise-based modal: openTagsModal({ title, initialValue, initialComment })
// resolves with { tags, comment } or null (cancelled).

import { ref } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";

export const useTagsModal = () => {
  const tagModalOpen = ref(false);
  const tagModalTitle = ref("Tags");
  const tagModalInput = ref("");
  const tagModalComment = ref("");
  let tagModalResolve = null;

  const openTagsModal = ({ title, initialValue, initialComment }) => {
    tagModalTitle.value = title || "Tags";
    tagModalInput.value = initialValue || "";
    tagModalComment.value = initialComment || "";
    tagModalOpen.value = true;
    return new Promise((r) => { tagModalResolve = r; });
  };

  const closeTagsModal = (result) => {
    tagModalOpen.value = false;
    const r = tagModalResolve; tagModalResolve = null;
    if (r) r(result);
  };

  return {
    tagModalOpen, tagModalTitle, tagModalInput, tagModalComment,
    openTagsModal, closeTagsModal,
  };
};
