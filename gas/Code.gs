/**
 * STEAM SALE ALERT v2.0
 *
 * 수신 데이터: GitHub Actions -> 이 Web App
 * 이메일 대상: 오늘 처음 발견된 할인 게임 중 상위 40개 (1통)
 *
 * 신규 판정은 여기서 하지 않는다. 스크래퍼가 history.json으로 계산한
 * notify.top 만 렌더링한다. 덕분에 이쪽에 발송 기억을 두지 않아도
 * 같은 게임을 반복 발송하지 않는다.
 *
 * 필수 Script Properties:
 *   SHARED_TOKEN    - GitHub Actions GAS_TOKEN과 동일한 값
 *   RECIPIENT_EMAIL - 받을 이메일 주소 (생략하면 발송 계정 사용)
 *   GITHUB_PAT      - 워커 실행용 GitHub Fine-grained PAT
 *   GITHUB_REPO     - owner/repository
 *   GITHUB_WORKFLOW - steam-sales.yml (선택, 생략 시 steam-sales.yml 사용)
 *   GITHUB_REF      - main
 */

const ALERT_CONFIG = Object.freeze({
  VERSION: "2.0",
  ENDPOINT: "steam-sale-alert",
  TOKEN_PROP: "SHARED_TOKEN",
  RECIPIENT_PROP: "RECIPIENT_EMAIL",
  DEFAULT_WORKFLOW: "steam-sales.yml",
  DEFAULT_REF: "main",
  SITE_URL: "https://lostempus06-eng.github.io/steam-sale-alert-site/",
  IMG_PREFIX: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/",
});

const REVIEW_BENCHMARK = 10000;

/* ------------------------------------------------------------------ */
/* 엔드포인트                                                          */
/* ------------------------------------------------------------------ */

/** GitHub Action이 보내는 JSON을 처리합니다. */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: "empty_body" });
    }

    const body = JSON.parse(e.postData.contents);
    const expectedToken = getScriptProperty(ALERT_CONFIG.TOKEN_PROP);

    if (!expectedToken) {
      console.error("SHARED_TOKEN Script Property가 설정되지 않았습니다.");
      return jsonResponse({ ok: false, error: "server_token_not_configured" });
    }
    if (body.token !== expectedToken) {
      console.warn("POST authentication failed");
      return jsonResponse({ ok: false, error: "unauthorized" });
    }

    const result = notify(body);

    return jsonResponse({
      ok: true,
      handler: "doPost",
      scrapedAt: body.scrapedAt || null,
      onSale: result.onSale,
      newCount: result.newCount,
      emailed: result.emailed,
      topCount: result.topCount,
    });
  } catch (error) {
    console.error(error.stack || error.message);
    return jsonResponse({ ok: false, error: String(error.message || error) });
  }
}

/** 상태 확인용 GET. 비밀번호가 필요 없다. */
function doGet() {
  return jsonResponse({
    ok: true,
    service: "Steam Sale Alert",
    version: ALERT_CONFIG.VERSION,
    endpoint: ALERT_CONFIG.ENDPOINT,
    site: ALERT_CONFIG.SITE_URL,
    tokenConfigured: Boolean(getScriptProperty(ALERT_CONFIG.TOKEN_PROP)),
  });
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/* ------------------------------------------------------------------ */
/* 알림 발송                                                            */
/* ------------------------------------------------------------------ */

/**
 * 스크래퍼가 골라준 상위 게임으로 메일을 보냅니다.
 * 신규가 0건이면 메일을 보내지 않습니다 (조용히 종료).
 */
function notify(body) {
  const stats = body.stats || {};
  const notifyBlock = body.notify || {};
  const top = Array.isArray(notifyBlock.top) ? notifyBlock.top : [];

  const summary = {
    scrapedAt: body.scrapedAt || null,
    onSale: toFiniteNumber(stats.total) || 0,
    newCount: toFiniteNumber(notifyBlock.newCount) || 0,
    reviews10kPlus: toFiniteNumber(stats.reviews10kPlus) || 0,
    forced: !!notifyBlock.forced,
  };

  if (top.length === 0) {
    console.log(`신규 할인 ${summary.newCount}건, 보낼 게임이 없어 메일을 생략합니다.`);
    return { ...summary, emailed: false, topCount: 0 };
  }

  sendSaleEmail(top, summary);
  return { ...summary, emailed: true, topCount: top.length };
}

function sendSaleEmail(games, summary) {
  const recipient = getScriptProperty(ALERT_CONFIG.RECIPIENT_PROP) || Session.getActiveUser().getEmail();
  if (!recipient) throw new Error("수신자 이메일을 찾을 수 없습니다. RECIPIENT_EMAIL을 설정하세요.");

  const subject =
    "[Steam] 오늘 " + summary.newCount.toLocaleString("ko-KR") + "개 새 할인 · 상위 " + games.length + "개";

  GmailApp.sendEmail(
    recipient,
    subject,
    "HTML 이메일을 지원하는 메일 클라이언트에서 확인하세요.",
    {
      htmlBody: buildEmailHTML(games, summary),
      name: "Steam Sale Alert",
      noReply: true,
    }
  );
  console.log(`이메일을 발송했습니다: ${recipient} (상위 ${games.length}개 / 신규 ${summary.newCount}개)`);
}

function sendErrorEmail(message) {
  const recipient = getScriptProperty(ALERT_CONFIG.RECIPIENT_PROP) || Session.getActiveUser().getEmail();
  if (!recipient) return;
  GmailApp.sendEmail(recipient, "[Steam] 알림 실행 오류", String(message));
}

/* ------------------------------------------------------------------ */
/* GitHub Actions 트리거                                               */
/* ------------------------------------------------------------------ */

function main() {
  try {
    console.log("Steam Sale Alert " + ALERT_CONFIG.VERSION);
    console.log(JSON.stringify(triggerWorker()));
  } catch (error) {
    console.error(error.stack || error.message);
    sendErrorEmail(String(error.message || error));
  }
}

function triggerWorker() {
  const props = PropertiesService.getScriptProperties();
  const pat = props.getProperty("GITHUB_PAT");
  const repo = props.getProperty("GITHUB_REPO");

  if (!pat || !repo) {
    throw new Error("GITHUB_PAT 및 GITHUB_REPO Script Property가 필요합니다.");
  }

  const workflow = props.getProperty("GITHUB_WORKFLOW") || ALERT_CONFIG.DEFAULT_WORKFLOW;
  const ref = props.getProperty("GITHUB_REF") || ALERT_CONFIG.DEFAULT_REF;
  const listResponse = UrlFetchApp.fetch(
    "https://api.github.com/repos/" + repo + "/actions/workflows?per_page=100",
    {
      headers: {
        Authorization: "Bearer " + pat,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gas-steam-sale-alert",
      },
      muteHttpExceptions: true,
    }
  );

  if (listResponse.getResponseCode() !== 200) {
    throw new Error(
      "GitHub workflow 목록 조회 실패 HTTP " + listResponse.getResponseCode() +
      ": " + listResponse.getContentText()
    );
  }

  const workflows = JSON.parse(listResponse.getContentText()).workflows || [];
  let selected = findWorkflow(workflows, workflow);
  let usedFallback = false;

  // Script Property 에 옛 파일명이 남아 있으면 그대로 실패하지 않는다.
  // 워크플로를 개명했을 때 사람이 설정까지 맞춰야 했던 사고를 없앤다.
  if (!selected) {
    selected = findWorkflow(workflows, ALERT_CONFIG.DEFAULT_WORKFLOW);
    usedFallback = !!selected;
    if (selected) {
      console.warn(
        'Script Property GITHUB_WORKFLOW="' + workflow + '" 인 워크플로가 없어 ' +
        '기본값 "' + ALERT_CONFIG.DEFAULT_WORKFLOW + '" 로 실행했습니다. ' +
        "해당 Script Property 는 지우거나 '" +
        ALERT_CONFIG.DEFAULT_WORKFLOW + "' 로 바꿔 주세요."
      );
    }
  }

  // 그래도 없으면 워크플로가 하나뿐인 저장소라면 그걸로 간주한다.
  if (!selected && workflows.length === 1) {
    selected = workflows[0];
    usedFallback = true;
    console.warn(
      "GITHUB_WORKFLOW 을 찾지 못해 유일한 워크플로 '" + selected.path + "' 로 실행했습니다."
    );
  }

  if (!selected) {
    throw new Error(
      "워크플로를 찾을 수 없습니다: " + workflow +
      ". 사용 가능한 워크플로: " +
      workflows.map(function (item) { return item.name + " (" + item.path + ")"; }).join(", ")
    );
  }

  const url = "https://api.github.com/repos/" + repo +
    "/actions/workflows/" + encodeURIComponent(selected.id) + "/dispatches";
  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ ref: ref }),
    muteHttpExceptions: true,
    headers: {
      Authorization: "Bearer " + pat,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gas-steam-sale-alert",
    },
  });

  const code = response.getResponseCode();
  if (code !== 204 && code !== 200) {
    throw new Error("GitHub workflow 실행 실패 HTTP " + code + ": " + response.getContentText());
  }
  return {
    ok: true,
    status: code,
    workflow: selected.name,
    workflowPath: selected.path,
    workflowId: selected.id,
    ref: ref,
    usedFallback: usedFallback,
  };
}

/**
 * 워크플로를 이름/경로/ID 로 찾는다.
 * ".github/workflows/steam-sales.yml", "steam-sales", "steam-sales.yml"
 * 처럼 표기가 달라도 같은 워크플로로 인식한다.
 */
function findWorkflow(workflows, wanted) {
  const target = String(wanted || "").trim();
  if (!target) return null;
  const base = target.replace(/^.*[\\/]/, "").replace(/\.ya?ml$/i, "").toLowerCase();

  return workflows.find(function (item) {
    if (String(item.id) === target) return true;
    if (item.name === target) return true;
    const itemPath = String(item.path || "").replace(/^.*[\\/]/, "");
    if (itemPath.toLowerCase() === target.toLowerCase()) return true;
    return itemPath.replace(/\.ya?ml$/i, "").toLowerCase() === base;
  }) || null;
}

/** 최초 1회만 실행: 외부 요청 승인 프롬프트를 띄운다. */
function authorizeExternalRequests() {
  UrlFetchApp.fetch("https://www.google.com", { muteHttpExceptions: true });
  console.log("외부 요청이 승인되었습니다.");
}

/** 매일 지정 시각에 워크플로를 자동 실행합니다. */
function setupDailyTrigger(hour) {
  removeTriggers();
  ScriptApp.newTrigger("main").timeBased().everyDays(1).atHour(hour || 9).create();
  console.log("매일 " + (hour || 9) + "시 트리거를 만들었습니다.");
}

function removeTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  console.log("기존 트리거를 삭제했습니다.");
}

/* ------------------------------------------------------------------ */
/* 이메일 HTML (Gmail 호환: table + inline style)                      */
/* ------------------------------------------------------------------ */

function buildEmailHTML(games, summary) {
  const when = summary.scrapedAt ? formatKoreanDateTime(new Date(summary.scrapedAt)) : "-";
  const cur = "AED";

  let html = "";
  html += '<!doctype html><html><head><meta charset="utf-8">';
  html += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<title>Steam Sale Alert</title></head>';
  html += '<body style="margin:0;padding:0;background:#f3f6fb;color:#172033;font-family:Arial,Helvetica,sans-serif;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f3f6fb;"><tr><td align="center" style="padding:24px 12px;">';
  html += '<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 18px rgba(31,45,68,.08);">';

  // 헤더
  html += '<tr><td style="padding:26px 26px 22px;background:#1b2838;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>';
  html += '<td><div style="color:#ffffff;font-size:24px;font-weight:700;line-height:31px;">STEAM <span style="color:#66c0f4;">SALE ALERT</span></div>';
  html += '<div style="padding-top:6px;color:#b8c2d1;font-size:13px;line-height:19px;">' + escapeHtml(when) + ' 기준</div></td>';
  html += '<td align="right" style="white-space:nowrap;"><div style="display:inline-block;padding:6px 11px;background:#a4d007;border-radius:999px;color:#1b2838;font-size:12px;font-weight:700;">+' + games.length + '</div></td>';
  html += '</tr></table></td></tr>';

  // 요약
  html += '<tr><td style="padding:20px 22px 4px 22px;background:#edf6ff;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="table-layout:fixed;"><colgroup><col width="25"><col width="25"><col width="25"><col width="25"></colgroup><tr>';
  html += statTile(summary.onSale.toLocaleString("ko-KR"), "진행 중 할인");
  html += statTile(summary.newCount.toLocaleString("ko-KR"), "오늘 신규");
  html += statTile(summary.reviews10kPlus.toLocaleString("ko-KR"), "리뷰 1만+");
  html += statTile(String(games.length), "오늘 추천");
  html += '</tr></table>';
  html += '<div style="padding:14px 0 0 0;font-size:12px;line-height:19px;color:#5f6b78;">';
  html += summary.forced
    ? '<b style="color:#b45309;">강제 알림 모드로 발송했습니다.</b> '
    : '';
  html += '나머지 할인은 앱에서 가격·평점·리뷰 수로 골라 볼 수 있습니다.';
  html += '</div></td></tr>';

  // 앱 바로가기
  html += '<tr><td style="padding:14px 22px 18px 22px;background:#edf6ff;">';
  html += '<a href="' + escapeHtml(ALERT_CONFIG.SITE_URL) + '" target="_blank" style="display:block;padding:14px 18px;background:#1a9fff;border-radius:8px;color:#ffffff;font-size:15px;font-weight:700;text-align:center;text-decoration:none;">';
  html += '전체 할인 목록 보기 →';
  html += '</a>';
  html += '<div style="padding-top:8px;font-size:11px;color:#7b8a9d;text-align:center;">모바일은 크롬 메뉴 → 홈 화면에 추가로 앱처럼 쓸 수 있습니다</div>';
  html += '</td></tr>';

  // 목록 헤더
  html += '<tr><td style="padding:12px 22px 8px 22px;background:#f8fafc;border-bottom:1px solid #e7edf4;color:#6f7c91;font-size:11px;font-weight:700;letter-spacing:.3px;">';
  html += '평점 높은 순 · 상위 ' + games.length + '개';
  html += '</td></tr>';

  games.forEach(function (game, index) {
    html += buildGameRow(game, index + 1, cur);
  });

  // 푸터
  html += '<tr><td style="padding:22px 22px 26px 22px;background:#f8fafc;border-top:1px solid #e7edf4;">';
  html += '<div style="color:#738399;font-size:11px;line-height:18px;">가격과 할인율은 수집 시점 기준이며 실제 Steam 가격과 다를 수 있습니다. 최종 가격은 Steam 상점 구매 페이지에서 확인하세요.</div>';
  html += '<div style="padding-top:10px;color:#96a1b2;font-size:10px;line-height:16px;">STEAM SALE ALERT v' + ALERT_CONFIG.VERSION + ' · ' + escapeHtml(ALERT_CONFIG.SITE_URL) + '</div>';
  html += '</td></tr>';

  html += '</table></td></tr></table></body></html>';
  return html;
}

function statTile(value, label) {
  return '<td align="center" style="padding:0 4px;">' +
    '<div style="background:#ffffff;border:1px solid #d9e7f7;border-radius:8px;padding:12px 6px;">' +
    '<div style="font-size:20px;font-weight:700;color:#172033;line-height:26px;">' + value + '</div>' +
    '<div style="padding-top:2px;font-size:11px;color:#7b8a9d;line-height:15px;">' + label + '</div>' +
    '</div></td>';
}

/**
 * 게임 한 줄.
 *
 * 고정 열( colgroup + table-layout:fixed ) 을 쓰면 안 된다.
 * 고정 열 너비 합(20+92+66+104+92=374px)이 모바일 본문 폭(약 340px)을
 * 넘겨서 이름 열이 0px 로 눌리고 글자가 한 자씩 세로로 찍혔다.
 * (Gmail 모바일에서 실제로 발생)
 *
 * 열을 3개만 쓴다. 순번 · 이미지 · 본문 이며, 이름과 가격은
 * white-space:nowrap 를 걸지 않아 필요한 곳에서만 줄바꿈된다.
 */
function buildGameRow(game, rank, currency) {
  const title = escapeHtml(game.n || "");
  const discount = toFiniteNumber(game.d);
  const rating = toFiniteNumber(game.r);
  const reviews = toFiniteNumber(game.c);
  const salePrice = toFiniteNumber(game.s);
  const originalPrice = toFiniteNumber(game.o);
  const url = "https://store.steampowered.com/app/" + encodeURIComponent(game.i || "") + "/";
  // 게임별 상대경로만 저장되어 있으므로 prefix + appId + "/" + g 로 복원한다.
  const image = game.g
    ? ALERT_CONFIG.IMG_PREFIX + encodeURIComponent(game.i || "") + "/" + String(game.g)
    : null;

  let priceHtml = '<span style="color:#16834a;font-size:14px;font-weight:700;">' +
    (salePrice !== null ? formatPrice(salePrice, currency) : "가격 확인") + "</span>";
  if (originalPrice !== null) {
    priceHtml += ' <span style="color:#9aa4b2;font-size:11px;font-weight:400;text-decoration:line-through;">' +
      formatPrice(originalPrice, currency) + "</span>";
  }

  let metaHtml = rating !== null ? "★ " + formatRating(rating) : "-";
  if (reviews !== null) {
    metaHtml += ' <span style="color:#6f7c91;">· ' + formatReviewCount(reviews) + "</span>";
  }

  let html = '<tr><td style="padding:8px 20px;border-bottom:1px solid #edf1f6;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>';

  html += '<td width="14" valign="top" style="width:14px;padding:1px 6px 0 0;color:#9aa4b2;font-size:11px;font-weight:700;">' + rank + "</td>";

  html += '<td width="52" valign="top" style="width:52px;padding-right:10px;">';
  if (image) {
    html += '<a href="' + escapeHtml(url) + '" target="_blank"><img src="' + escapeHtml(image) + '" width="52" height="20" alt="" style="display:block;width:52px;height:20px;object-fit:cover;border-radius:3px;background:#e8edf4;border:0;"></a>';
  } else {
    html += '<div style="width:52px;height:20px;border-radius:3px;background:#e8edf4;"></div>';
  }
  html += "</td>";

  html += '<td valign="top" style="text-align:left;">';
  // 첫 줄: 이름 + 할인율. 이름만 줄바꿈을 허용한다.
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>';
  html += '<td valign="top" style="color:#172033;font-size:14px;font-weight:700;line-height:17px;word-break:break-word;">';
  html += '<a href="' + escapeHtml(url) + '" target="_blank" style="color:#172033;text-decoration:none;">' + title + "</a>";
  html += "</td>";
  html += '<td valign="top" align="right" style="white-space:nowrap;padding-left:8px;"><span style="color:#16834a;font-size:13px;font-weight:700;">' +
    (discount !== null ? "-" + discount + "%" : "-") + "</span></td>";
  html += "</tr>";

  // 둘째 줄: 가격 + 기존가 / 평점 · 리뷰수
  html += '<tr><td colspan="2" valign="top" style="padding:2px 0 0 0;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>';
  html += '<td valign="top" style="line-height:17px;">' + priceHtml + "</td>";
  html += '<td valign="top" align="right" style="white-space:nowrap;padding-left:8px;color:#172033;font-size:11px;line-height:17px;">' + metaHtml + "</td>";
  html += "</tr></table></td></tr>";

  html += "</table></td></tr></table></td></tr>";
  return html;
}

/* ------------------------------------------------------------------ */
/* 미리보기 / 관리                                                     */
/* ------------------------------------------------------------------ */

/** 실제 메일 전송 없이 HTML 미리보기를 Apps Script 편집기에서 확인합니다. */
function previewEmail() {
  const sample = [
    {
      i: "730", n: "Counter-Strike 2", d: 50, r: 90.8, c: 612000,
      o: 30, s: 15,
      g: "1b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c/capsule_231x87.jpg",
      f: "2026-10-04",
    },
    {
      i: "1091500", n: "Cyberpunk 2077", d: 70, r: 78.7, c: 23613,
      o: 229, s: 68.7,
      g: "b1b2dce17e7d3adabcfa0cbb6cbda8cf861badc3/capsule_231x87_koreana.jpg",
      f: "2026-10-04",
    },
    {
      i: "413150", n: "Stardew Valley", d: 20, r: 95.9, c: 148000,
      o: 14.99, s: 11.99,
      g: "capsule_231x87.jpg",
      f: "2026-10-04",
    },
  ];
  return buildEmailHTML(sample, {
    scrapedAt: new Date().toISOString(),
    onSale: 9496,
    newCount: 312,
    reviews10kPlus: 3226,
    forced: false,
  });
}

/** Gmail에 샘플 메일을 실제로 발송합니다. */
function sendPreviewEmail() {
  const htmlBody = previewEmail();
  const recipient = getScriptProperty(ALERT_CONFIG.RECIPIENT_PROP) || Session.getActiveUser().getEmail();
  if (!recipient) throw new Error("수신자 이메일을 찾을 수 없습니다.");
  GmailApp.sendEmail(recipient, "[미리보기] Steam Sale Alert 레이아웃", "HTML 미리보기입니다.", {
    htmlBody: htmlBody,
    name: "Steam Sale Alert",
    noReply: true,
  });
}

/** 마지막 발송 이후 워크플로를 다시 돌립니다. */
function retrigger() {
  return triggerWorker();
}

/* ------------------------------------------------------------------ */
/* 유틸                                                                */
/* ------------------------------------------------------------------ */

function formatPrice(value, currency) {
  const number = Number(value);
  const text = Number.isFinite(number)
    ? number.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "-";
  return currency ? text + " " + currency : text;
}

function formatReviewCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return "-";
  if (count >= 1000000) return (count / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (count >= 1000) return (count / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(count);
}

function formatRating(value) {
  return Math.round(Number(value) * 10) / 10 + "%";
}

function formatKoreanDateTime(date) {
  if (!date || isNaN(date.getTime())) return "-";
  return Utilities.formatDate(date, Session.getScriptTimeZone() || "Asia/Seoul", "yyyy.MM.dd HH:mm");
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function getScriptProperty(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}
