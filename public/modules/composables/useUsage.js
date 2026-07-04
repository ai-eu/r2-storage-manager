// ── useUsage: Cloudflare usage widget state ──
//
// Tracks Workers/R2 usage and exposes computed percentages for the
// usage bars in the sidebar.
//
// Dependencies passed in: { fetchUsageData } — async fn returning usage JSON.

import { ref, computed } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";

export const useUsage = ({ fetchUsageData }) => {
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

  const fetchUsage = async () => {
    try { usage.value = await fetchUsageData(); }
    catch { usage.value = null; }
  };

  return { usage, workersPct, storagePct, fetchUsage };
};
