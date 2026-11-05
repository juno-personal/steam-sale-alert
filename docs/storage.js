// localStorage 필터 상태 동기화.

import { state } from "./state.js";
import { el } from "./elements.js";
import { RANGES, LS_KEY } from "./config.js";
import { snapValue, setRangeState, fullRange } from "./range.js";

/** 필터 값 읽기 */
export function readFilters() {
  const f = {
    q: el.q.value.trim().toLowerCase(),
    sort: el.sort.value,
    hideSeen: el.hideSeen.checked,
    hideNoReview: el.hideNoReview.checked,
  };
  Object.keys(RANGES).forEach((key) => {
    const p = state.ranges[key] || fullRange(key);
    f[key + "Min"] = p.lo;
    f[key + "Max"] = p.hi;
  });
  return f;
}

/** 필터 값 저장 */
export function saveFilters() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(readFilters()));
  } catch (e) { /* noop */ }
}

/** localStorage 에서 필터 복원 */
export function loadFilters() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (!s) return;
    if (s.q) el.q.value = s.q;
    if (s.sort) {
      el.sort.value = s.sort;
      document.querySelectorAll(".sort-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.sort === s.sort);
      });
    }
    Object.keys(RANGES).forEach((key) => {
      const full = fullRange(key);
      const lo = typeof s[key + "Min"] === "number"
        ? snapValue(key, s[key + "Min"])
        : full.lo;
      const hi = typeof s[key + "Max"] === "number"
        ? snapValue(key, s[key + "Max"])
        : full.hi;
      setRangeState(key, lo, hi);
    });
    el.hideSeen.checked = !!s.hideSeen;
    el.hideNoReview.checked = !!s.hideNoReview;
  } catch (e) { /* noop */ }
}
