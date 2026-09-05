/**
 * 매장 데이터 어댑터.
 *
 * 기본값은 로컬 JSON(src/data/stores.json)이다. Firebase Firestore를 실제로 연결하려면
 * 아래 loadStores() 함수 안의 "LOCAL JSON" 블록을 Firestore 조회 코드로 교체하면 된다.
 * 나머지 코드(거리 정렬, 퍼지 검색, 경로 생성)는 loadStores()가 반환하는 배열의
 * 형태(stores.json과 동일한 shape)만 유지되면 그대로 동작한다 — 이 파일이 유일한 교체 지점이다.
 *
 *   // Firestore로 교체할 경우 예시:
 *   // const { getFirestore } = require("firebase-admin/firestore");
 *   // const snapshot = await getFirestore().collection("stores").get();
 *   // return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
 */
const fs = require("fs");
const path = require("path");
const { findBestMatches } = require("../utils/fuzzyMatch");
const routeGraph = require("./routeGraphService");

const DATA_PATH = path.join(__dirname, "..", "data", "stores.json");

function loadStores() {
  // ---- LOCAL JSON (기본값) ----
  const raw = fs.readFileSync(DATA_PATH, "utf-8");
  return JSON.parse(raw).stores;
  // ---- /LOCAL JSON ----
}

/** 두 좌표 간 거리(km), 하버사인 공식 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 안내서비스 제공 여부 우선, 그다음 거리순으로 매장 목록 반환 */
function listStores({ lat, lng } = {}) {
  const stores = loadStores();
  const withDistance = stores.map((s) => ({
    id: s.id,
    name: s.name,
    address: s.address,
    phone: s.phone,
    hasGuideService: s.hasGuideService,
    mapUrl: s.mapUrl,
    googleMapUrl: s.googleMapUrl,
    distanceKm: lat != null && lng != null ? Math.round(haversineKm(lat, lng, s.lat, s.lng) * 10) / 10 : null
  }));
  return withDistance.sort((a, b) => {
    if (a.hasGuideService !== b.hasGuideService) return a.hasGuideService ? -1 : 1;
    if (a.distanceKm == null || b.distanceKm == null) return 0;
    return a.distanceKm - b.distanceKm;
  });
}

function getStore(storeId) {
  return loadStores().find((s) => s.id === storeId) || null;
}

/** 매장 이름으로도 찾을 수 있게 (편집거리 기반, "1번" 형태의 번호 선택은 라우트에서 처리) */
function findStoreByName(query) {
  const stores = loadStores();
  const matches = findBestMatches(query, stores, { key: "name", threshold: 0.4, limit: 1 });
  return matches[0] || null;
}

/**
 * 층 하나를 구역(section) 배열로 정규화한다. stores.json에 sections가 있으면 그대로 쓰고,
 * 없으면(아직 세분화 안 된 층) 층 전체를 구역 하나로 간주해 기존 데이터와 동일하게 동작시킨다.
 */
function getFloorSections(floor) {
  if (floor.sections && floor.sections.length) return floor.sections;
  return [{ name: floor.desc, position: null, brands: floor.brands, tags: floor.tags }];
}

/** 특정 매장 안에서 브랜드명 퍼지 검색. 층/구역/위치 정보를 포함해 반환 */
function searchBrandInStore(storeId, query) {
  const store = getStore(storeId);
  if (!store) return [];
  const allBrands = [];
  for (const floor of store.floors) {
    for (const section of getFloorSections(floor)) {
      for (const brandName of section.brands) {
        allBrands.push({
          name: brandName, floorLabel: floor.label, floorDesc: floor.desc,
          section: section.name, position: section.position
        });
      }
    }
  }
  return findBestMatches(query, allBrands, { key: "name", threshold: 0.45, limit: 5 });
}

/**
 * 상품군 질의(브랜드명이 아닌 "여성 옷", "화장품" 등)를 층 전체가 아니라 구역 단위로 찾는다.
 * 질문 속 단어와 겹치는 태그 개수(관련도)가 많은 구역일수록 위로 오도록 정렬해서,
 * 같은 상품군이 여러 층/구역에 걸쳐 있어도 첫 번째 하나만 반환하고 나머지를 누락시키지 않는다.
 */
function findMatchingSections(store, destinationQuery) {
  const q = destinationQuery.toLowerCase();
  const results = [];
  for (const floor of store.floors) {
    for (const section of getFloorSections(floor)) {
      const matchCount = (section.tags || []).filter((tag) => q.includes(tag.toLowerCase())).length;
      if (matchCount > 0) {
        results.push({
          floorLabel: floor.label, sectionName: section.name, position: section.position,
          brands: section.brands, matchCount
        });
      }
    }
  }
  return results.sort((a, b) => b.matchCount - a.matchCount);
}

/** 층 목록을 화면 표시용 형태로 변환 (label+desc를 사람이 읽는 이름으로 합침) */
function toFloorView(floor) {
  return {
    label: floor.label,
    name: `${floor.label} - ${floor.desc}`,
    brands: floor.brands.map((b) => ({ name: b, section: floor.desc, floorLabel: floor.label })),
    tags: floor.tags
  };
}

function getFloors(storeId) {
  const store = getStore(storeId);
  return store ? store.floors.map(toFloorView) : [];
}

/** 구역의 position 값(엘리베이터/에스컬레이터 기준)을 사람이 듣기 좋은 한 문장으로 변환 */
function formatPosition(position) {
  if (!position) return null;
  const parts = [];
  if (position.fromEscalator) parts.push(`에스컬레이터로 오셨으면 ${position.fromEscalator}`);
  if (position.fromElevator) parts.push(`엘리베이터로 오셨으면 ${position.fromElevator}`);
  return parts.length ? parts.join(", ") + "이에요." : null;
}

/**
 * 목적지(브랜드 또는 상품군)까지의 단계별 경로 스크립트를 만든다.
 * 실시간 좌표 기반 길찾기가 아니라, 저장된 매장 데이터를 바탕으로 한 결정적 스크립트다.
 *
 * 1) 먼저 브랜드명으로 정확히 찾아본다 (편집거리 기반).
 * 2) 브랜드로 못 찾으면, "노란색 옷 사고 싶어요" 같은 상품군 표현을 구역 단위 tags와 매칭한다.
 *    같은 상품군이 여러 층/구역에 걸쳐 있으면 관련도(겹치는 태그 수) 순으로 모두 안내한다.
 */
function buildRoute(storeId, destinationQuery) {
  const store = getStore(storeId);
  if (!store) return null;

  const matches = searchBrandInStore(storeId, destinationQuery);
  if (matches.length) {
    const target = matches[0];
    const positionText = formatPosition(target.position);
    const arrivalText = `${target.floorLabel}에서 내리시면, ${target.section}에 ${target.name} 매장이 있어요.` +
      (positionText ? ` ${positionText}` : "");
    const steps = [
      { title: "정문 안내", text: store.entranceDesc },
      { title: "엘리베이터 위치", text: store.elevatorDesc },
      { title: "도착", text: arrivalText },
      { title: "문의", text: "매장 앞에 도착하면 직원분께 도움을 요청하실 수 있어요." }
    ];
    return {
      found: true,
      storeId,
      matchType: "brand",
      target: { name: target.name, floor: target.floorLabel, section: target.section, position: target.position },
      steps
    };
  }

  // 브랜드로 못 찾았으면 상품군 표현을 구역 단위로 찾아, 관련도 높은 순으로 모두 안내
  const candidates = findMatchingSections(store, destinationQuery);
  if (candidates.length) {
    const top = candidates[0];
    const arrivalLines = candidates.slice(0, 3).map((c) => {
      const positionText = formatPosition(c.position);
      return `${c.floorLabel} ${c.sectionName}에 ${c.brands.join(", ")} 매장이 있어요.` +
        (positionText ? ` ${positionText}` : "");
    });
    const steps = [
      { title: "정문 안내", text: store.entranceDesc },
      { title: "엘리베이터 위치", text: store.elevatorDesc },
      { title: "도착", text: arrivalLines.join(" ") },
      { title: "문의", text: "구체적인 브랜드를 찾으시면 매장 이름을 다시 말씀해주세요." }
    ];
    return {
      found: true,
      storeId,
      matchType: "category",
      target: { name: `${top.floorLabel} - ${top.sectionName}`, floor: top.floorLabel, section: top.sectionName, position: top.position },
      candidates,
      steps
    };
  }

  return { found: false, storeId };
}

/** 모든 매장을 대상으로 브랜드를 검색 — 온라인에서 "매장에서 보고 싶어"라고 했을 때 사용 */
function findBrandAcrossStores(query) {
  const stores = loadStores();
  const results = [];
  for (const store of stores) {
    const matches = searchBrandInStore(store.id, query);
    for (const m of matches) {
      results.push({ storeId: store.id, storeName: store.name, hasGuideService: store.hasGuideService, ...m });
    }
  }
  return results.sort((a, b) => b.matchScore - a.matchScore);
}

/**
 * 카메라 OCR로 읽은 간판(랜드마크)을 기준으로 목적지까지 최단 경로를 계산한다.
 * 예: OCR이 "아디다스"를 읽었고 목적지가 "나이키"면, 매장 그래프에서 두 브랜드 노드 사이의
 * 최단 경로를 코드로 계산하고, 그 결과만 문장으로 옮긴다 — 실측 좌표가 없으므로 완전히
 * 정확한 실제 동선은 아니지만, "몇 층을 거쳐 어느 구역으로 가면 되는지"는 근거 있게 안내한다.
 */
function buildLandmarkRoute(storeId, fromBrandQuery, toBrandQuery) {
  const store = getStore(storeId);
  if (!store) return null;

  const graph = routeGraph.buildGraph(store);
  const brandCandidates = [...graph.nodes.entries()]
    .filter(([, n]) => n.type === "brand")
    .map(([id, n]) => ({ id, name: n.label }));

  const fromMatches = findBestMatches(fromBrandQuery, brandCandidates, { key: "name", threshold: 0.4, limit: 1 });
  const toMatches = findBestMatches(toBrandQuery, brandCandidates, { key: "name", threshold: 0.4, limit: 1 });
  if (!fromMatches.length || !toMatches.length) {
    return { found: false, storeId, missing: !fromMatches.length ? "from" : "to" };
  }

  const result = routeGraph.dijkstra(graph, fromMatches[0].id, toMatches[0].id);
  if (!result) return { found: false, storeId, missing: "path" };

  const steps = routeGraph.narratePath(graph, result.path);
  return {
    found: true,
    storeId,
    from: fromMatches[0].name,
    to: toMatches[0].name,
    steps,
    totalWeight: result.totalWeight
  };
}

module.exports = {
  listStores, getStore, findStoreByName, searchBrandInStore, getFloors, buildRoute,
  findBrandAcrossStores, buildLandmarkRoute, findMatchingSections
};
