/**
 * STEAM SALE ALERT v1.0
 *
 * 수신 데이터: GitHub Actions -> 이 Web App
 * 이메일 대상: Steam 공식 스토어에서 수집한 할인 게임
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
  EMAIL_CHUNK_SIZE: 60,
  TOKEN_PROP: "SHARED_TOKEN",
  RECIPIENT_PROP: "RECIPIENT_EMAIL",
  DEFAULT_WORKFLOW: "steamdb-sales.yml",
  DEFAULT_REF: "main",
});

const EMAIL_REVIEW_GROUPS = Object.freeze([
  { label: "100K+", min: 100000, max: Infinity },
  { label: "30K~100K", min: 30000, max: 100000 },
  { label: "10K~30K", min: 10000, max: 30000 },
  { label: "1K~10K", min: 1000, max: 10000 },
  { label: "100~1K", min: 100, max: 1000 },
]);

const EMAIL_RATING_GROUPS = Object.freeze([
  { label: "95%~100%", min: 95, max: 101 },
  { label: "80%~95%", min: 80, max: 95 },
  { label: "70%~80%", min: 70, max: 80 },
]);

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
      handler: "doPost",
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
    dedupeMode: "packageId-only",
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
  const listResponse = UrlFetchApp.fetch(
    "https://api.github.com/repos/" + repo + "/actions/workflows?per_page=100",
    {
      headers: {
        Authorization: "Bearer " + pat,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gas-steamdb-sale-alert",
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
  const selected = workflows.find(function (item) {
    return item.path === ".github/workflows/" + workflow ||
      item.name === workflow ||
      String(item.id) === workflow;
  });

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
      "User-Agent": "gas-steamdb-sale-alert",
    },
  });

  const code = response.getResponseCode();
  if (code !== 204 && code !== 200) {
    throw new Error("GitHub workflow 실행 실패 HTTP " + code + ": " + response.getContentText());
  }
  return { ok: true, status: code, workflow: selected.name, workflowId: selected.id, ref: ref };
}

function authorizeExternalRequests() {
  UrlFetchApp.fetch("https://www.google.com", { muteHttpExceptions: true });
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
    const orderedGames = sortForEmail(filtered.newGames);
    // 평점 그룹 순서를 유지하면서 60개씩 메일을 나눕니다.
    for (let start = 0; start < orderedGames.length; start += STEAMDB_CONFIG.EMAIL_CHUNK_SIZE) {
      const chunk = orderedGames.slice(start, start + STEAMDB_CONFIG.EMAIL_CHUNK_SIZE);
      sendSaleEmail(chunk, start + 1, orderedGames.length);
      emailed += 1;
    }
    updateSentGamesRecord(orderedGames);
  }

  return {
    newGames: filtered.newGames.length,
    alreadySent: filtered.alreadySent.length,
    emailed: emailed,
  };
}

function sortForEmail(games) {
  return games.slice().sort(function (a, b) {
    const aReviewGroup = findEmailGroupIndex(EMAIL_REVIEW_GROUPS, toFiniteNumber(a.reviewCount));
    const bReviewGroup = findEmailGroupIndex(EMAIL_REVIEW_GROUPS, toFiniteNumber(b.reviewCount));
    if (aReviewGroup !== bReviewGroup) return aReviewGroup - bReviewGroup;

    const aRatingGroup = findEmailGroupIndex(EMAIL_RATING_GROUPS, toFiniteNumber(a.rating));
    const bRatingGroup = findEmailGroupIndex(EMAIL_RATING_GROUPS, toFiniteNumber(b.rating));
    if (aRatingGroup !== bRatingGroup) return aRatingGroup - bRatingGroup;

    return (toFiniteNumber(b.reviewCount) || 0) - (toFiniteNumber(a.reviewCount) || 0);
  });
}

function findEmailGroupIndex(groups, value) {
  const index = groups.findIndex(function (group) {
    return value !== null && value >= group.min && value < group.max;
  });
  return index === -1 ? groups.length : index;
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
        reviewCount: toFiniteNumber(game.reviewCount),
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
    .slice(0, 500);
}

function filterNewGamesOnly(games) {
  const sent = loadSentGames();
  const newGames = [];
  const alreadySent = [];

  games.forEach(function (game) {
    const key = normalizeGameKey(game);
    // 테스트 중에는 이미 기록된 packageId를 무조건 중복으로 처리합니다.
    if (Object.prototype.hasOwnProperty.call(sent, key)) {
      alreadySent.push(game);
    } else {
      newGames.push(game);
    }
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

function sendSaleEmail(games, fromIndex, totalCount) {
  const recipient = getScriptProperty(STEAMDB_CONFIG.RECIPIENT_PROP) || Session.getActiveUser().getEmail();
  if (!recipient) throw new Error("수신자 이메일을 찾을 수 없습니다. RECIPIENT_EMAIL을 설정하세요.");

  const count = games.length;
  const topDiscount = games.reduce(function (max, game) {
    return Math.max(max, Number(game.discountPercent) || 0);
  }, 0);
  const rangeText = fromIndex && totalCount
    ? " (" + fromIndex + "–" + (fromIndex + count - 1) + "/" + totalCount + ")"
    : "";
  const subject = "[Steam] " + count + "개 새 할인 • 최대 " + topDiscount + "%" + rangeText;

  GmailApp.sendEmail(
    recipient,
    subject,
    "HTML 이메일을 지원하는 메일 클라이언트에서 확인하세요.",
    {
      htmlBody: buildEmailHTML(games),
      name: "Steam Sale Alert",
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
  html += '<title>Steam Sale Alert</title></head>';
  html += '<body style="margin:0;padding:0;background:#f3f6fb;color:#172033;font-family:Arial,Helvetica,sans-serif;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f3f6fb;"><tr><td align="center" style="padding:24px 12px;">';
  html += '<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 18px rgba(31,45,68,.08);">';

  // Header
  html += '<tr><td style="padding:28px 28px 24px;background:#172033;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>';
  html += '<td><div style="color:#ffffff;font-size:25px;font-weight:700;line-height:32px;">STEAM <span style="color:#66c0f4;">SALE ALERT</span></div>';
  html += '<div style="padding-top:7px;color:#b8c2d1;font-size:13px;line-height:19px;">현재 Steam 스토어에서 진행 중인 할인</div></td>';
  html += '<td align="right"><div style="display:inline-block;padding:7px 11px;background:#2f80ed;border-radius:999px;color:#ffffff;font-size:12px;font-weight:700;white-space:nowrap;">' + games.length + ' GAMES</div></td>';
  html += '</tr></table></td></tr>';

  // Summary
  html += '<tr><td style="padding:20px 24px;background:#edf6ff;border-bottom:1px solid #d9e7f7;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>';
  html += '<td style="font-size:14px;color:#34506d;line-height:20px;"><strong>새로운 Steam 할인</strong>을 확인하세요.<br>평점이 높은 게임부터 정렬했습니다.</td>';
  html += '<td align="right" style="padding-left:12px;color:#738399;font-size:12px;white-space:nowrap;">' + escapeHtml(dateText) + '</td>';
  html += '</tr></table></td></tr>';

  // Table header: 고정폭을 사용해 모든 행에서 열 위치를 맞춥니다.
  html += '<tr><td colspan="5" style="padding:10px 12px 6px 12px;background:#f8fafc;color:#6f7c91;font-size:11px;font-weight:700;letter-spacing:.3px;">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="table-layout:fixed;"><colgroup>' +
    '<col width="58"><col><col width="60"><col width="100"><col width="76">' +
    '</colgroup><tr>' +
    '<td style="width:58px;">이미지</td>' +
    '<td style="text-align:left;">게임 이름</td>' +
    '<td style="text-align:right;">할인율</td>' +
    '<td style="text-align:right;">현재 가격<br>기존 가격</td>' +
    '<td style="text-align:right;">평점<br>리뷰 수</td>' +
    '</tr></table></td></tr>';

  EMAIL_REVIEW_GROUPS.forEach(function (reviewGroup) {
    const reviewGroupGames = games.filter(function (game) {
      return isInEmailGroup(game.reviewCount, reviewGroup);
    });
    if (reviewGroupGames.length === 0) return;

    html += buildReviewGroupHeader(reviewGroup.label, reviewGroupGames.length);
    EMAIL_RATING_GROUPS.forEach(function (ratingGroup) {
      const ratingGroupGames = reviewGroupGames
        .filter(function (game) {
          return isInEmailGroup(game.rating, ratingGroup);
        })
        .sort(function (a, b) {
          return (toFiniteNumber(b.reviewCount) || 0) - (toFiniteNumber(a.reviewCount) || 0);
        });

      if (ratingGroupGames.length === 0) return;
      html += buildRatingGroupHeader(ratingGroup.label, ratingGroupGames.length);
      ratingGroupGames.forEach(function (game) {
        html += buildGameRow(game);
      });
    });
  });

  // Footer
  html += '<tr><td style="padding:22px 24px 26px;background:#f8fafc;border-top:1px solid #e7edf4;">';
  html += '<div style="color:#738399;font-size:11px;line-height:18px;">가격과 할인율은 수집 시점 기준이며 실제 Steam 가격과 다를 수 있습니다. 최종 가격은 Steam 상점 구매 페이지에서 확인하세요.</div>';
  html += '<div style="padding-top:10px;color:#96a1b2;font-size:10px;line-height:16px;">STEAM SALE ALERT v' + STEAMDB_CONFIG.VERSION + ' · Steam Store sales feed</div>';
  html += '</td></tr>';

  html += '</table></td></tr></table></body></html>';
  return html;
}

function isInEmailGroup(value, group) {
  const number = toFiniteNumber(value);
  return number !== null && number >= group.min && number < group.max;
}

function buildReviewGroupHeader(label, count) {
  return '<tr><td colspan="5" style="padding:15px 14px 8px 14px;background:#dcecff;border-top:1px solid #c8dcf5;border-bottom:1px solid #c8dcf5;">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>' +
    '<td style="color:#163b63;font-size:15px;font-weight:700;line-height:21px;">리뷰 수 ' + escapeHtml(label) + '</td>' +
    '<td align="right" style="color:#52708f;font-size:12px;line-height:21px;">' + count + '개</td>' +
    '</tr></table></td></tr>';
}

function buildRatingGroupHeader(label, count) {
  return '<tr><td colspan="5" style="padding:10px 14px 6px 14px;background:#eef4fb;border-bottom:1px solid #dce7f3;">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>' +
    '<td style="color:#34506d;font-size:12px;font-weight:700;line-height:18px;">평점 ' + escapeHtml(label) + '</td>' +
    '<td align="right" style="color:#7b8a9d;font-size:11px;line-height:18px;">' + count + '개</td>' +
    '</tr></table></td></tr>';
}

function buildGameRow(game) {
  const imageUrl = game.imageUrl;
  const title = escapeHtml(game.name);
  const rating = toFiniteNumber(game.rating);
  const discount = toFiniteNumber(game.discountPercent);
  const salePrice = escapeHtml(game.salePrice || "가격 확인");
  const originalPrice = escapeHtml(game.originalPrice || "");
  const productUrl = game.productUrl || "https://store.steampowered.com/";
  const ratingText = rating !== null ? formatRating(rating) : "-";
  const reviewCount = toFiniteNumber(game.reviewCount);
  const reviewText = reviewCount !== null ? formatReviewCount(reviewCount) : "-";

  let html = '<tr><td colspan="5" style="padding:7px 12px;border-bottom:1px solid #edf1f6;">';
  html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="table-layout:fixed;"><colgroup>' +
    '<col width="58"><col><col width="60"><col width="100"><col width="76">' +
    '</colgroup><tr>';

  html += '<td width="58" valign="middle" style="width:58px;padding-right:10px;">';
  if (imageUrl) {
    html += '<a href="' + escapeHtml(productUrl) + '" target="_blank"><img src="' + escapeHtml(imageUrl) + '" width="52" height="38" alt="' + title + '" style="display:block;width:52px;height:38px;object-fit:cover;border-radius:4px;background:#e8edf4;border:0;"></a>';
  } else {
    html += '<div style="width:52px;height:38px;border-radius:4px;background:#e8edf4;"></div>';
  }
  html += '</td>';

  html += '<td valign="middle" style="text-align:left;color:#172033;font-size:14px;font-weight:700;line-height:18px;">';
  html += '<a href="' + escapeHtml(productUrl) + '" target="_blank" style="color:#172033;text-decoration:none;">' + title + '</a>';
  html += '</td>';

  html += '<td width="62" align="right" valign="middle" style="width:62px;text-align:right;color:#16834a;font-size:13px;font-weight:700;">';
  html += (discount !== null ? "-" + discount + "%" : "-") + '</td>';

  html += '<td valign="middle" style="text-align:right;color:#172033;font-size:13px;font-weight:700;line-height:17px;">' + salePrice;
  html += '<br><span style="color:#9aa4b2;font-size:10px;font-weight:400;text-decoration:line-through;">' + (originalPrice || "-") + '</span>';
  html += '</td>';

  html += '<td valign="middle" style="text-align:right;color:#172033;font-size:12px;line-height:17px;">★ ' + escapeHtml(ratingText);
  html += '<br><span style="color:#6f7c91;font-size:10px;font-weight:400;">' + escapeHtml(reviewText) + '</span>';
  html += '</td>';
  html += '</tr></table></td></tr>';
  return html;
}

function formatSaleEnd(game) {
  const endDate = toDate(game.saleEndDate);
  if (endDate) return formatKoreanDateTime(endDate);
  if (game.saleEndText) return String(game.saleEndText);
  return "확인 필요";
}

function formatReviewCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return "-";
  if (count >= 100000) return Math.floor(count / 1000) + "K+";
  const thousands = (count / 1000).toFixed(1).replace(/\.0$/, "");
  return thousands + "K";
}

function formatRating(value) {
  return Math.floor(value <= 1 ? value * 100 : value) + "%";
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
      reviewCount: 12500,
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
      reviewCount: 4200,
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
