// ── useShare: share links actions ──
//
// Dependencies passed in: { clearShareTokens }.

import { ref } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";

export const useShare = ({ clearShareTokens }) => {
  const shareClearing = ref(false);

  const clearShareTokensWithConfirm = async () => {
    if (!confirm("Delete all share links?")) return;
    shareClearing.value = true;
    try {
      await clearShareTokens();
    } catch (e) {
      console.error("clear share tokens failed", e);
    } finally {
      shareClearing.value = false;
    }
  };

  return {
    shareClearing,
    clearShareTokens: clearShareTokensWithConfirm,
  };
};
