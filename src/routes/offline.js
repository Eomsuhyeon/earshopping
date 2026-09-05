const express = require("express");
const { z } = require("zod");

const store = require("../services/storeDataService");
const groq = require("../services/groqService");
const { classifyOfflineCommandFallback } = require("../services/commandService");
const { findBestMatches } = require("../utils/fuzzyMatch");

const router = express.Router();

/** GET /api/offline/stores?lat=&lng= — 안내서비스 우선, 그다음 거리순 매장 목록 */
router.get("/offline/stores", (req, res, next) => {
  try {
    const lat = req.query.lat ? Number(req.query.lat) : undefined;
    const lng = req.query.lng ? Number(req.query.lng) : undefined;
    res.json({ stores: store.listStores({ lat, lng }) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/offline/stores/:id — 매장 상세 (주소/전화/지도링크/층 요약) */
router.get("/offline/stores/:id", (req, res, next) => {
  try {
    const s = store.getStore(req.params.id);
    if (!s) return res.status(404).json({ error: "존재하지 않는 매장입니다." });
    const { floors, ...summary } = s;
    res.json({ ...summary, floorCount: floors.length });
  } catch (err) {
    next(err);
  }
});

/** GET /api/offline/stores/:id/floors — 층별 전체 안내용 데이터 */
router.get("/offline/stores/:id/floors", (req, res, next) => {
  try {
    const floors = store.getFloors(req.params.id);
    if (!floors.length) return res.status(404).json({ error: "존재하지 않는 매장이거나 층 정보가 없습니다." });
    res.json({ floors });
  } catch (err) {
    next(err);
  }
});

const SearchSchema = z.object({ query: z.string().trim().min(1).max(100) });

/** POST /api/offline/stores/:id/search — 브랜드명 퍼지 검색 (오타/발음 오차 허용) */
router.post("/offline/stores/:id/search", (req, res, next) => {
  try {
    const parsed = SearchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "query가 필요합니다." });
    const matches = store.searchBrandInStore(req.params.id, parsed.data.query);
    res.json({ matches, found: matches.length > 0 });
  } catch (err) {
    next(err);
  }
});

const RouteSchema = z.object({ destination: z.string().trim().min(1).max(100) });

/** POST /api/offline/stores/:id/route — 목적지까지 단계별 경로 스크립트 생성 */
router.post("/offline/stores/:id/route", (req, res, next) => {
  try {
    const parsed = RouteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "destination이 필요합니다." });
    const route = store.buildRoute(req.params.id, parsed.data.destination);
    if (!route) return res.status(404).json({ error: "존재하지 않는 매장입니다." });
    res.json(route);
  } catch (err) {
    next(err);
  }
});

/** GET /api/offline/brand-locations?brand= — 온라인→오프라인 연동: 모든 매장에서 해당 브랜드 검색 */
router.get("/offline/brand-locations", (req, res, next) => {
  try {
    const brand = (req.query.brand || "").trim();
    if (!brand) return res.status(400).json({ error: "brand 쿼리 파라미터가 필요합니다." });
    res.json({ locations: store.findBrandAcrossStores(brand) });
  } catch (err) {
    next(err);
  }
});

const CommandSchema = z.object({
  transcript: z.string().trim().min(1).max(300),
  screen: z.enum(["home", "store", "find", "result", "floors", "browse"]).default("home")
});

/** POST /api/offline/command — 화면 맥락을 반영한 오프라인 자연어 명령 분류 */
router.post("/offline/command", async (req, res, next) => {
  try {
    const parsed = CommandSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "잘못된 요청입니다.", details: parsed.error.flatten() });
    const { transcript, screen } = parsed.data;
    try {
      const result = await groq.classifyOfflineCommand(transcript, { screen });
      return res.json({ ...result, fallback: false });
    } catch (e) {
      const result = classifyOfflineCommandFallback(transcript, { screen });
      return res.json({ ...result, fallback: true, reason: e.message || e.code });
    }
  } catch (err) {
    next(err);
  }
});

const DescribeSceneSchema = z.object({
  detections: z.array(z.object({ class: z.string(), score: z.number().optional() })).max(20).default([]),
  dominantColor: z.string().nullable().optional(),
  personDetected: z.boolean().optional().default(false),
  garmentText: z.string().max(200).nullable().optional(),
  clothingCategory: z.string().max(50).nullable().optional()
});

const KOREAN_LABELS_FALLBACK = {
  person: "사람", chair: "의자", suitcase: "캐리어", backpack: "배낭",
  handbag: "핸드백", "cell phone": "휴대폰", bottle: "병", cup: "컵",
  "dining table": "테이블", bench: "벤치", "potted plant": "화분",
  umbrella: "우산", tie: "넥타이", book: "책", clock: "시계",
  laptop: "노트북", tv: "텔레비전", "traffic light": "신호등"
};

/**
 * POST /api/offline/browse/describe-scene
 * 클라이언트(브라우저)가 coco-ssd로 이미 인식한 사물 목록 + 색상 판별 결과를 받아
 * 한국어 상황 설명 문장을 만든다. 이미지 자체는 서버로 전송되지 않는다.
 */
router.post("/offline/browse/describe-scene", async (req, res, next) => {
  try {
    const parsed = DescribeSceneSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "잘못된 요청입니다.", details: parsed.error.flatten() });
    const { detections, dominantColor, personDetected, garmentText, clothingCategory } = parsed.data;

    try {
      const description = await groq.describeSceneWithGroq(detections, dominantColor, personDetected, garmentText, clothingCategory);
      return res.json({ description, fallback: false });
    } catch (e) {
      const labelsKr = detections.map((d) => KOREAN_LABELS_FALLBACK[d.class] || d.class);
      let colorPhrase = "";
      if (personDetected) {
        const itemPhrase = clothingCategory ? `${dominantColor ? dominantColor + " " : ""}${clothingCategory}` : "옷";
        colorPhrase = dominantColor || clothingCategory
          ? ` ${itemPhrase}을(를) 입은 사람이 가까이 있어요 (추정치예요).`
          : " 가까이에 사람이 있어요.";
      } else if (dominantColor) {
        colorPhrase = ` 주된 색상은 ${dominantColor}이에요.`;
      }
      const garmentPhrase = garmentText ? ` 옷에는 "${garmentText}" 라는 문구가 보여요.` : "";
      const sentence = labelsKr.length
        ? `${labelsKr.join(", ")}이(가) 보여요.${colorPhrase}${garmentPhrase}`
        : "특별히 인식되는 사물은 없어요.";
      return res.json({ description: sentence, fallback: true, reason: e.message || e.code });
    }
  } catch (err) {
    next(err);
  }
});

const ReadSignSchema = z.object({
  ocrText: z.string().trim().min(1).max(200),
  storeId: z.string().trim().min(1)
});

/** POST /api/offline/browse/read-sign — 클라이언트 OCR(Tesseract.js) 결과를 매장 브랜드 목록과 대조 */
router.post("/offline/browse/read-sign", (req, res, next) => {
  try {
    const parsed = ReadSignSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "잘못된 요청입니다.", details: parsed.error.flatten() });
    const { ocrText, storeId } = parsed.data;
    const matches = store.searchBrandInStore(storeId, ocrText);
    if (!matches.length) {
      return res.json({ matched: false, ocrText, message: "간판 글자를 인식했지만 매장 목록과 일치하는 곳을 찾지 못했어요." });
    }
    res.json({ matched: true, ocrText, brand: matches[0] });
  } catch (err) {
    next(err);
  }
});

const LandmarkRouteSchema = z.object({
  from: z.string().trim().min(1).max(100),
  to: z.string().trim().min(1).max(100)
});

/**
 * POST /api/offline/stores/:id/landmark-route
 * 카메라로 읽은 간판(from, 현재 위치로 추정되는 랜드마크)을 기준으로 목적지(to)까지
 * 최단 경로를 코드로 계산해서 반환한다. 경로 계산 자체는 storeDataService의 그래프 엔진이
 * 담당하고, 이 라우트는 입력 검증과 응답 형태만 다룬다 (LLM 미사용).
 */
router.post("/offline/stores/:id/landmark-route", (req, res, next) => {
  try {
    const parsed = LandmarkRouteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "from, to가 필요합니다.", details: parsed.error.flatten() });
    const { from, to } = parsed.data;
    const route = store.buildLandmarkRoute(req.params.id, from, to);
    if (!route) return res.status(404).json({ error: "존재하지 않는 매장입니다." });
    res.json(route);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
