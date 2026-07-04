// ── Image processing ──

export const decodeImageFile = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("read error"));
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => reject(new Error("decode error"));
    img.onload = () => resolve(img);
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// Apply grayscale + auto-normalize + auto-brightness to ImageData in-place.
// Returns { brightnessAuto, contrastAuto, sharpnessAuto } — computed values for sliders.
export const autoProcessImageData = (data) => {
  const d = data.data;
  const len = d.length;

  // Step 1: grayscale (luminance)
  for (let i = 0; i < len; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = g;
  }

  // Step 2: find min/max for normalize
  let min = 255, max = 0, sum = 0, count = len / 4;
  for (let i = 0; i < len; i += 4) {
    const v = d[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / count;
  const range = max - min || 1;

  // Step 3: normalize (stretch histogram to 0–255)
  for (let i = 0; i < len; i += 4) {
    const v = Math.round(((d[i] - min) / range) * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
  }

  // Step 4: auto-brightness correction — only brighten, never darken documents.
  // Target mean 170 (documents are mostly white/light — keep them bright).
  const targetMean = 170;
  let newSum = 0;
  for (let i = 0; i < len; i += 4) newSum += d[i];
  const newMean = newSum / count;
  // Apply only if image is darker than target (don't dim already-bright scans)
  const brightnessDelta = newMean < targetMean ? Math.round(targetMean - newMean) : 0;
  if (brightnessDelta > 0) {
    for (let i = 0; i < len; i += 4) {
      const v = Math.max(0, Math.min(255, d[i] + brightnessDelta));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }

  return {
    brightnessAuto: brightnessDelta,
    contrastAuto: 0,
    sharpnessAuto: 30,
  };
};

// Apply user slider deltas on top of already-processed ImageData (copy → apply → putImageData).
// processedData is the auto-processed base; brightness/contrast/sharpness are user deltas.
export const applySliderDeltas = (ctx, baseImageData, width, height, brightness, contrast, sharpness) => {
  const src = new Uint8ClampedArray(baseImageData.data);
  const out = new ImageData(new Uint8ClampedArray(src), width, height);
  const d = out.data;
  const len = d.length;

  // Brightness delta
  if (brightness !== 0) {
    for (let i = 0; i < len; i += 4) {
      const v = Math.max(0, Math.min(255, d[i] + brightness));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }

  // Contrast factor: factor = (259 * (contrast + 255)) / (255 * (259 - contrast))
  if (contrast !== 0) {
    const f = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (let i = 0; i < len; i += 4) {
      const v = Math.max(0, Math.min(255, Math.round(f * (d[i] - 128) + 128)));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }

  // Unsharp mask (simple 3x3 blur → subtract)
  if (sharpness > 0) {
    const amount = sharpness / 100;
    const blurred = new Uint8ClampedArray(len);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              s += d[(ny * width + nx) * 4]; c++;
            }
          }
        }
        blurred[(y * width + x) * 4] = Math.round(s / c);
      }
    }
    for (let i = 0; i < len; i += 4) {
      const sharpened = Math.max(0, Math.min(255, Math.round(d[i] + amount * (d[i] - blurred[i]))));
      d[i] = d[i + 1] = d[i + 2] = sharpened;
    }
  }

  ctx.putImageData(out, 0, 0);
  return out;
};

// Auto-pick JPEG quality to target ≤ 500KB (max 1MB).
// Returns { blob, quality, oversized }.
export const autoPickQuality = (canvas) => new Promise((resolve) => {
  const tryQ = (qualities, idx) => {
    if (idx >= qualities.length) {
      canvas.toBlob((b) => resolve({ blob: b, quality: qualities[qualities.length - 1], oversized: true }), "image/jpeg", qualities[qualities.length - 1]);
      return;
    }
    const q = qualities[idx];
    canvas.toBlob((b) => {
      if (!b) { resolve({ blob: b, quality: q, oversized: false }); return; }
      if (b.size <= 512 * 1024 || idx === qualities.length - 1) {
        resolve({ blob: b, quality: q, oversized: b.size > 1024 * 1024 });
      } else if (b.size > 1024 * 1024) {
        tryQ(qualities, idx + 1);
      } else {
        tryQ(qualities, idx + 1);
      }
    }, "image/jpeg", q);
  };
  tryQ([0.85, 0.80, 0.72, 0.60], 0);
});
