const { test } = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/services/storeDataService");

test("listStores: 안내서비스 제공 매장이 미제공 매장보다 먼저 온다", () => {
  const list = store.listStores({});
  const idxGuide = list.findIndex((s) => s.hasGuideService);
  const idxNoGuide = list.findIndex((s) => !s.hasGuideService);
  assert.ok(idxGuide < idxNoGuide, "안내서비스 매장이 앞에 와야 함");
});

test("listStores: 좌표를 주면 거리순으로 정렬된다 (안내서비스 그룹 내에서)", () => {
  // 롯데 잠실점(37.5125,127.1025) 바로 옆 좌표로 검색하면 롯데가 신세계보다 가까워야 함
  const list = store.listStores({ lat: 37.513, lng: 127.103 });
  const guideStores = list.filter((s) => s.hasGuideService);
  assert.equal(guideStores[0].name, "롯데백화점 잠실점");
});

test("listStores: googleMapUrl도 함께 반환된다", () => {
  const list = store.listStores({});
  assert.ok(list.every((s) => typeof s.googleMapUrl === "string"));
});

test("getStore: 존재하지 않는 id는 null", () => {
  assert.equal(store.getStore("no-such-id"), null);
});

test("findStoreByName: 오타가 있어도 유사 매장을 찾는다", () => {
  const found = store.findStoreByName("롯데백화점");
  assert.ok(found);
  assert.equal(found.id, "lotte-jamsil");
});

test("searchBrandInStore: 브랜드를 찾으면 floorLabel/section을 포함해 반환", () => {
  const matches = store.searchBrandInStore("lotte-jamsil", "나이키");
  assert.ok(matches.length > 0);
  assert.equal(matches[0].name, "나이키");
  assert.equal(matches[0].floorLabel, "3층");
  assert.equal(matches[0].section, "스포츠 · 잡화");
});

test("searchBrandInStore: 존재하지 않는 매장이면 빈 배열", () => {
  assert.deepEqual(store.searchBrandInStore("no-such-id", "나이키"), []);
});

test("buildRoute: 찾은 브랜드까지 4단계 스크립트를 만든다", () => {
  const route = store.buildRoute("lotte-jamsil", "나이키");
  assert.equal(route.found, true);
  assert.equal(route.matchType, "brand");
  assert.equal(route.target.name, "나이키");
  assert.equal(route.target.floor, "3층");
  assert.equal(route.steps.length, 4);
});

test("buildRoute: 브랜드 실패 시 실제 층 태그(tags)로 카테고리 폴백한다", () => {
  const route = store.buildRoute("lotte-jamsil", "노란색 옷 사고 싶어요");
  assert.equal(route.found, true);
  assert.equal(route.matchType, "category");
  assert.equal(route.target.floor, "2층"); // tags에 "옷"이 포함된 여성 컨템포러리 층
});

test("buildRoute: 브랜드/카테고리 둘 다 실패하면 found:false", () => {
  const route = store.buildRoute("lotte-jamsil", "완전히 관련 없는 요청입니다");
  assert.equal(route.found, false);
});

test("buildRoute: 지하/동 단위 라벨도 '층' 중복 없이 그대로 쓰인다 (아울렛 A동)", () => {
  const route = store.buildRoute("outlet-yeoju", "나이키");
  assert.equal(route.found, true);
  assert.equal(route.target.floor, "A동");
});

test("getFloors: 매장의 층 목록을 화면 표시용으로 변환해 반환", () => {
  const floors = store.getFloors("lotte-jamsil");
  assert.equal(floors.length, 7);
  assert.equal(floors[0].label, "지하1층");
  assert.ok(floors[0].name.includes("지하1층"));
  assert.ok(Array.isArray(floors[0].brands));
  assert.equal(floors[0].brands[0].name, "베이커리");
});

test("findBrandAcrossStores: 여러 매장에 있는 브랜드는 여러 결과로 반환된다 (나이키: 잠실/여주)", () => {
  const results = store.findBrandAcrossStores("나이키");
  const storeIds = results.map((r) => r.storeId);
  assert.ok(storeIds.includes("lotte-jamsil"));
  assert.ok(storeIds.includes("outlet-yeoju"));
});
