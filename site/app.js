/* Steam Sale Alert - 앱 로직
 * games.json 스키마:
 *   { scrapedAt, currency, imgBase, imgFile,
 *     stats: { total, newToday, reviews10kPlus },
 *     games: [ { i, n, d, r, c, o, s, h, f } ] }
 *   i=appId  n=이름  d=할인율  r=조정평점  c=리뷰수
 *   o=기존가  s=할인가  h=이미지해시  f=최초발견일
 */
(function () {
  "use strict";

  var PAGE = 60;          // 한 번에 렌더링할 카드 수
  var LS_KEY = "ssa.filters.v1";

  var state = {
    data: null,
    list: [],
    shown: 0,
    dataDate: "",
    priceMax: 200,
    // key -> { lo, hi } 스냅이 적용된 실제 값.
    // input[type=range] 는 위치를 보여주는 거울일 뿐이다. 로그 스케일에서
    // 슬라이더 값은 정수여야 하므로 실제 값(30000)을 정수 위치로 되돌리면
    // 30306 이 되어 정지점을 잃는다.
    ranges: {},
  };

  var el = {};
  ["stats", "stamp", "q", "sort", "hideSeen", "reset", "count", "grid",
   "sentinel", "empty", "more", "footSub", "filters", "filterToggle",
   "filterSummary", "countMini",
   "priceOut", "discountOut", "ratingOut", "reviewsOut",
   "priceFill", "discountFill", "ratingFill", "reviewsFill",
   "priceMin", "priceMax", "discountMin", "discountMax",
   "ratingMin", "ratingMax", "reviewsMin", "reviewsMax"].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  /* ---------- 유틸 ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function compact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  function money(v) {
    var s = Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    return state.data && state.data.currency ? s + " " + state.data.currency : s;
  }

  function storeUrl(id) { return "https://store.steampowered.com/app/" + id + "/"; }

  function imgUrl(g) {
    if (!g.g) return null;
    return (state.data.imgPrefix || "") + g.i + "/" + g.g;
  }

  /* ---------- 범위형 필터 ----------
   * 숫자 필터는 최소/최대 쌍으로 관리한다.
   * 리뷰 수는 500 ~ 1,000,000 이라 선형 슬라이더로는 저역을 만질 수 없다.
   * 슬라이더 위치(0~100)를 로그 스케일로 실제 리뷰 수에 매핑한다.
   */
  var REVIEW_LO = 500;
  var REVIEW_HI = 1000000;
  var LOG_LO = Math.log(REVIEW_LO);
  var LOG_HI = Math.log(REVIEW_HI);

  // snap 은 썸이 붙는 단위다. 썸을 직접 구현하면서 input.step 은 무시되므로
  // 여기서 직접 맞춘다. 1% 단위로 움직여도 무의미하다.
  var REVIEW_STOPS = [500, 1000, 5000, 10000, 30000, 100000, 1000000];

  var RANGES = {
    price:    { lo: 0, hi: 0, linear: true, snap: 1 },
    discount: { lo: 0, hi: 95, linear: true, snap: 5 },
    rating:   { lo: 0, hi: 100, linear: true, snap: 5 },
    reviews:  { lo: REVIEW_LO, hi: REVIEW_HI, linear: false, stops: REVIEW_STOPS },
  };

  /** 실제 값을 붙는 단위로 맞춘다. */
  function snapValue(key, raw) {
    var r = RANGES[key];
    if (r.stops) {
      var best = r.stops[0];
      var bestD = Math.abs(best - raw);
      for (var i = 1; i < r.stops.length; i++) {
        var d = Math.abs(r.stops[i] - raw);
        if (d < bestD) { bestD = d; best = r.stops[i]; }
      }
      return best;
    }
    var step = r.snap || 1;
    return Math.max(0, Math.round(raw / step) * step);
  }

  function fullRange(key) {
    var r = RANGES[key];
    return { lo: r.lo, hi: r.hi };
  }

  /** 스냅된 실제 값으로 상태를 설정하고 화면을 갱신한다. */
  function setRangeState(key, lo, hi) {
    var r = RANGES[key];
    var nlo = Math.max(r.lo, Math.min(r.hi, lo));
    var nhi = Math.max(r.lo, Math.min(r.hi, hi));
    if (nlo > nhi) { var t = nlo; nlo = nhi; nhi = t; }
    state.ranges[key] = { lo: nlo, hi: nhi };
    paintRange(key);
  }

  /** 상태 -> 슬라이더 위치 / 채움 / 썸 좌표 */
  function paintRange(key) {
    var p = state.ranges[key];
    var loPct = toPct(key, p.lo);
    var hiPct = toPct(key, p.hi);

    el[key + "Min"].value = sliderOf(key, loPct);
    el[key + "Max"].value = sliderOf(key, hiPct);

    var fill = el[key + "Fill"];
    fill.style.left = loPct + "%";
    fill.style.width = Math.max(0, hiPct - loPct) + "%";

    var track = el[key + "Min"].parentElement;
    var lo = track.querySelector(".rng-thumb-lo");
    var hi = track.querySelector(".rng-thumb-hi");
    if (lo) lo.style.left = loPct + "%";
    if (hi) hi.style.left = hiPct + "%";
  }

  // 내부 교환은 모두 백분율(0~100)로 한다. 슬라이더 값(0~sliderMax)과
  // 실제 값 사이의 변환은 여기서만 한다.
  // 할인율은 0~95, 가격은 0~p98 처럼 스케일이 다르기 때문에
  // 슬라이더 값을 곧바로 백분율로 쓰면 안 된다.

  function sliderMax(key) { return RANGES[key].linear ? Math.max(1, RANGES[key].hi) : 100; }

  /** 백분율 0~100 → 슬라이더 값 (반올림) */
  function sliderOf(key, pct) {
    var span = sliderMax(key);
    return String(Math.max(0, Math.min(span, Math.round((pct / 100) * span))));
  }

  /** 백분율 → 실제 값 */
  function toReal(key, pct) {
    var r = RANGES[key];
    if (r.linear) return r.lo + ((r.hi - r.lo) * pct) / 100;
    return Math.exp(LOG_LO + ((LOG_HI - LOG_LO) * pct) / 100);
  }

  /** 실제 값 → 백분율 */
  function toPct(key, value) {
    var r = RANGES[key];
    if (r.linear) {
      var span = r.hi - r.lo;
      if (span <= 0) return 0;
      return Math.max(0, Math.min(100, ((value - r.lo) / span) * 100));
    }
    if (value <= r.lo) return 0;
    if (value >= r.hi) return 100;
    return Math.max(0, Math.min(100, ((Math.log(value) - LOG_LO) / (LOG_HI - LOG_LO)) * 100));
  }

  function setRange(key) {
    if (!state.ranges[key]) state.ranges[key] = fullRange(key);
    paintRange(key);
  }

  /**
   * 썸을 직접 만들어 포인터 이벤트를 처리한다.
   *
   * 브라우저 썸(pseudo-element)에 pointer-events 를 오버라이드하는 방식은
   * 터치 기기에서 두 썸 중 하나만 잡히는 문제가 있었다. 썸을 div 로 만들고
   * 트랙에서 포인터 이벤트를 직접 받는다. 마우스와 터치가 같은 경로를 탄다.
   */
  function buildThumbsAll() {
    Object.keys(RANGES).forEach(function (key) {
      buildThumbs(key);
      paintRange(key);
    });
  }

  function buildThumbs(key) {
    var track = el[key + "Min"].parentElement;
    ["lo", "hi"].forEach(function (side) {
      var t = document.createElement("div");
      t.className = "rng-thumb rng-thumb-" + side;
      t.setAttribute("tabindex", "0");
      t.setAttribute("role", "slider");
      t.setAttribute("aria-label", (key === "price" ? "가격" : key === "rating" ? "평점" : key) + (side === "lo" ? " 최소" : " 최대"));
      track.appendChild(t);
    });
    bindRangePointer(key, track);
  }

  function bindRangePointer(key, track) {
    var active = null;   // 현재 끌고 있는 썸 ("Min" | "Max")
    var activeEl = null;

    function pctFromEvent(e) {
      var r = track.getBoundingClientRect();
      return Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    }

    /** 두 썸 중 어느 쪽을 잡을지 정한다. 가까운 쪽, 동률이면 항상 최소 쪽. */
    function pick(pct) {
      var p = state.ranges[key];
      var loPct = toPct(key, p.lo);
      var hiPct = toPct(key, p.hi);
      return Math.abs(pct - loPct) <= Math.abs(pct - hiPct) ? "Min" : "Max";
    }

    /**
     * 썸 위치를 실제 스냅 값으로 바꾼다.
     * 슬라이더 값(로그 위치)을 거꾸로 되돌리면 정수 반올림 때문에
     * 30000 이 30306 같은 값이 되어 정지점을 잃는다.
     * 그래서 pct -> 실제값 -> 스냅 해서 상태에 직접 넣는다.
     */
    function apply(pct) {
      var p = state.ranges[key];
      var snapped = snapValue(key, toReal(key, pct));
      if (active === "Min") setRangeState(key, snapped, Math.max(snapped, p.hi));
      else setRangeState(key, Math.min(snapped, p.lo), snapped);
      updateLabels();
      scheduleApply(key);
    }

    var applyTimer = null;
    function scheduleApply() {
      clearTimeout(applyTimer);
      applyTimer = setTimeout(function () { saveFilters(); renderReset(); }, 160);
    }

    track.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
      var pct = pctFromEvent(e);
      active = pick(pct);
      activeEl = track.querySelector(active === "Min" ? ".rng-thumb-lo" : ".rng-thumb-hi");
      if (activeEl) activeEl.classList.add("dragging");
      try { track.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
      apply(pct);
    });

    track.addEventListener("pointermove", function (e) {
      if (!active) return;
      e.preventDefault();
      apply(pctFromEvent(e));
    });

    function end(e) {
      if (!active) return;
      if (activeEl) activeEl.classList.remove("dragging");
      active = null;
      activeEl = null;
      try { track.releasePointerCapture(e.pointerId); } catch (err) {}
      saveFilters();
      renderReset();
    }
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);

    // 키보드 접근성. 한 칸 이동도 스냅 단위를 따른다.
    ["lo", "hi"].forEach(function (side) {
      var thumb = track.querySelector(".rng-thumb-" + side);
      thumb.addEventListener("keydown", function (e) {
        var which = side === "lo" ? "Min" : "Max";
        var r = RANGES[key];
        var p = state.ranges[key];
        var dir = 0;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") dir = -1;
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") dir = 1;
        else if (e.key === "Home" || e.key === "End") dir = 0;
        else return;
        e.preventDefault();

        var cur = which === "Min" ? p.lo : p.hi;
        var next;
        if (r.stops) {
          var i = nearestStop(r.stops, cur);
          var target = e.key === "Home" ? 0 : e.key === "End" ? r.stops.length - 1 : i + dir;
          target = Math.max(0, Math.min(r.stops.length - 1, target));
          next = r.stops[target];
        } else {
          var unit = r.snap || 1;
          var step = e.shiftKey ? Math.max(unit, snapValue(key, (r.hi - r.lo) / 20)) : unit;
          var to = e.key === "Home" ? r.lo : e.key === "End" ? r.hi : cur + dir * step;
          next = snapValue(key, to);
        }

        if (which === "Min") setRangeState(key, next, Math.max(next, p.hi));
        else setRangeState(key, Math.min(next, p.lo), next);
        updateLabels();
        saveFilters();
        renderReset();
      });
    });
  }

  function nearestStop(stops, value) {
    var best = 0;
    var bestD = Math.abs(stops[0] - value);
    for (var i = 1; i < stops.length; i++) {
      var d = Math.abs(stops[i] - value);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /* ---------- 필터 상태 ---------- */
  function readFilters() {
    var f = { q: el.q.value.trim().toLowerCase(), sort: el.sort.value, hideSeen: el.hideSeen.checked };
    Object.keys(RANGES).forEach(function (key) {
      var p = state.ranges[key] || fullRange(key);
      f[key + "Min"] = p.lo;
      f[key + "Max"] = p.hi;
    });
    return f;
  }

  function saveFilters() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(readFilters())); } catch (e) {}
  }

  function loadFilters() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (!s) return;
      if (s.q) el.q.value = s.q;
      if (s.sort) el.sort.value = s.sort;
      Object.keys(RANGES).forEach(function (key) {
        var full = fullRange(key);
        var lo = typeof s[key + "Min"] === "number" ? snapValue(key, s[key + "Min"]) : full.lo;
        var hi = typeof s[key + "Max"] === "number" ? snapValue(key, s[key + "Max"]) : full.hi;
        setRangeState(key, lo, hi);
      });
      el.hideSeen.checked = !!s.hideSeen;
    } catch (e) {}
  }

  /* ---------- 필터링 + 정렬 ---------- */
  function apply() {
    var f = readFilters();
    var out = [];

    for (var i = 0; i < state.list.length; i++) {
      var g = state.list[i];
      if (g.s < f.priceMin || g.s > f.priceMax) continue;
      if (g.d < f.discountMin || g.d > f.discountMax) continue;
      if (g.r < f.ratingMin || g.r > f.ratingMax) continue;
      if (g.c < f.reviewsMin || g.c > f.reviewsMax) continue;
      if (f.hideSeen && g.f < state.dataDate) continue;
      if (f.q && g.n.toLowerCase().indexOf(f.q) === -1) continue;
      out.push(g);
    }

    var dir = 1;
    switch (f.sort) {
      case "price-desc": dir = -1; /* fallthrough */
      case "price-asc":
        out.sort(function (a, b) { return (a.s - b.s) * dir || a.c - b.c || (a.i < b.i ? -1 : 1); });
        break;
      case "discount-desc":
        out.sort(function (a, b) { return b.d - a.d || b.r - a.r || (a.i < b.i ? -1 : 1); });
        break;
      case "rating-desc":
        out.sort(function (a, b) { return b.r - a.r || b.c - a.c || (a.i < b.i ? -1 : 1); });
        break;
      case "reviews-desc":
        out.sort(function (a, b) { return b.c - a.c || b.r - a.r || (a.i < b.i ? -1 : 1); });
        break;
      case "name-asc":
        out.sort(function (a, b) { return a.n.localeCompare(b.n, "ko") || (a.i < b.i ? -1 : 1); });
        break;
    }
    return out;
  }

  /* ---------- 렌더링 ---------- */
  function cardHtml(g) {
    var isNew = g.f >= state.dataDate;
    var initial = esc(g.n.slice(0, 1).toUpperCase());
    var url = imgUrl(g);
    // 이미지 상대경로가 없으면 실패를 기다리지 않고 바로 대체 타일을 그린다.
    var img = url
      ? '<img class="thumb" loading="lazy" decoding="async" src="' + esc(url) +
        '" alt="" data-initial="' + initial + '">'
      : '<div class="thumb-fallback">' + initial + '</div>';
    // 세로 두 줄로 묶는다:
    //   제목                      할인율
    //   할인가 기존가      ★평점 리뷰수
    // 이미지가 낮아서 3줄이면 세로로 빈칸이 많이 생긴다.
    return '<a class="card" href="' + esc(storeUrl(g.i)) + '" target="_blank" rel="noopener">' +
      img +
      '<div class="card-body">' +
        '<div class="card-top">' +
          '<span class="name">' + esc(g.n) + (isNew ? '<span class="badge-new">NEW</span>' : '') + '</span>' +
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
    '</a>';
  }

  function render(reset) {
    var list = apply();

    if (reset) {
      state.shown = 0;
      el.grid.innerHTML = "";
    }

    var end = Math.min(state.shown + PAGE, list.length);
    var html = "";
    for (var i = state.shown; i < end; i++) html += cardHtml(list[i]);
    el.grid.insertAdjacentHTML("beforeend", html);
    state.shown = end;

    el.count.innerHTML = "조건相符 <b>" + list.length.toLocaleString("ko-KR") + "</b>개" +
      (list.length ? " 중 <b>" + state.shown.toLocaleString("ko-KR") + "</b>개 표시" : "");
    el.countMini.textContent = list.length.toLocaleString("ko-KR") + "개";
    el.empty.hidden = list.length > 0;
    el.more.hidden = state.shown >= list.length;
    el.more.textContent = "더 보기 (" + (list.length - state.shown).toLocaleString("ko-KR") + "개 남음)";
  }

  function renderReset() { render(true); }

  /* ---------- 출력 라벨 ---------- */
  function rangeText(key, f) {
    var r = RANGES[key];
    var lo = f[key + "Min"];
    var hi = f[key + "Max"];
    var fmt = (key === "price") ? function (v) { return money(v); }
            : (key === "reviews") ? compact
            : function (v) { return v + "%"; };
    var atLo = key === "price" ? lo <= r.lo : lo <= r.lo;
    var atHi = key === "price" ? hi >= r.hi : hi >= r.hi;
    if (atLo && atHi) return "전체";
    if (atLo) return "≤ " + fmt(Math.round(hi * 100) / 100);
    if (atHi) return fmt(Math.round(lo * 100) / 100) + "+";
    return fmt(Math.round(lo * 100) / 100) + "~" + fmt(Math.round(hi * 100) / 100);
  }

  function updateLabels() {
    var f = readFilters();
    el.priceOut.textContent = rangeText("price", f);
    el.discountOut.textContent = rangeText("discount", f);
    el.ratingOut.textContent = rangeText("rating", f);
    el.reviewsOut.textContent = rangeText("reviews", f);
    updateSummary(f);
  }

  /* 접힌 상태에서 현재 조건을 한 줄로 보여준다. */
  function updateSummary(f) {
    f = f || readFilters();
    var parts = [];
    if (f.q) parts.push("‘" + f.q + "’");
    Object.keys(RANGES).forEach(function (key) {
      var t = rangeText(key, f);
      if (t !== "전체") parts.push((key === "rating" ? "★" : "") + t);
    });
    if (f.hideSeen) parts.push("본 것 숨김");
    el.filterSummary.textContent = parts.length ? parts.join(" · ") : "전체";
  }

  /* ---------- 초기화 ---------- */
  function header() {
    var s = state.data.stats || {};
    var cur = state.data.currency || "";
    el.stats.innerHTML =
      "진행 중 <b>" + (s.total || 0).toLocaleString("ko-KR") + "</b>개" +
      " · 오늘 신규 <b>" + (s.newToday || 0).toLocaleString("ko-KR") + "</b>개" +
      " · 리뷰 1만+ <b>" + (s.reviews10kPlus || 0).toLocaleString("ko-KR") + "</b>개";
    el.stamp.textContent = "수집 " + state.data.scrapedAt.replace("T", " ").replace(/\..*$/, " UTC") + " · 가격 통화 " + cur;
    el.footSub.textContent = "데이터 수집 " + state.data.scrapedAt.slice(0, 10) + " 기준. 할인 종료일은 제공되지 않습니다.";
  }

  function calibratePrice() {
    // 슬라이더 상한은 실제 최댓값을 쓴다.
    // 예전에 98퍼센타일로 잘랐더니 값이 비싼 게임 46개가 핸들이 닿지 않아
    // 조용히 사라졌고, 라벨은 "전체"라고 표시했다.
    var prices = state.list.map(function (g) { return g.s; }).sort(function (a, b) { return a - b; });
    if (!prices.length) return;
    var max = Math.max(10, Math.ceil(prices[prices.length - 1]));
    RANGES.price.hi = max;
    state.priceMax = max;

    var full = sliderMax("price");
    el.priceMin.max = String(full);
    el.priceMax.max = String(full);
    el.priceMin.value = "0";
    el.priceMax.value = String(full);

    var priceTicks = document.querySelector('[data-ticks="price"]');
    if (priceTicks) {
      priceTicks.innerHTML = "";
      addTick(priceTicks, 0, "0");
      addTick(priceTicks, Math.round(max * 0.25), money(Math.round(max * 0.25)));
      addTick(priceTicks, Math.round(max * 0.5), money(Math.round(max * 0.5)));
      addTick(priceTicks, Math.round(max * 0.75), money(Math.round(max * 0.75)));
      addTick(priceTicks, max, money(max));
    }

    layoutTicks();
  }

  function addTick(container, value, label) {
    var s = document.createElement("span");
    s.setAttribute("data-v", String(value));
    s.textContent = label;
    container.appendChild(s);
  }

  /* 눈금 위치는 실제 값의 백분율로 계산한다. 로그 스케일에서
   * 균등 배치를 쓰면 전부 어긋난다. */
  function layoutTicks() {
    document.querySelectorAll("[data-ticks]").forEach(function (box) {
      var key = box.getAttribute("data-ticks");
      if (!RANGES[key]) return;
      box.querySelectorAll("span[data-v]").forEach(function (s) {
        s.style.left = toPct(key, Number(s.getAttribute("data-v"))) + "%";
      });
    });
  }

  function bind() {
    var timer = null;
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(function () { updateLabels(); saveFilters(); renderReset(); }, 140);
    }

    ["q", "sort"].forEach(function (id) {
      el[id].addEventListener("input", function () {
        if (id === "q") { schedule(); return; }
        updateLabels(); saveFilters(); renderReset();
      });
      el[id].addEventListener("change", function () {
        updateLabels(); saveFilters(); renderReset();
      });
    });

    // 범위형 필터의 포인터/키보드 동작은 buildThumbs 에서 물린다.
    // 여기서는 프로그램적으로 값을 바꿀 때(초기화, localStorage 복원)만 반응한다.
    Object.keys(RANGES).forEach(function (key) {
      ["Min", "Max"].forEach(function (side) {
        el[key + side].addEventListener("input", function () {
          setRange(key);
          updateLabels();
          schedule();
        });
      });
    });

    el.hideSeen.addEventListener("change", function () { saveFilters(); renderReset(); });

    // error 이벤트는 버블링하지 않으므로 캡처 단계에서 처리한다.
    el.grid.addEventListener("error", function (e) {
      var img = e.target;
      if (!img || img.tagName !== "IMG" || !img.classList.contains("thumb")) return;
      var box = document.createElement("div");
      box.className = "thumb-fallback";
      box.textContent = img.getAttribute("data-initial") || "?";
      if (img.parentNode) img.parentNode.replaceChild(box, img);
    }, true);

    el.reset.addEventListener("click", function () {
      try { localStorage.removeItem(LS_KEY); } catch (e) {}
      el.q.value = "";
      el.sort.value = "price-asc";
      Object.keys(RANGES).forEach(function (key) {
        var full = fullRange(key);
        setRangeState(key, full.lo, full.hi);
      });
      el.hideSeen.checked = false;
      updateLabels();
      renderReset();
    });

    el.more.addEventListener("click", function () { render(false); });

    // 좁은 화면에서만 접힌 필터를 토글한다 (넓은 화면에서는 항상 펼쳐 둔다).
    el.filterToggle.addEventListener("click", function () {
      var open = el.filters.classList.toggle("open");
      el.filterToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && !el.more.hidden) render(false);
      }, { rootMargin: "600px" }).observe(el.sentinel);
    } else {
      el.more.hidden = false;
    }

    window.addEventListener("scroll", function () {
      if (el.more.hidden) return;
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 1200) render(false);
    }, { passive: true });
  }

  /* ---------- 설치 안내 ---------- */
  function setupInstall() {
    var standalone = window.matchMedia("(display-mode: standalone)").matches ||
                     window.navigator.standalone === true;
    if (standalone || localStorage.getItem("ssa.install.dismissed")) return;

    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    var deferred = null;

    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferred = e;
    });

    setTimeout(function () {
      if (deferred) {
        show("홈 화면에 설치하면 앱처럼 실행됩니다.", "설치", function () {
          deferred.prompt();
          deferred.userChoice.then(function () { hide(); });
        });
        return;
      }
      if (isIOS) {
        show("크롬 메뉴 <b>더보기</b> → <b>홈 화면에 추가</b> 로 설치할 수 있습니다.", "알림", function () {
          localStorage.setItem("ssa.install.dismissed", "1");
          hide();
        });
      }
    }, 2500);

    function show(html, label, onClick) {
      var bar = document.createElement("div");
      bar.className = "install show";
      bar.innerHTML = '<div class="install-text">' + html + '</div>' +
        '<button type="button">' + label + '</button>' +
        '<button type="button" class="dismiss" aria-label="닫기">&times;</button>';
      var btns = bar.querySelectorAll("button");
      btns[0].addEventListener("click", onClick);
      btns[1].addEventListener("click", function () {
        localStorage.setItem("ssa.install.dismissed", "1");
        hide();
      });
      document.body.appendChild(bar);

      function hide() { if (bar.parentNode) bar.parentNode.removeChild(bar); }
    }
  }

  /* ---------- 서비스 워커 ---------- */
  function setupSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol === "file:") return;
    // updateViaCache: "none" — 브라우저가 sw.js 를 HTTP 캐시로 돌리지 않고
    // 매 방문마다 변경 여부를 확인한다. 이게 없으면 갱신이 멈출 수 있다.
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(function () {});
  }

  /* ---------- 시작 ---------- */
  function boot(data) {
    state.data = data;
    state.dataDate = (data.scrapedAt || "").slice(0, 10);
    state.list = data.games || [];

    // 가격 상한을 먼저 정한 뒤에 저장된 필터를 복원해야 한다.
    // 순서가 바뀌면 priceMin/max 의 max 가 아직 0 이어서 복원값이 깨진다.
    calibratePrice();
    Object.keys(RANGES).forEach(function (key) {
      state.ranges[key] = fullRange(key);
    });
    buildThumbsAll();
    loadFilters();
    updateLabels();
    header();
    bind();
    renderReset();
    setupInstall();
    setupSW();
  }

  function fail(msg) {
    el.count.innerHTML = "";
    el.empty.hidden = false;
    el.empty.textContent = msg;
    el.stats.textContent = "";
  }

  fetch("games.json", { cache: "no-cache" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(boot)
    .catch(function (e) {
      fail("games.json을 불러오지 못했습니다 (" + e.message + "). 수집 작업이 아직 실행되지 않았을 수 있습니다.");
    });
})();
