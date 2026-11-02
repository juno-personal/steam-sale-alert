// 포맷 유틸 (state 에 의존)

import { state } from "./state.js";

/** 금액에 통화 표시 (예: 30,000 원). state.data 가 없으면 통화 없이 반환 */
export function money(v) {
  const s = Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  return state.data && state.data.currency ? s + " " + state.data.currency : s;
}

/** 게임 이미지 URL (state.data.imgPrefix 기반) */
export function imgUrl(g) {
  if (!g.g) return null;
  return (state.data.imgPrefix || "") + g.i + "/" + g.g;
}
