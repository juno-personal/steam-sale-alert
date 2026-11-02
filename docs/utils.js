// 공통 유틸.

/** HTML 이스케이프 */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

/** 숫자 축약 (1234 -> "1.2K", 1234567 -> "1.2M") */
export function compact(n) {
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return String(n);
}

/** Steam 스토어 URL */
export function storeUrl(id) {
  return "https://store.steampowered.com/app/" + id + "/";
}
