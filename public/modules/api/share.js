// ── Share links API ──

import { apiFetch } from "./client.js";

export const createShareLink = async ({ key, filename }) => {
  const d = await apiFetch("/api/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, filename }),
  }).then((r) => r.json());
  return d;
};

export const clearShareTokens = async () => {
  await apiFetch("/api/share", { method: "DELETE" });
};
