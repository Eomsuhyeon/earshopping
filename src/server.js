const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const config = require("./config");
const logger = require("./utils/logger");

const searchProductsRoute = require("./routes/searchProducts");
const describeProductRoute = require("./routes/describeProduct");
const commandRoute = require("./routes/command");
const statusRoute = require("./routes/status");
const offlineRoute = require("./routes/offline");
const onlineExtrasRoute = require("./routes/onlineExtras");

// 카메라 AI 모드(coco-ssd/tesseract.js)가 <script> 태그와 fetch로 불러오는 CDN 목록.
// 실제 서비스에서 라이브러리 버전을 바꾸면 이 목록도 함께 업데이트해야 한다.
const AI_MODEL_CDN = ["https://cdn.jsdelivr.net", "https://storage.googleapis.com", "https://unpkg.com"];
// theme.css가 불러오는 웹폰트(Outfit, Noto Sans KR) CDN.
const FONT_STYLE_CDN = ["https://fonts.googleapis.com"];
const FONT_FILE_CDN = ["https://fonts.gstatic.com"];

function createApp() {
  const app = express();

  // 프록시(Vercel/Nginx 등) 뒤에서 실행될 때 rate-limit이 실제 클라이언트 IP를 보도록
  app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", "https://picsum.photos", "data:", "blob:"],
          styleSrc: ["'self'", "'unsafe-inline'", ...FONT_STYLE_CDN], // index.html의 인라인 <style> + 웹폰트 CSS 허용
          fontSrc: ["'self'", ...FONT_FILE_CDN],
          // TensorFlow.js(coco-ssd)는 초기화 시 내부적으로 eval()/new Function()을 실제로 실행한다
          // (wasm 지원 체크용 'wasm-unsafe-eval'과는 별개). 'unsafe-eval'이 없으면 이 초기화가
          // CSP 위반으로 조용히 실패해서 tf 전역 객체가 빈 채로 생성되고, 이후 coco-ssd.load()가
          // "a.loadGraphModel is not a function"으로 죽는다 — 사물 인식이 전혀 동작하지 않던 원인.
          scriptSrc: ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", ...AI_MODEL_CDN],
          // TF.js는 wasm 지원 여부를 체크할 때 작은 wasm 바이너리를 data: URI로 fetch한다.
          // data:가 없으면 이 내부 체크 자체가 CSP 위반으로 막혀서 모델 로드가 실패한다.
          connectSrc: ["'self'", "data:", ...AI_MODEL_CDN],
          mediaSrc: ["'self'", "blob:"], // 카메라 미리보기(getUserMedia)
          workerSrc: ["'self'", "blob:"] // tesseract.js 워커
        }
      }
    })
  );
  app.use(compression());
  app.use(morgan(config.isProduction ? "combined" : "dev"));
  app.use(express.json({ limit: "1mb" }));

  if (config.corsOrigins.length > 0) {
    app.use(cors({ origin: config.corsOrigins }));
    logger.info("CORS 허용 출처 설정됨", { origins: config.corsOrigins });
  }

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.rateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." }
  });
  app.use("/api", apiLimiter);

  app.use("/api", searchProductsRoute);
  app.use("/api", describeProductRoute);
  app.use("/api", commandRoute);
  app.use("/api", statusRoute);
  app.use("/api", offlineRoute);
  app.use("/api", onlineExtrasRoute);

  app.get("/health", (req, res) => {
    res.json({ ok: true, uptimeSec: Math.round(process.uptime()), env: config.nodeEnv });
  });

  app.use(express.static(path.join(__dirname, "..", "public")));

  // 정의되지 않은 /api 경로
  app.use("/api", (req, res) => res.status(404).json({ error: "존재하지 않는 API 경로입니다." }));

  // 중앙 에러 핸들러 — 모든 라우트의 next(err)이 여기로 모인다
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error("처리되지 않은 요청 오류", { message: err.message, stack: config.isProduction ? undefined : err.stack });
    const status = err.status || 500;
    res.status(status).json({
      error: config.isProduction ? "서버 오류가 발생했습니다." : err.message
    });
  });

  return app;
}

module.exports = { createApp };
