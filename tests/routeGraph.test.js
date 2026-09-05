const { test } = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/services/storeDataService");
const routeGraph = require("../src/services/routeGraphService");

test("buildLandmarkRoute: 같은 층 브랜드 간에는 층 이동 단계가 없다", () => {
  const route = store.buildLandmarkRoute("lotte-jamsil", "아디다스", "나이키");
  assert.equal(route.found, true);
  assert.equal(route.from, "아디다스");
  assert.equal(route.to, "나이키");
  const hasFloorMove = route.steps.some((s) => s.title === "이동");
  assert.equal(hasFloorMove, false, "같은 층이면 이동 단계가 없어야 함");
});

test("buildLandmarkRoute: 다른 층 브랜드 간에는 층 이동 단계가 포함되고 순서가 맞다", () => {
  const route = store.buildLandmarkRoute("lotte-jamsil", "샤넬", "나이키"); // 1층 -> 3층
  assert.equal(route.found, true);
  const moveSteps = route.steps.filter((s) => s.title === "이동");
  assert.equal(moveSteps.length, 2, "1층->3층은 2번의 층 이동을 거쳐야 함");
  assert.match(moveSteps[0].text, /1층에서 2층/);
  assert.match(moveSteps[1].text, /2층에서 3층/);
});

test("buildLandmarkRoute: 존재하지 않는 브랜드면 found:false", () => {
  const route = store.buildLandmarkRoute("lotte-jamsil", "완전존재안함", "나이키");
  assert.equal(route.found, false);
  assert.equal(route.missing, "from");
});

test("buildLandmarkRoute: 목적지가 존재하지 않으면 missing이 'to'", () => {
  const route = store.buildLandmarkRoute("lotte-jamsil", "나이키", "완전존재안함");
  assert.equal(route.found, false);
  assert.equal(route.missing, "to");
});

test("buildLandmarkRoute: 출발지와 목적지가 같으면 이동 없이 바로 도착 취급", () => {
  const route = store.buildLandmarkRoute("lotte-jamsil", "나이키", "나이키");
  assert.equal(route.found, true);
  assert.equal(route.totalWeight, 0);
});

test("routeGraphService.dijkstra: 존재하지 않는 노드 id면 null", () => {
  const graph = routeGraph.buildGraph({ floors: [{ label: "1층", desc: "테스트", brands: ["A"] }] });
  assert.equal(routeGraph.dijkstra(graph, "brand:0:없음", "brand:0:A"), null);
});

test("routeGraphService.buildGraph: 브랜드는 목록 내 순번+1 가중치로 허브에 연결된다", () => {
  const graph = routeGraph.buildGraph({ floors: [{ label: "1층", desc: "테스트", brands: ["A", "B", "C"] }] });
  const floorEdges = graph.edges.get("floor:0");
  const edgeToA = floorEdges.find((e) => e.to === "brand:0:A");
  const edgeToC = floorEdges.find((e) => e.to === "brand:0:C");
  assert.equal(edgeToA.weight, 1);
  assert.equal(edgeToC.weight, 3);
});

test("여주 아울렛(A동/B동 표기)에서도 그래프 경로가 정상 계산된다", () => {
  const route = store.buildLandmarkRoute("outlet-yeoju", "나이키", "폴로"); // A동 -> B동
  assert.equal(route.found, true);
  const moveSteps = route.steps.filter((s) => s.title === "이동");
  assert.equal(moveSteps.length, 1);
  assert.match(moveSteps[0].text, /A동에서 B동/);
});
