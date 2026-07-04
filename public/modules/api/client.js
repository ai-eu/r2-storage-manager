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
