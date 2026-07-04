export const normalizeTag = (t) => (typeof t === "string" ? t.trim().toLowerCase() : "");

export const normalizeTags = (tags) => {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(normalizeTag).filter(Boolean))];
};

export const parseTagsInput = (input) => {
  if (typeof input !== "string") return [];
  return normalizeTags(input.split(/[,\s]+/g).map((s) => s.trim()).filter(Boolean));
};

export const hashTag = (tag) => {
  const s = normalizeTag(tag);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i));
  return h >>> 0;
};

export const tagToColors = (tag) => {
  const p = [
    {bg:"#2D6A4F",fg:"#FFF"},{bg:"#1D3557",fg:"#FFF"},{bg:"#6D597A",fg:"#FFF"},
    {bg:"#9C6644",fg:"#FFF"},{bg:"#0077B6",fg:"#FFF"},{bg:"#E07A5F",fg:"#FFF"},
    {bg:"#3D405B",fg:"#FFF"},{bg:"#2A9D8F",fg:"#FFF"},{bg:"#F4A261",fg:"#1B1B1B"},
    {bg:"#8D99AE",fg:"#1B1B1B"},
  ];
  return p[hashTag(tag) % p.length];
};
