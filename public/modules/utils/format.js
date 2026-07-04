export const formatNum = (n) => {
  if (typeof n !== "number") return "0";
  return n.toLocaleString("en-US");
};

export const formatBytes = (bytes) => {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
};
