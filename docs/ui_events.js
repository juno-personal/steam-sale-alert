// 이벤트 바인딩 + 필터/렌더링 상호작용.

import { state } from "./state.js";
import { el } from "./elements.js";
import { RANGES } from "./config.js";
import { readFilters, saveFilters } from "./storage.js";
import { render, renderReset } from "./rendering.js";
import { setRangeState, paintRange, fullRange, sliderMax, toReal, snapValue } from "./range.js";
import { updateLabels } from "./ui_labels.js";

/**
 * 네이티브 range input 의 프로그램적 값 변경을 실제 범위 상태로 반영한다.
 * 슬라이더 값(0~sliderMax) → 백분율 → 실제 값 → 스냅 순으로 변환한다.
 */
function setRange(key) {
  const span = sliderMax(key);
  const loPct = (Number(el[key + "Min"].value) / span) * 100;
  const hiPct = (Number(el[key + "Max"].value) / span) * 100;
  setRangeState(
    key,
    snapValue(key, toReal(key, loPct)),
    snapValue(key, toReal(key, hiPct))
  );
}

/** 입력/정렬/필터 관련 전역 이벤트 바인딩 */
export function bind() {
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      updateLabels();
      saveFilters();
      renderReset();
    }, 140);
  };

  // q 입력 시 160ms 디바운스
  el.q.addEventListener("input", () => { schedule(); });
  el.q.addEventListener("change", () => {
    updateLabels();
    saveFilters();
    renderReset();
  });

  // 정렬 버튼
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.sort;
      el.sort.value = v;
      document.querySelectorAll(".sort-btn").forEach((b) => b.classList.toggle("active", b === btn));
      updateLabels();
      saveFilters();
      renderReset();
    });
  });

  // range input (프로그램적 값 변경 시 반응)
  Object.keys(RANGES).forEach((key) => {
    ["Min", "Max"].forEach((side) => {
      const el_ = el[key + side];
      el_.addEventListener("input", () => {
        setRange(key);
        updateLabels();
        schedule();
      });
    });
  });

  el.hideSeen.addEventListener("change", () => {
    saveFilters();
    renderReset();
  });

  // 이미지 로드 실패 시 폴백 타일로 교체
  el.grid.addEventListener("error", (e) => {
    const img = e.target;
    if (!img || img.tagName !== "IMG" || !img.classList.contains("thumb")) return;
    const box = document.createElement("div");
    box.className = "thumb-fallback";
    box.textContent = img.getAttribute("data-initial") || "?";
    if (img.parentNode) img.parentNode.replaceChild(box, img);
  }, true);

  // 필터 초기화
  el.reset.addEventListener("click", () => {
    try { localStorage.removeItem("ssa.filters.v1"); } catch (e) { /* noop */ }
    el.q.value = "";
    el.sort.value = "reviews-desc";
    document.querySelectorAll(".sort-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.sort === "reviews-desc");
    });
    Object.keys(RANGES).forEach((key) => {
      const full = fullRange(key);
      setRangeState(key, full.lo, full.hi);
    });
    el.hideSeen.checked = false;
    updateLabels();
    renderReset();
  });

  // 더 보기
  el.more.addEventListener("click", () => { render(false); });

  // 필터 접기 토글은 제거됨 (항상 펼침)
  if (el.filterToggle) {
    el.filterToggle.addEventListener("click", () => {
      const open = el.filters.classList.toggle("open");
      el.filterToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  // 무한 스크롤 (IntersectionObserver + fallback scroll)
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !el.more.hidden) render(false);
    }, { rootMargin: "600px" }).observe(el.sentinel);
  } else {
    el.more.hidden = false;
  }

  window.addEventListener("scroll", () => {
    if (el.more.hidden) return;
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 1200) {
      render(false);
    }
  }, { passive: true });
}

/** 범위 필터 상태 갱신 (범위 슬라이더 이동 예상 지연 처리) */
let timer = null;

/** 설치 안내 */
export function setupInstall() {
  // 설치 안내 배너는 표시하지 않는다.
  return;
  const standalone = window.matchMedia("(display-mode: standalone)").matches ||
                     window.navigator.standalone === true;
  if (standalone || localStorage.getItem("ssa.install.dismissed")) return;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  let deferred = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
  });

  setTimeout(() => {
    if (deferred) {
      show("홈 화면에 설치하면 앱처럼 실행됩니다.", "설치", () => {
        deferred.prompt();
        deferred.userChoice.then(() => hide());
      });
      return;
    }
    if (isIOS) {
      show(
        "크롬 메뉴 <b>더보기</b> → <b>홈 화면에 추가</b> 로 설치할 수 있습니다.",
        "알림",
        () => {
          localStorage.setItem("ssa.install.dismissed", "1");
          hide();
        }
      );
    }
  }, 2500);

  function show(html, label, onClick) {
    const bar = document.createElement("div");
    bar.className = "install show";
    bar.innerHTML = '<div class="install-text">' + html + '</div>' +
      '<button type="button">' + label + "</button>" +
      '<button type="button" class="dismiss" aria-label="닫기">&times;</button>';
    const btns = bar.querySelectorAll("button");
    btns[0].addEventListener("click", onClick);
    btns[1].addEventListener("click", () => {
      localStorage.setItem("ssa.install.dismissed", "1");
      hide();
    });
    document.body.appendChild(bar);

    function hide() {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }
  }
}

/** 서비스 워커 등록 */
export function setupSW() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return;
  // updateViaCache: "none" — 매 방문마다 변경 여부 확인 (갱신 실패 방지)
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
}
