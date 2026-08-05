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

export const fetchRelatedTags = async (tags) => {
  const arr = Array.isArray(tags) ? tags.map(normalizeTag).filter(Boolean) : [];
  if (!arr.length) return [];
  const qs = "?tags=" + arr.map(encodeURIComponent).join(",") + "&limit=10";
  const d = await apiFetch("/api/tags/related" + qs).then((r) => r.json());
  return d.tags || [];
};

export const fetchDocuments = async (activeTags) => {
  const arr = Array.isArray(activeTags) ? activeTags.map(normalizeTag).filter(Boolean) : [];
  const qs = arr.length ? "?tags=" + arr.map(encodeURIComponent).join(",") : "";
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

export const editTags = async (id, tagsInput, comment) => {
  await apiFetch("/api/documents/" + encodeURIComponent(id) + "/tags", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags: parseTagsInput(tagsInput), comment: comment ?? "" }),
  });
};
