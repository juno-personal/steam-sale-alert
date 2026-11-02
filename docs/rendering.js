// 카드 렌더링 + 페이징.

import { state } from "./state.js";
import { el } from "./elements.js";
import { apply } from "./filtering.js";
import { esc, compact, storeUrl, money } from "./utils.js";
import { imgUrl } from "./format.js";

/** 카드 한 장 HTML */
export function cardHtml(g) {
  const isNew = g.f >= state.dataDate;
  const initial = esc(g.n.slice(0, 1).toUpperCase());
  const url = imgUrl(g);

  const img = url
    ? '<img class="thumb" loading="lazy" decoding="async" src="' + esc(url) +
      '" alt="" data-initial="' + initial + '">'
    : '<div class="thumb-fallback">' + initial + "</div>";

  return (
    '<a class="card" href="' + esc(storeUrl(g.i)) + '" target="_blank" rel="noopener">' +
      img +
      '<div class="card-body">' +
        '<div class="card-top">' +
          '<span class="name">' + esc(g.n) + (isNew ? '<span class="badge-new">NEW</span>' : "") + '</span>' +
          '<span class="discount">-' + g.d + '%</span>' +
        '</div>' +
        '<div class="card-mid">' +
          '<span class="price">' + esc(money(g.s)) + '</span>' +
          '<span class="price-off">' + esc(money(g.o)) + '</span>' +
          '<span class="meta">' +
            '<span class="rating">★ ' + g.r + '%</span>' +
            '<span class="reviews">' + compact(g.c) + '</span>' +
          '</span>' +
        '</div>' +
      '</div>' +
    '</a>'
  );
}

/** 페이징 렌더링 ({@link renderReset} 과 동일하다) */
export function render(reset) {
  const list = apply();

  if (reset) {
    state.shown = 0;
    el.grid.innerHTML = "";
  }

  const end = Math.min(state.shown + 60, list.length);
  let html = "";
  for (let i = state.shown; i < end; i++) html += cardHtml(list[i]);
  el.grid.insertAdjacentHTML("beforeend", html);
  state.shown = end;

  el.count.innerHTML =
    "조건 <b>" + list.length.toLocaleString("ko-KR") + "</b>개" +
    (list.length ? " 중 <b>" + state.shown.toLocaleString("ko-KR") + "</b>개 표시" : "");
  el.countMini.textContent = list.length.toLocaleString("ko-KR") + "개";
  el.empty.hidden = list.length > 0;
  el.more.hidden = state.shown >= list.length;
  el.more.textContent = "더 보기 (" + (list.length - state.shown).toLocaleString("ko-KR") + "개 남음)";
}

/** 페이지 초기화로 {@link render} 호출 */
export function renderReset() {
  render(true);
}
