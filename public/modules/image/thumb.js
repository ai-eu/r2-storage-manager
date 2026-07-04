export const generateImageThumbBlob = async (file) => {
  if (!(file instanceof File)) return null;
  const img = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error("read"));
    r.onload = () => {
      const i = new Image();
      i.onerror = () => rej(new Error("dec"));
      i.onload = () => res(i);
      i.src = r.result;
    };
    r.readAsDataURL(file);
  });
  const tw = 240, th = 320;
  const canvas = document.createElement("canvas");
  canvas.width = tw; canvas.height = th;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  const sc = Math.max(tw / img.width, th / img.height);
  ctx.drawImage(img, (tw - img.width * sc) / 2, (th - img.height * sc) / 2, img.width * sc, img.height * sc);
  const blob = await new Promise((r) => {
    try { canvas.toBlob((b) => r(b), "image/jpeg", 0.7); } catch { r(null); }
  });
  if (blob instanceof Blob && blob.size > 0) return { blob, ext: "jpg" };
  const webp = await new Promise((r) => {
    try { canvas.toBlob((b) => r(b), "image/webp", 0.75); } catch { r(null); }
  });
  if (webp instanceof Blob && webp.size > 0) return { blob: webp, ext: "webp" };
  return null;
};

export const generatePdfThumbBlob = async (file) => {
  if (typeof pdfjsLib === "undefined") return null;
  if (!(file instanceof File) && !(file instanceof Blob)) return null;
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const tw = 240, th = 320;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(tw / baseViewport.width, th / baseViewport.height);
    const viewport = page.getViewport({ scale });
    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = Math.ceil(viewport.width);
    tmpCanvas.height = Math.ceil(viewport.height);
    const tmpCtx = tmpCanvas.getContext("2d", { alpha: false });
    if (!tmpCtx) return null;
    tmpCtx.fillStyle = "#fff";
    tmpCtx.fillRect(0, 0, tmpCanvas.width, tmpCanvas.height);
    await page.render({ canvasContext: tmpCtx, viewport }).promise;
    const canvas = document.createElement("canvas");
    canvas.width = tw; canvas.height = th;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, tw, th);
    const offsetX = (tw - viewport.width) / 2;
    const offsetY = (th - viewport.height) / 2;
    ctx.drawImage(tmpCanvas, offsetX, offsetY);
    const blob = await new Promise((r) => {
      try { canvas.toBlob((b) => r(b), "image/jpeg", 0.7); } catch { r(null); }
    });
    if (blob instanceof Blob && blob.size > 0) return { blob, ext: "jpg" };
    return null;
  } catch (e) { console.error("pdf thumb failed:", e); return null; }
};
