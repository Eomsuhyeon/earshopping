/**
 * 최소한의 구조화 로거. 외부 로깅 서비스(Datadog 등)로 교체하기 쉽도록
 * 이 파일 하나만 수정하면 되게 만들었다.
 */
const config = require("../config");

function base(level, msg, meta) {
  const entry = { level, msg, time: new Date().toISOString(), ...(meta || {}) };
  const line = config.isProduction ? JSON.stringify(entry) : `[${entry.time}] ${level.toUpperCase()} ${msg}` + (meta ? " " + JSON.stringify(meta) : "");
  if (level === "error") console.error(line);
  else console.log(line);
}

module.exports = {
  info: (msg, meta) => base("info", msg, meta),
  warn: (msg, meta) => base("warn", msg, meta),
  error: (msg, meta) => base("error", msg, meta)
};
