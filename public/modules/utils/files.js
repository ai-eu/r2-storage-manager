export const getExt = (f) => {
  if (typeof f !== "string") return "";
  const b = f.split("/").pop() || f;
  const i = b.lastIndexOf(".");
  return i === -1 ? "" : b.slice(i + 1).toLowerCase();
};

export const getExtIcon = (ext) => {
  const m = { pdf:"PDF",doc:"DOC",docx:"DOCX",xls:"XLS",xlsx:"XLSX",ppt:"PPT",pptx:"PPTX",
    txt:"TXT",md:"MD",zip:"ZIP",rar:"RAR","7z":"7Z",mp3:"MP3",wav:"WAV",mp4:"MP4",mov:"MOV" };
  return m[ext] || (ext ? ext.toUpperCase() : "FILE");
};

export const isImage = (f) => /\.(jpg|jpeg|png|gif|webp)$/i.test(f);
export const isPdf = (f) => /\.pdf$/i.test(f);
