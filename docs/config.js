// Steam Sale Alert - 설정 상수 / 범위 정의
// app.js (ES 모듈 진입점) 에서 import 하여 사용한다.

export const PAGE = 60; // 한 번에 렌더링할 카드 수

export const LS_KEY = "ssa.filters.v1";

// ── 범위형 필터 설정 ──────────────────────────────
// 숫자 필터는 최소/최대 쌍으로 관리한다.
// 리뷰 수는 500 ~ 1,000,000 이라 선형 슬라이더로는 저역을 만질 수 없다.
// 슬라이더 위치(0~100)를 로그 스케일로 실제 리뷰 수에 매핑한다.
export const REVIEW_LO = 500;
export const REVIEW_HI = 1000000;
export const LOG_LO = Math.log(REVIEW_LO);
export const LOG_HI = Math.log(REVIEW_HI);

// snap 은 썸이 붙는 단위다. 썸을 직접 구현하면서 input.step 은 무시되므로
// 여기서 직접 맞춘다. 1% 단위로 움직여도 무의미하다.
export const REVIEW_STOPS = [500, 1000, 5000, 10000, 30000, 100000, 1000000];

// 범위형 필터는 제거됨. 빈 객체로 유지해 기존 참조(Object.keys)가 깨지지 않게 한다.
export const RANGES = {};
