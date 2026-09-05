/**
 * 매장 내부를 그래프로 모델링해서 "간판 A를 기준으로 매장 B까지 최단 경로"를 코드로 계산한다.
 * Groq(LLM)는 이 계산 결과를 자연스러운 문장으로 다듬는 역할만 하고, 경로 자체는 절대
 * LLM에게 맡기지 않는다 — 배치도를 잘못 해석하거나 없는 길을 지어낼 위험을 없애기 위함이다.
 *
 * 그래프 구성 (실제 좌표 도면이 없는 상태에서의 근사 모델):
 * - 층마다 "허브" 노드 하나 (엘리베이터/에스컬레이터가 있는 지점으로 간주)
 * - 그 층의 각 브랜드는 허브에 연결된 리프 노드 (허브로부터의 가중치 = 매장 목록 내 순번+1,
 *   "안쪽으로 몇 번째 매장인가"를 걷는 거리의 근사치로 사용)
 * - 인접한 두 층의 허브끼리는 고정 가중치(10)로 연결 (엘리베이터 이동 비용)
 */

function buildGraph(store) {
  const nodes = new Map(); // id -> { type: 'floor'|'brand', label, floorIndex, floorLabel, section }
  const edges = new Map(); // id -> [{ to, weight }]

  function addEdge(a, b, weight) {
    if (!edges.has(a)) edges.set(a, []);
    if (!edges.has(b)) edges.set(b, []);
    edges.get(a).push({ to: b, weight });
    edges.get(b).push({ to: a, weight });
  }

  store.floors.forEach((floor, floorIndex) => {
    const floorNodeId = `floor:${floorIndex}`;
    nodes.set(floorNodeId, { type: "floor", label: floor.label, section: floor.desc, floorIndex });

    floor.brands.forEach((brandName, brandIndex) => {
      const brandNodeId = `brand:${floorIndex}:${brandName}`;
      nodes.set(brandNodeId, {
        type: "brand", label: brandName, floorIndex, floorLabel: floor.label, section: floor.desc
      });
      addEdge(floorNodeId, brandNodeId, brandIndex + 1);
    });

    if (floorIndex > 0) {
      addEdge(`floor:${floorIndex - 1}`, floorNodeId, 10);
    }
  });

  return { nodes, edges };
}

/** 표준 다익스트라. 그래프가 작아서(수십 노드) 성능 걱정 없이 단순 구현으로 충분하다. */
function dijkstra(graph, startId, endId) {
  if (!graph.nodes.has(startId) || !graph.nodes.has(endId)) return null;
  const dist = new Map();
  const prev = new Map();
  for (const id of graph.nodes.keys()) dist.set(id, Infinity);
  dist.set(startId, 0);
  const remaining = new Set(graph.nodes.keys());

  while (remaining.size) {
    let current = null;
    let currentDist = Infinity;
    for (const id of remaining) {
      if (dist.get(id) < currentDist) { currentDist = dist.get(id); current = id; }
    }
    if (current === null) break;
    remaining.delete(current);
    if (current === endId) break;

    for (const { to, weight } of graph.edges.get(current) || []) {
      if (!remaining.has(to)) continue;
      const alt = dist.get(current) + weight;
      if (alt < dist.get(to)) {
        dist.set(to, alt);
        prev.set(to, current);
      }
    }
  }

  if (dist.get(endId) === Infinity) return null;
  const path = [];
  let cur = endId;
  while (cur !== undefined) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return { path, totalWeight: dist.get(endId) };
}

/** 계산된 경로(노드 id 배열)를 사람이 이해할 수 있는 단계별 안내 문장으로 바꾼다. */
function narratePath(graph, path) {
  const steps = [];
  let currentFloorLabel = null;

  path.forEach((nodeId, i) => {
    const node = graph.nodes.get(nodeId);
    if (node.type === "floor") {
      if (currentFloorLabel && currentFloorLabel !== node.label) {
        steps.push({
          title: "이동",
          text: `엘리베이터나 에스컬레이터를 타고 ${currentFloorLabel}에서 ${node.label}으로 이동하세요.`
        });
      }
      currentFloorLabel = node.label;
    } else if (node.type === "brand") {
      if (i === 0) {
        steps.push({
          title: "현재 위치",
          text: `${node.label} 매장(${node.floorLabel}, ${node.section})을 기준으로 안내를 시작할게요.`
        });
      } else if (i === path.length - 1) {
        steps.push({
          title: "도착",
          text: `${node.floorLabel}, ${node.section}에 도착하면 ${node.label} 매장이 있어요.`
        });
      }
    }
  });

  return steps;
}

module.exports = { buildGraph, dijkstra, narratePath };
