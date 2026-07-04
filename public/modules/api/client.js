// ── API client helpers ──

const API_BASE = "";

// Wrapper around fetch that redirects to "/" on 401 (Unauthorized).
export const apiFetch = (url, opts) => {
  return fetch(API_BASE + url, opts).then((r) => {
    if (r.status === 401) { window.location.href = "/"; throw new Error("Unauthorized"); }
    return r;
  });
};

export const logout = () => {
  fetch("/api/logout", { method: "POST" }).finally(() => { window.location.href = "/"; });
};

// Download a blob by URL through the authorized fetch wrapper.
export const downloadBlob = async (url, filename) => {
  try {
    const resp = await apiFetch(url);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl; a.download = filename || "download";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  } catch (e) { console.error(e); }
};
