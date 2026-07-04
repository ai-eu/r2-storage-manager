// ── Documents / Tags API ──

import { apiFetch } from "./client.js";
import { normalizeTag, parseTagsInput } from "../utils/tags.js";

export const fetchTopTags = async () => {
  const d = await apiFetch("/api/tags/top?limit=10").then((r) => r.json());
  return d.tags || [];
};

export const fetchAllTags = async () => {
  const d = await apiFetch("/api/tags/all?limit=500").then((r) => r.json());
  return d.tags || [];
};

export const fetchRelatedTags = async (tag) => {
  const n = normalizeTag(tag);
  if (!n) return [];
  const d = await apiFetch("/api/tags/related?tag=" + encodeURIComponent(n) + "&limit=10").then((r) => r.json());
  return d.tags || [];
};

export const fetchDocuments = async (activeTag) => {
  const qs = activeTag ? "?tag=" + encodeURIComponent(activeTag) : "";
  const data = await apiFetch("/api/documents" + qs).then((r) => r.json());
  const docs = data.documents || [];
  return docs.map((d) => ({
    ...d,
    thumb_url: d.thumb_key
      ? "/api/objects/thumb-download-url?thumb_key=" + encodeURIComponent(d.thumb_key)
      : null,
  }));
};

export const deleteDocument = async (id) => {
  await apiFetch("/api/documents/" + encodeURIComponent(id), { method: "DELETE" });
};

export const editTags = async (id, tagsInput) => {
  await apiFetch("/api/documents/" + encodeURIComponent(id) + "/tags", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags: parseTagsInput(tagsInput) }),
  });
};
