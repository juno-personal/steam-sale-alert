/**
 * SteamDB Sales DOM 셀렉터 정의 + 폴백 체인
 * 
 * 2026-09 실측 기반 셀렉터입니다.
 * SteamDB는 테이블 기반 구조이므로 td/th 셀렉터를 사용합니다.
 */

// 타겟 URL: 카테고리=-888(전체), min_discount=0, min_rating=70, min_reviews=100
export const TARGET_URL = "https://steamdb.info/sales/?category=-888&min_discount=0&min_rating=70&min_reviews=100";

// 테이블 행 셀렉터: 판매 중인 상품 행들 (dt-row 클래스 사용)
export const ROW_SELECTORS = [
  "tr.dt-row",           // 기본: DataTables 행
  "tr[data-dt-row]",    // 대안
  "tr",                 // 폴백: 모든 행
];

// 전체 테이블 셀렉터 (페이지 로드 대기용)
export const TABLE_SELECTORS = [
  "table.dataTable",           // DataTables 기본
  "table",                     // 폴백: 모든 테이블
  ".dt-container table",       // DataTables 컨테이너
];

// 정지 판정: 일정 횟수 이후 행 수가 변하지 않으면 멈춤
export const SCROLL_DEFAULTS = {
  maxScrolls: 20,
  stableNeeded: 3,
  settleMs: 1500,
  maxSeconds: 180,
  viewport: { width: 1920, height: 1080 },
};

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";