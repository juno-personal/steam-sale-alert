// 앱 전역 상태.
// boot() 가 데이터 로드 후 초기화하며, 초기화 전에는 사용자 필터만 담고 있다.

export const state = {
  data: null, // games.json 전체
  list: [],   // 정렬된 게임 목록 (sort/copy 시점)
  shown: 0,   // 한 번에 렌더링된 카드 수 (페이징)
  dataDate: "", // "YYYY-MM-DD" 형식, 수집일
  priceMax: 200, // calibratePrice() 후 갱신
  ranges: {}, // key -> { lo, hi } (스냅 적용 후 실제 값)
};
