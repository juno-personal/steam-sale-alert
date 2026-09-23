/**
 * STEAMDB SALE ALERT v1.0
 *
 * 수신 데이터: GitHub Actions -> 이 Web App
 * 이메일 대상: 최근 24시간内 시작된 SteamDB 할인 게임
 *
 * 필수 Script Properties:
 *   SHARED_TOKEN    - GitHub Actions GAS_TOKEN과 동일한 값
 *   RECIPIENT_EMAIL - 받을 이메일 주소 (생략하면 발송 계정 사용)
 *   GITHUB_PAT      - 워커 실행용 GitHub Fine-grained PAT
 *   GITHUB_REPO     - owner/repository
 *   GITHUB_WORKFLOW - steamdb-sales.yml
 *   GITHUB_REF      - main
 */

const STEAMDB_CONFIG = Object.freeze({
  VERSION: "1.0",
  ENDPOINT: "steamdb-sale-alert",
  SENT_GAMES_KEY: "STEAMDB_SENT_GAMES_V1",
  MAX_SENT_GAMES: 1000,
  TOKEN_PROP: "SHARED_TOKEN",
  RECIPIENT_PROP: "RECIPIENT_EMAIL",
  DEFAULT_WORKFLOW: "steamdb-sales.yml",
  DEFAULT_REF: "main",
});

/** GitHub Action이 보내는 JSON을 처리합니다. */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: "empty_body" });
    }

    const body = JSON.parse(e.postData.contents);
    const expectedToken = getScriptProperty(STEAMDB_CONFIG.TOKEN_PROP);

    if (!expectedToken) {
      console.error("SHARED_TOKEN Script Property가 설정되지 않았습니다.");
      return jsonResponse({ ok: false, error: "server_token_not_configured" });
    }
    if (body.token !== expectedToken) {
      console.warn("POST authentication failed");
      return jsonResponse({ ok: false, error: "unauthorized" });
    }

    const games = Array.isArray(body.games) ? body.games : [];
    const result = processGames(games);

    return jsonResponse({
      ok: true,
      received: games.length,
      newGames: result.newGames,
      alreadySent: result.alreadySent,
      emailed: result.emailed,
    });
  } catch (error) {
    console.error(error.stack || error.message);
    return jsonResponse({ ok: false, error: String(error.message || error) });
  }
}

/** 비밀번호 없는 상태 확인용 GET. */
function doGet() {
  return jsonResponse({
    ok: true,
    version: STEAMDB_CONFIG.VERSION,
    endpoint: STEAMDB_CONFIG.ENDPOINT,
    tokenConfigured: Boolean(getScriptProperty(STEAMDB_CONFIG.TOKEN_PROP)),
    sentGamesCount: Object.keys(loadSentGames()).length,
  });
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/** 매일 09:00에 GitHub Actions 실행을 요청합니다. */
function main() {
  try {
    console.log("SteamDB Sale Alert " + STEAMDB_CONFIG.VERSION);
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

  const workflow = props.getProperty("GITHUB_WORKFLOW") || STEAMDB_CONFIG.DEFAULT_WORKFLOW;
  const ref = props.getProperty("GITHUB_REF") || STEAMDB_CONFIG.DEFAULT_REF;
  const url = "https://api.github.com/repos/" + encodeURIComponent(repo) +
    "/actions/workflows/" + encodeURIComponent(workflow) + "/dispatches";

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ ref: ref }),
    muteHttpExceptions: true,
    headers: {
      Authorization: "Bearer " + pat,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gas-steamdb-sale-alert",
    },
  });

  const code = response.getResponseCode();
  if (code !== 204 && code !== 200) {
    throw new Error("GitHub workflow 실행 실패 HTTP " + code + ": " + response.getContentText());
  }
  return { ok: true, status: code, workflow: workflow, ref: ref };
}

function setupDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger("main").timeBased().everyDays(1).atHour(9).create();
  console.log("매일 09:00 트리거를 설치했습니다.");
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  console.log("기존 트리거를 삭제했습니다.");
}

/** 기존 할인율과 같은 항목은 제외하고 새 할인만 이메일로 보냅니다. */
function processGames(games) {
  const cleanGames = sanitizeGames(games);
  const filtered = filterNewGamesOnly(cleanGames);
  let emailed = 0;

  if (filtered.newGames.length > 0) {
    sendSaleEmail(filtered.newGames);
    updateSentGamesRecord(filtered.newGames);
    emailed = 1;
  }

  return {
    newGames: filtered.newGames.length,
    alreadySent: filtered.alreadySent.length,
    emailed: emailed,
  };
}

function sanitizeGames(games) {
  return games
    .filter(function (game) { return game && game.name; })
    .map(function (game) {
      return {
        packageId: game.packageId || null,
        name: String(game.name).trim(),
        discountPercent: toFiniteNumber(game.discountPercent),
        rating: toFiniteNumber(game.rating),
        originalPrice: cleanText(game.originalPrice),
        salePrice: cleanText(game.salePrice),
        imageUrl: safeImageUrl(game.imageUrl),
        productUrl: safeHttpUrl(game.productUrl),
        startedDate: game.startedDate || null,
        saleEndDate: game.saleEndDate || null,
        saleEndText: cleanText(game.saleEndText),
      };
    })
    .sort(function (a, b) {
      const startedDifference = toTime(b.startedDate) - toTime(a.startedDate);
      if (startedDifference) return startedDifference;
      return (b.rating || -1) - (a.rating || -1);
    })
    .slice(0, 100);
}

function filterNewGamesOnly(games) {
  const sent = loadSentGames();
  const newGames = [];
  const alreadySent = [];

  games.forEach(function (game) {
    const key = normalizeGameKey(game);
    const version = gameVersion(game);
    if (sent[key] === version) alreadySent.push(game);
    else newGames.push(game);
  });
  return { newGames: newGames, alreadySent: alreadySent };
}

function normalizeGameKey(game) {
  if (game.packageId) return String(game.packageId).trim().toLowerCase();
  return String(game.name).trim().toLowerCase().replace(/\s+/g, " ");
}

function gameVersion(game) {
  return String(game.discountPercent || 0) + ":" + String(game.salePrice || "");
}

function loadSentGames() {
  const raw = getScriptProperty(STEAMDB_CONFIG.SENT_GAMES_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn("발송 기록을 읽지 못해 빈 기록으로 시작합니다.");
    return {};
  }
}

function updateSentGamesRecord(games) {
  const sent = loadSentGames();
  games.forEach(function (game) {
    sent[normalizeGameKey(game)] = {
      version: gameVersion(game),
      sentAt: new Date().toISOString(),
    };
  });
  pruneSentGames(sent);
  PropertiesService.getScriptProperties().setProperty(
    STEAMDB_CONFIG.SENT_GAMES_KEY,
    JSON.stringify(sent)
  );
}

function pruneSentGames(sent) {
  const keys = Object.keys(sent);
  if (keys.length <= STEAMDB_CONFIG.MAX_SENT_GAMES) return;
  keys
    .sort(function (a, b) { return toTime(sent[b].sentAt) - toTime(sent[a].sentAt); })
    .slice(STEAMDB_CONFIG.MAX_SENT_GAMES)
    .forEach(function (key) { delete sent[key]; });
}

function sendSaleEmail(games) {
  const recipient = getScriptProperty(STEAMDB_CONFIG.RECIPIENT_PROP) || Session.getActiveUser().getEmail();
  if (!recipient) throw new Error("수신자 이메일을 찾을 수 없습니다. RECIPIENT_EMAIL을 설정하세요.");

  const count = games.length;
  const topDiscount = games.reduce(function (max, game) {
    return Math.max(max, Number(game.discountPercent) || 0);
  }, 0);
  const subject = "[SteamDB] " + count + "개 새 할인 • 최대 " + topDiscount + "%";

  GmailApp.sendEmail(
    recipient,
    subject,
    "HTML 이메일을 지원하는 메일 클라이언트에서 확인하세요.",
    {
      htmlBody: buildEmailHTML(games),
      name: "SteamDB Sale Alert",
      noReply: true,
    }
  );
  console.log("이메일을 발송했습니다: " + recipient);
}

function sendErrorEmail(message) {
  const recipient = getScriptProperty(STEAMDB_CONFIG.RECIPIENT_PROP) || Session.getActiveUser().getEmail();
  if (!recipient) return;
  GmailApp.sendEmail(recipient, "[SteamDB] 알림 실행 오류", String(message));
}

/**
 * Gmail이 CSS를 안정적으로 지원하는 table + inline style 기반 이메일.
 * 모바일에서는 카드가 세로로 쌓이고 버튼은 전체 폭으로 표시됩니다.
 */
function buildEmailHTML(games) {
  const dateText = formatKoreanDateTime(new Date());
  let html = "";

  html += '<!doctype html><html><head><meta charset="utf-8">';
  html += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<title>SteamDB Sale Alert</title></head>';
  html += '<body style="margin:0;padding:0;background:#f3f6fb;color:#172033;font-family:Arial,Helvetica,sans-serif;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f3f6fb;"><tr><td align="center" style="padding:24px 12px;">';
  html += '<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 18px rgba(31,45,68,.08);">';

  // Header
  html += '<tr><td style="padding:28px 28px 24px;background:#172033;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>';
  html += '<td><div style="color:#ffffff;font-size:25px;font-weight:700;line-height:32px;">STEAM <span style="color:#66c0f4;">SALE ALERT</span></div>';
  html += '<div style="padding-top:7px;color:#b8c2d1;font-size:13px;line-height:19px;">최근 24시간 새롭게 시작한 할인</div></td>';
  html += '<td align="right"><div style="display:inline-block;padding:7px 11px;background:#2f80ed;border-radius:999px;color:#ffffff;font-size:12px;font-weight:700;white-space:nowrap;">' + games.length + ' GAMES</div></td>';
  html += '</tr></table></td></tr>';

  // Summary
  html += '<tr><td style="padding:20px 24px;background:#edf6ff;border-bottom:1px solid #d9e7f7;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>';
  html += '<td style="font-size:14px;color:#34506d;line-height:20px;"><strong>새로운 SteamDB 할인</strong>을 확인하세요.<br>시작일 최신순, 평점 높은 순으로 정렬했습니다.</td>';
  html += '<td align="right" style="padding-left:12px;color:#738399;font-size:12px;white-space:nowrap;">' + escapeHtml(dateText) + '</td>';
  html += '</tr></table></td></tr>';

  // Cards
  games.forEach(function (game) {
    html += buildGameCard(game);
  });

  // Footer
  html += '<tr><td style="padding:22px 24px 26px;background:#f8fafc;border-top:1px solid #e7edf4;">';
  html += '<div style="color:#738399;font-size:11px;line-height:18px;">가격과 할인율은 SteamDB 수집 시점 기준이며 실제 Steam 가격과 다를 수 있습니다. 최종 가격은 Steam 상점 구매 페이지에서 확인하세요.</div>';
  html += '<div style="padding-top:10px;color:#96a1b2;font-size:10px;line-height:16px;">STEAMDB SALE ALERT v' + STEAMDB_CONFIG.VERSION + ' · SteamDB sales feed</div>';
  html += '</td></tr>';

  html += '</table></td></tr></table></body></html>';
  return html;
}

function buildGameCard(game) {
  const imageUrl = game.imageUrl;
  const title = escapeHtml(game.name);
  const rating = toFiniteNumber(game.rating);
  const discount = toFiniteNumber(game.discountPercent);
  const salePrice = escapeHtml(game.salePrice || "가격 확인");
  const originalPrice = escapeHtml(game.originalPrice || "");
  const productUrl = game.productUrl || "https://steamdb.info/sales/";
  const ratingText = rating !== null ? formatRating(rating) : "평가 정보 없음";
  const saleEndText = formatSaleEnd(game);

  let html = '<tr><td style="padding:18px 20px;border-bottom:1px solid #edf1f6;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>';

  if (imageUrl) {
    html += '<td width="112" valign="top" style="width:112px;padding-right:16px;">';
    html += '<img src="' + escapeHtml(imageUrl) + '" width="112" height="112" alt="' + title + '" style="display:block;width:112px;height:112px;object-fit:cover;border-radius:12px;background:#e8edf4;">';
    html += '</td>';
  }

  html += '<td valign="top">';
  if (discount !== null) {
    html += '<div style="padding-bottom:7px;"><span style="display:inline-block;padding:4px 8px;background:#e8f5ec;color:#16834a;border-radius:5px;font-size:12px;font-weight:700;">' + discount + '% OFF</span></div>';
  }
  html += '<div style="color:#172033;font-size:18px;font-weight:700;line-height:24px;">' + title + '</div>';
  html += '<div style="padding-top:6px;color:#6f7c91;font-size:12px;line-height:18px;">★ ' + escapeHtml(ratingText) + '</div>';
  html += '<div style="padding-top:6px;color:#b42318;font-size:13px;font-weight:700;line-height:19px;">⏱ 할인 종료: ' + escapeHtml(saleEndText) + '</div>';

  html += '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="padding-top:10px;"><tr>';
  html += '<td style="padding-right:12px;color:#172033;font-size:21px;font-weight:700;line-height:28px;">' + salePrice + '</td>';
  if (originalPrice) {
    html += '<td valign="middle" style="color:#9aa4b2;font-size:13px;text-decoration:line-through;">' + originalPrice + '</td>';
  }
  html += '</tr></table>';

  html += '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding-top:12px;"><tr>';
  html += '<td style="width:100%;"><a href="' + escapeHtml(productUrl) + '" target="_blank" style="display:block;padding:10px 14px;background:#1b6fc2;border-radius:8px;color:#ffffff;text-align:center;text-decoration:none;font-size:13px;font-weight:700;line-height:18px;">SteamDB에서 보기</a></td>';
  html += '</tr></table>';
  html += '</td></tr></table></td></tr>';

  return html;
}

function formatSaleEnd(game) {
  const endDate = toDate(game.saleEndDate);
  if (endDate) return formatKoreanDateTime(endDate);
  if (game.saleEndText) return String(game.saleEndText);
  return "확인 필요";
}

function formatRating(value) {
  return value <= 1 ? (value * 100).toFixed(0) + "%" : value.toFixed(1) + " / 100";
}

function formatKoreanDateTime(date) {
  if (!date || isNaN(date.getTime())) return "-";
  return Utilities.formatDate(date, Session.getScriptTimeZone() || "Asia/Seoul", "yyyy.MM.dd HH:mm");
}

function safeHttpUrl(value) {
  const url = cleanText(value);
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

function safeImageUrl(value) {
  const url = safeHttpUrl(value);
  if (!url) return null;
  return /^https:\/\//i.test(url) ? url : null;
}

function cleanText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function toTime(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getScriptProperty(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

/** 실제 메일 전송 없이 HTML 미리보기를 Apps Script 편집기에서 확인할 수 있습니다. */
function previewEmail() {
  const sample = [
    {
      packageId: "preview-1",
      name: "SteamDB Sale Alert Sample Game",
      discountPercent: 75,
      rating: 94,
      originalPrice: "AED 199.99",
      salePrice: "AED 49.99",
      imageUrl: "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/730/header.jpg",
      productUrl: "https://steamdb.info/app/730/",
      startedDate: new Date().toISOString(),
      saleEndDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      saleEndText: "in 3 days",
    },
    {
      packageId: "preview-2",
      name: "Mobile Responsive Preview",
      discountPercent: 50,
      rating: 88,
      originalPrice: "AED 79.99",
      salePrice: "AED 39.99",
      imageUrl: null,
      productUrl: "https://steamdb.info/sales/",
      startedDate: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      saleEndText: "2 days left",
    },
  ];
  return buildEmailHTML(sample);
}

/** Gmail에 샘플 메일을 실제로 발송합니다. */
function sendPreviewEmail() {
  const htmlBody = previewEmail();
  const recipient = getScriptProperty(STEAMDB_CONFIG.RECIPIENT_PROP) || Session.getActiveUser().getEmail();
  if (!recipient) throw new Error("수신자 이메일을 찾을 수 없습니다.");
  GmailApp.sendEmail(recipient, "[미리보기] SteamDB Sale Alert 레이아웃", "HTML 미리보기입니다.", {
    htmlBody: htmlBody,
    name: "SteamDB Sale Alert",
    noReply: true,
  });
}

function clearSentGames() {
  PropertiesService.getScriptProperties().deleteProperty(STEAMDB_CONFIG.SENT_GAMES_KEY);
  console.log("SteamDB 발송 기록을 초기화했습니다.");
}

function showSentGamesCount() {
  console.log("기록된 게임 수: " + Object.keys(loadSentGames()).length);
}
