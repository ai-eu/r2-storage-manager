// ── Usage API ──

import { apiFetch } from "./client.js";

export const fetchUsage = async () => {
  const d = await apiFetch("/api/usage").then((r) => r.json());
  return d;
};
