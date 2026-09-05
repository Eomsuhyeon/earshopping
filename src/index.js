const { createApp } = require("./server");
const config = require("./config");
const logger = require("./utils/logger");

/** 비밀값 자체는 절대 로그에 남기지 않고, 앞 4글자+길이만 보여준다 — 값이 통째로 잘못됐는지
 *  혹은 눈에 안 보이는 문자(개행 등)가 섞여 길이가 어긋났는지 정도는 사용자가 스스로 확인 가능하다. */
function maskSecret(value) {
  if (!value) return "미설정";
  return `${value.slice(0, 4)}***(길이 ${value.length})`;
}

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info("EarShopping 서버 시작", {
    port: config.port,
    env: config.nodeEnv,
    groq: config.groq.connected ? "연결됨" : "미설정(데모 모드)",
    groqModel: config.groq.model,
    groqKeyCheck: maskSecret(config.groq.apiKey),
    gemini: config.gemini.connected ? `연결됨(${config.gemini.model})` : "미설정",
    openrouter: config.openrouter.connected ? `연결됨(${config.openrouter.model})` : "미설정",
    ebay: config.ebay.connected ? `연결됨(${config.ebay.env})` : "미설정(데모 모드)",
    ebayClientIdCheck: maskSecret(config.ebay.clientId),
    ebaySecretCheck: maskSecret(config.ebay.clientSecret)
  });
});

/** 배포 환경(Docker/PM2 등)에서 SIGTERM을 보내도 진행 중인 요청을 끝내고 안전하게 종료 */
function shutdown(signal) {
  logger.info(`${signal} 수신 — 서버를 안전하게 종료합니다`);
  server.close(() => {
    logger.info("서버 종료 완료");
    process.exit(0);
  });
  // 10초 안에 안 끝나면 강제 종료
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("처리되지 않은 Promise 거부", { reason: reason?.message || String(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error("처리되지 않은 예외 — 프로세스를 종료합니다", { message: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = server;
