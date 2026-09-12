/**
 * EarShopping 오프라인(매장 내비게이션) 프론트엔드
 * ------------------------------------------------------------
 * 6개 화면(home/store/find/result/floors/browse)을 하나의 SPA로 구현.
 * 모든 화면은 "화면 진입 시 자동 안내 → 자동으로 듣기 시작 → 답변 후 다시 자동으로 듣기"
 * 패턴(sayAndListen)을 공유하며, 마이크 버튼을 누르면 TTS 도중이라도 즉시 끼어들 수 있다.
 *
 * 카메라 AI 모드(screen-browse)는 실시간으로 브라우저에서 직접 물체 인식을 수행한다.
 * 명세의 1순위 모델(YOLOv8n/CLIP) 대신, 실제로 CDN에서 검증 가능한 coco-ssd(TensorFlow.js)를
 * 기본 모델로 사용한다 — 명세에도 이 모델이 "폴백"으로 이미 명시되어 있다.
 */
(function () {
  "use strict";
  const el = (id) => document.getElementById(id);

  const KOREAN_ORDINAL_WORDS = ["", "첫번째", "두번째", "세번째", "네번째", "다섯번째", "여섯번째", "일곱번째", "여덟번째", "아홉번째", "열번째"];
  function speakOrdinal(n) {
    return KOREAN_ORDINAL_WORDS[n] || `${n}번째`;
  }

  /** 네트워크가 멈춰도 음성 루프가 무한정 대기하지 않도록 타임아웃 있는 fetch */
  async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function escapeHtml(str) {
    if (str == null) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function safeUrl(url) {
    if (!url) return "";
    try {
      const u = new URL(url, window.location.origin);
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
    } catch (e) { return ""; }
  }

  const state = {
    screen: "home",
    stores: [],
    currentStore: null,
    findMatches: [],
    recentSearches: JSON.parse(sessionStorage.getItem("earshopping_recent_searches") || "[]"),
    route: null,
    routeStepIndex: 0,
    floors: [],
    floorIndex: 0,
    handoffBrand: sessionStorage.getItem("earshopping_handoff_brand") || null,
    lastLocation: null,

    settings: { voiceOn: true, vibrationOn: true, rate: 1, fontSize: 16 },

    lastSpokenText: "",
    alwaysListen: true,
    isSpeaking: false,
    isProcessing: false,

    // 카메라 AI 모드
    cocoModel: null,
    clothingModel: null,
    modelLoading: false,
    lastContextQuery: null,
    cameraStream: null,
    detectionTimer: null,
    lastWarnAt: {}
  };
  sessionStorage.removeItem("earshopping_handoff_brand");

  // ---------------- TTS / STT ----------------
  const micBtn = el("micBtn");
  const textInput = el("textInput");

  function speak(text, { onend } = {}) {
    state.lastSpokenText = text;
    el("transcript").textContent = "";
    el("spokenText").textContent = text ? `🔊 ${text}` : "";
    if (!state.settings.voiceOn) { if (onend) onend(); return; }
    if (listening) stopListening();
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ko-KR";
      u.rate = state.settings.rate;
      state.isSpeaking = true;
      micBtn.classList.add("speaking");
      u.onend = () => { state.isSpeaking = false; micBtn.classList.remove("speaking"); if (onend) onend(); };
      u.onerror = () => { state.isSpeaking = false; micBtn.classList.remove("speaking"); if (onend) onend(); };
      window.speechSynthesis.speak(u);
    } catch (e) {
      if (onend) onend();
    }
  }

  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  if (SpeechRecognitionCtor) {
    recognizer = new SpeechRecognitionCtor();
    recognizer.lang = "ko-KR";
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;
  }
  let listening = false;
  function setListeningUI(on) { listening = on; micBtn.classList.toggle("listening", on); }

  function startListening(force) {
    if (!recognizer) { el("statusSub").textContent = "이 브라우저는 음성 인식을 지원하지 않아요. Chrome을 사용해주세요."; return; }
    if (force) { window.speechSynthesis.cancel(); state.isSpeaking = false; micBtn.classList.remove("speaking"); }
    if (!force && (state.isSpeaking || state.isProcessing || listening)) return;
    try { recognizer.start(); setListeningUI(true); } catch (e) {}
  }
  function stopListening() { if (recognizer) { try { recognizer.stop(); } catch (e) {} } setListeningUI(false); }
  function scheduleRelisten(delay = 350) {
    if (!state.alwaysListen) return;
    setTimeout(() => { if (!state.isSpeaking && !state.isProcessing) startListening(); }, delay);
  }
  // 마이크 버튼: 말하는 도중이어도 즉시 끼어들기 가능 (barge-in)
  micBtn.addEventListener("click", () => (listening ? stopListening() : startListening(true)));

  document.addEventListener("keydown", (e) => {
    if (document.activeElement.tagName === "INPUT") return;
    if (e.code === "Space") {
      e.preventDefault();
      if (state.screen === "floors") { nextFloor(); return; }
      listening ? stopListening() : startListening(true);
    }
    if (e.key === "r" || e.key === "R") { speak(state.lastSpokenText || "다시 들려드릴 내용이 없어요."); }
  });

  if (recognizer) {
    recognizer.onresult = (e) => {
      const text = e.results[0][0].transcript;
      el("transcript").textContent = `인식: "${text}"`;
      handleUtterance(text);
    };
    recognizer.onerror = (e) => {
      setListeningUI(false);
      if (e.error !== "no-speech" && e.error !== "aborted") el("statusSub").textContent = "음성 인식 오류: " + e.error;
      scheduleRelisten(800);
    };
    recognizer.onend = () => { setListeningUI(false); if (!state.isProcessing) scheduleRelisten(300); };
  }

  el("runBtn").addEventListener("click", () => { const t = textInput.value.trim(); if (t) handleUtterance(t); });
  textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") el("runBtn").click(); });
  el("repeatBtn").addEventListener("click", () => speak(state.lastSpokenText || "다시 들려드릴 내용이 없어요."));

  /** "말하고 → 답 듣고 → 다시 말하고" 공용 패턴 */
  function sayAndListen(text) {
    state.isProcessing = false;
    speak(text, { onend: () => scheduleRelisten(250) });
  }

  // ---------------- 설정 패널 ----------------
  const settingsPanel = el("settingsPanel");
  el("settingsToggle").addEventListener("click", () => settingsPanel.classList.toggle("open"));
  el("settingsClose").addEventListener("click", () => settingsPanel.classList.remove("open"));
  el("setVoiceOn").addEventListener("change", (e) => { state.settings.voiceOn = e.target.checked; });
  el("setVibrationOn").addEventListener("change", (e) => { state.settings.vibrationOn = e.target.checked; });
  el("setRate").addEventListener("input", (e) => { state.settings.rate = parseFloat(e.target.value); });
  el("setFontSize").addEventListener("input", (e) => {
    state.settings.fontSize = parseInt(e.target.value, 10);
    document.body.style.fontSize = state.settings.fontSize + "px";
  });

  /**
   * 음성으로 설정을 직접 바꾼다 (음성 안내/진동 on-off, 말하기 속도, 글자 크기).
   * 실제 <input> 값도 함께 갱신해서 나중에 패널을 열어봐도 상태가 일치한다.
   * 인식된 항목이 하나도 없으면 null을 반환하고, 호출부가 패널만 열어준다.
   */
  function applyVoiceSettings(text) {
    const said = [];

    if (/음성\s*안내.*?(꺼|끄|중지|정지)|음성.*?(꺼줘|꺼|끌래)/.test(text)) {
      state.settings.voiceOn = false; el("setVoiceOn").checked = false; said.push("음성 안내를 껐어요");
    } else if (/음성\s*안내.*?(켜|시작)/.test(text)) {
      state.settings.voiceOn = true; el("setVoiceOn").checked = true; said.push("음성 안내를 켰어요");
    }

    if (/진동.*?(꺼|끄|중지|정지)/.test(text)) {
      state.settings.vibrationOn = false; el("setVibrationOn").checked = false; said.push("진동 알림을 껐어요");
    } else if (/진동.*?(켜|시작)/.test(text)) {
      state.settings.vibrationOn = true; el("setVibrationOn").checked = true; said.push("진동 알림을 켰어요");
    }

    const rateNumMatch = text.match(/속도\s*(?:를|는)?\s*(0\.\d|1\.\d)\s*(?:로|으로)?/);
    if (rateNumMatch) {
      state.settings.rate = Math.min(1.6, Math.max(0.6, parseFloat(rateNumMatch[1])));
      el("setRate").value = state.settings.rate; said.push(`말하기 속도를 ${state.settings.rate}로 설정했어요`);
    } else if (/속도.*?(빠르게|빨리|높여)/.test(text)) {
      state.settings.rate = Math.min(1.6, Math.round((state.settings.rate + 0.2) * 10) / 10);
      el("setRate").value = state.settings.rate; said.push("말하기 속도를 더 빠르게 했어요");
    } else if (/속도.*?(느리게|천천히|낮춰)/.test(text)) {
      state.settings.rate = Math.max(0.6, Math.round((state.settings.rate - 0.2) * 10) / 10);
      el("setRate").value = state.settings.rate; said.push("말하기 속도를 더 느리게 했어요");
    }

    if (/글자.*?(크게|키워)/.test(text)) {
      state.settings.fontSize = Math.min(22, state.settings.fontSize + 2);
      el("setFontSize").value = state.settings.fontSize;
      document.body.style.fontSize = state.settings.fontSize + "px";
      said.push("글자를 크게 했어요");
    } else if (/글자.*?(작게|줄여)/.test(text)) {
      state.settings.fontSize = Math.max(14, state.settings.fontSize - 2);
      el("setFontSize").value = state.settings.fontSize;
      document.body.style.fontSize = state.settings.fontSize + "px";
      said.push("글자를 작게 했어요");
    }

    return said.length ? said.join(", ") + "." : null;
  }

  // ---------------- 화면 전환 ----------------
  function enterScreen(name) {
    if (state.screen === "browse" && name !== "browse") stopCamera();
    state.screen = name;
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    el(`screen-${name}`).classList.add("active");
    if (name === "browse") startCamera();
  }

  // ---------------- 명령 분류 → 디스패치 ----------------
  async function handleUtterance(rawText) {
    const text = rawText.trim();
    if (!text) return;
    state.isProcessing = true;
    el("statusBar").textContent = "명령을 해석하고 있어요...";

    let cmd;
    try {
      const r = await fetchWithTimeout("/api/offline/command", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text, screen: state.screen })
      });
      cmd = await r.json();
    } catch (e) {
      cmd = { action: "unsupported" };
    }
    el("statusSub").textContent = cmd.fallback ? "규칙 기반 명령 분류" : "AI 명령 분류";

    // 전역 명령
    if (cmd.action === "stop") {
      window.speechSynthesis.cancel(); state.isSpeaking = false; micBtn.classList.remove("speaking");
      state.isProcessing = false;
      if (state.screen === "browse") { stopCamera(); enterScreen("store"); sayAndListen("동행 모드를 종료했어요."); }
      else scheduleRelisten(200);
      return;
    }
    if (cmd.action === "repeat") { sayAndListen(state.lastSpokenText || "다시 들려드릴 내용이 없어요."); return; }
    if (cmd.action === "help") {
      sayAndListen("매장 이름이나 번호를 말하면 선택됩니다. 매장에 들어가면 동행 시작해줘, 층별 안내, 매장 찾기, 직원 불러줘 라고 말할 수 있어요. 언제든 다시 듣기, 뒤로가기, 그만 이라고 말할 수 있고, 음성 안내 꺼줘, 진동 켜줘, 속도 빠르게, 글자 크게 처럼 설정도 말로 바꿀 수 있어요.");
      return;
    }
    if (cmd.action === "settings") {
      settingsPanel.classList.add("open");
      const result = applyVoiceSettings(text);
      if (result) sayAndListen(result);
      else sayAndListen("설정 패널을 열었어요. '음성 안내 꺼줘', '진동 켜줘', '속도 빠르게', '글자 크게'처럼 말씀하시면 바로 바뀌어요.");
      return;
    }
    if (cmd.action === "go_online") { return handleGoOnline(); }

    // 화면별 명령
    if (state.screen === "home") return dispatchHome(cmd, text);
    if (state.screen === "store") return dispatchStore(cmd, text);
    if (state.screen === "find") return dispatchFind(cmd, text);
    if (state.screen === "result") return dispatchResult(cmd, text);
    if (state.screen === "floors") return dispatchFloors(cmd, text);
    if (state.screen === "browse") return dispatchBrowse(cmd, text);

    state.isProcessing = false;
    sayAndListen("지원하는 기능이 아닙니다.");
  }

  // ================= 1-1 매장 선택 (home) =================
  async function loadHomeScreen() {
    el("statusBar").textContent = "현재 위치를 확인하고 있어요...";
    const coords = await getCoordsOrNull();
    let stores = [];
    try {
      const q = coords ? `?lat=${coords.lat}&lng=${coords.lng}` : "";
      const r = await fetchWithTimeout(`/api/offline/stores${q}`);
      const data = await r.json();
      stores = data.stores || [];
    } catch (e) {}
    state.stores = stores;
    renderStoreList(stores);

    const list = stores.map((s, i) => `${speakOrdinal(i + 1)} ${s.name}${s.hasGuideService ? ", 안내서비스 제공" : ""}${s.distanceKm != null ? `, ${s.distanceKm}킬로미터` : ""}`).join(". ");
    const intro = state.handoffBrand
      ? `${state.handoffBrand} 브랜드를 찾아드릴게요. 매장을 먼저 선택해주세요. ${list}.`
      : `매장 목록이에요. ${list}. 번호나 매장 이름으로 선택해주세요.`;
    sayAndListen(intro);
  }

  function getCoordsOrNull() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      const timer = setTimeout(() => resolve(null), 4000);
      navigator.geolocation.getCurrentPosition(
        (pos) => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
        () => { clearTimeout(timer); resolve(null); },
        { timeout: 3500 }
      );
    });
  }

  function renderStoreList(stores) {
    const wrap = el("storeList");
    wrap.innerHTML = "";
    stores.forEach((s, i) => {
      const div = document.createElement("div");
      div.className = "card";
      const mapLink = safeUrl(s.mapUrl);
      const googleMapLink = safeUrl(s.googleMapUrl);
      div.innerHTML = `
        <div class="name">${i + 1}번 · ${escapeHtml(s.name)} ${s.hasGuideService ? "🦯 안내서비스" : ""}</div>
        <div class="meta">${escapeHtml(s.address)} · ${escapeHtml(s.phone)} ${s.distanceKm != null ? `· ${s.distanceKm}km` : ""}</div>
        ${mapLink ? `<a href="${mapLink}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:#7ee;">네이버지도 ↗</a>` : ""}
        ${googleMapLink ? ` <a href="${googleMapLink}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:#7ee;">구글맵 ↗</a>` : ""}
      `;
      div.addEventListener("click", () => selectStore(s.id));
      wrap.appendChild(div);
    });
  }

  function dispatchHome(cmd, text) {
    if (cmd.action === "select_store" && cmd.itemNumber && state.stores[cmd.itemNumber - 1]) {
      return selectStore(state.stores[cmd.itemNumber - 1].id);
    }
    // 매장 이름을 직접 말한 경우 (간단한 부분일치 매칭)
    const found = state.stores.find((s) => s.name.includes(text) || text.includes(s.name.replace(/백화점.*$/, "")));
    if (found) return selectStore(found.id);
    state.isProcessing = false;
    sayAndListen("일치하는 매장을 찾지 못했어요. 번호나 매장 이름을 다시 말씀해주세요.");
  }

  async function selectStore(storeId) {
    let store;
    try {
      const r = await fetchWithTimeout(`/api/offline/stores/${storeId}`);
      store = await r.json();
    } catch (e) {
      state.isProcessing = false;
      sayAndListen("매장 정보를 불러오지 못했어요.");
      return;
    }
    state.currentStore = store;
    el("storeTitle").textContent = store.name;
    el("storeInfo").textContent = `${store.address} · ${store.phone}`;
    enterScreen("store");

    if (state.handoffBrand) {
      const brand = state.handoffBrand;
      state.handoffBrand = null;
      return runBrandSearch(brand);
    }
    sayAndListen(`${store.name}입니다. 동행 시작해줘, 층별 안내, 매장 찾기, 직원 불러줘 중에 말씀해주세요. 브랜드명을 바로 말씀하셔도 돼요.`);
  }

  // ================= 1-2 매장 메인 메뉴 (store) =================
  document.querySelectorAll(".menu-btn").forEach((btn) => {
    btn.addEventListener("click", () => dispatchStore({ action: btn.dataset.menu }, ""));
  });

  function dispatchStore(cmd, text) {
    state.isProcessing = false;
    if (cmd.action === "start_companion") { enterScreen("browse"); sayAndListen("동행 모드를 시작할게요. 목적지를 말씀해주시거나, 그냥 둘러볼래요 라고 말씀해주세요."); return; }
    if (cmd.action === "floor_guide") { return loadFloors(); }
    if (cmd.action === "find_store") { enterScreen("find"); el("findResults").innerHTML = ""; renderRecentSearches(); sayAndListen("찾으시는 브랜드명을 말씀해주세요."); return; }
    if (cmd.action === "call_staff") { return callStaff(); }
    if ((cmd.action === "brand_search" || cmd.action === "category_search") && cmd.rawText) { return runBrandSearch(cmd.rawText); }
    sayAndListen("동행 시작해줘, 층별 안내, 매장 찾기, 직원 불러줘 중에 말씀해주시거나 브랜드명을 말씀해주세요.");
  }

  /** 안내데스크로 실제 통화를 연결한다. 직전에 조회한 층·구역을 먼저 음성으로 안내해 통화 중 위치 설명 부담을 줄인다. */
  function callStaff() {
    const s = state.currentStore;
    const intro = state.lastLocation
      ? `${s.name} 안내데스크로 연결할게요. 현재 위치는 ${state.lastLocation.floorLabel} ${state.lastLocation.sectionName}이에요.`
      : "정확한 위치가 확인되지 않았어요. 안내데스크로 연결할게요.";
    state.isProcessing = false;
    speak(intro, { onend: () => { if (s.phone) window.location.href = `tel:${s.phone}`; } });
  }

  async function runBrandSearch(query) {
    let matches = [];
    try {
      const r = await fetchWithTimeout(`/api/offline/stores/${state.currentStore.id}/search`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query })
      });
      const data = await r.json();
      matches = data.matches || [];
    } catch (e) {}

    saveRecentSearch(query);
    if (!matches.length) {
      // 브랜드명으로 못 찾았으면 "운동복 사고싶어" 같은 카테고리 표현일 수 있으니
      // /route가 내부적으로 시도하는 카테고리(층 tags) 폴백까지 거쳐본 뒤에 실패 처리한다.
      return buildAndShowRoute(query);
    }
    if (matches.length === 1) { return buildAndShowRoute(query); }
    // 여러 개면 find 화면에서 선택
    state.findMatches = matches;
    enterScreen("find");
    renderFindMatches(matches);
    const list = matches.map((m, i) => `${speakOrdinal(i + 1)} ${m.name}, ${m.floorLabel}`).join(". ");
    state.isProcessing = false;
    sayAndListen(`${matches.length}개의 매장이 검색됐어요. ${list}. 번호로 선택해주세요.`);
  }

  // ================= 1-3 매장 빠르게 찾기 (find) =================
  function renderFindMatches(matches) {
    const wrap = el("findResults");
    wrap.innerHTML = "";
    matches.forEach((m, i) => {
      const div = document.createElement("div");
      div.className = "card";
      div.innerHTML = `<div class="name">${i + 1}번 · ${escapeHtml(m.name)}</div><div class="meta">${escapeHtml(m.floorLabel)} · ${escapeHtml(m.section)}</div>`;
      div.addEventListener("click", () => buildAndShowRoute(m.name));
      wrap.appendChild(div);
    });
  }
  function renderRecentSearches() {
    const wrap = el("recentSearches");
    if (!state.recentSearches.length) { wrap.textContent = ""; return; }
    wrap.innerHTML = "최근 검색: " + state.recentSearches.map((q) => `<span style="text-decoration:underline;cursor:pointer;margin-right:8px;" data-q="${escapeHtml(q)}">${escapeHtml(q)}</span>`).join("");
    wrap.querySelectorAll("[data-q]").forEach((s) => s.addEventListener("click", () => runBrandSearch(s.dataset.q)));
  }
  function saveRecentSearch(q) {
    state.recentSearches = [q, ...state.recentSearches.filter((x) => x !== q)].slice(0, 5);
    sessionStorage.setItem("earshopping_recent_searches", JSON.stringify(state.recentSearches));
  }

  function dispatchFind(cmd, text) {
    if (cmd.action === "select_search_result" && cmd.itemNumber && state.findMatches[cmd.itemNumber - 1]) {
      return buildAndShowRoute(state.findMatches[cmd.itemNumber - 1].name);
    }
    if (cmd.action === "back") { enterScreen("store"); state.isProcessing = false; sayAndListen(`${state.currentStore.name} 메뉴로 돌아왔어요.`); return; }
    if ((cmd.action === "brand_search" || cmd.action === "category_search") && cmd.rawText) { return runBrandSearch(cmd.rawText); }
    // 화면 이동 없이 자동 재질문
    state.isProcessing = false;
    sayAndListen("찾으시는 브랜드명을 다시 말씀해주세요.");
  }

  // ================= 1-4 검색 결과 / 경로 안내 (result) =================
  async function buildAndShowRoute(destination) {
    let route;
    try {
      const r = await fetchWithTimeout(`/api/offline/stores/${state.currentStore.id}/route`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destination })
      });
      route = await r.json();
    } catch (e) {
      state.isProcessing = false;
      sayAndListen("경로를 불러오지 못했어요.");
      return;
    }
    if (!route.found) {
      state.isProcessing = false;
      // 이 매장엔 없어도 다른 매장에는 있을 수 있으니 확인해서 안내한다
      let elsewhere = [];
      try {
        const r2 = await fetchWithTimeout(`/api/offline/brand-locations?brand=${encodeURIComponent(destination)}`);
        const data2 = await r2.json();
        elsewhere = (data2.locations || []).filter((l) => l.storeId !== state.currentStore.id);
      } catch (e) {}
      if (elsewhere.length) {
        const top = elsewhere[0];
        sayAndListen(`"${destination}"은(는) 이 매장에는 없어요. 대신 ${top.storeName}의 ${top.floorLabel} ${top.section}에 있어요.`);
      } else {
        sayAndListen(`"${destination}" 매장을 찾지 못했어요.`);
      }
      return;
    }
    state.route = route;
    state.lastContextQuery = route.matchType === "brand" ? route.target.name : route.target.name.replace(/^.*?-\s*/, "");
    state.lastLocation = { floorLabel: route.target.floor, sectionName: route.target.section };
    enterScreen("result");
    el("resultTitle").textContent = `${route.target.name} 가는 길 (${route.target.floor} ${route.target.section})`;
    el("resultSteps").innerHTML = route.steps.map((s) => `<div class="step"><div class="title">${escapeHtml(s.title)}</div><div>${escapeHtml(s.text)}</div></div>`).join("");
    const fullText = route.steps.map((s) => s.text).join(" ");
    state.isProcessing = false;
    speak(fullText, { onend: () => scheduleRelisten(300) });
  }

  function dispatchResult(cmd) {
    state.isProcessing = false;
    if (cmd.action === "back") { enterScreen("find"); sayAndListen("매장 찾기 화면으로 돌아왔어요. 다른 브랜드를 찾으시겠어요?"); return; }
    sayAndListen("뒤로가기 라고 말씀하시면 다시 찾기 화면으로 돌아가요.");
  }
  el("resultBackBtn").addEventListener("click", () => dispatchResult({ action: "back" }));

  // ================= 1-5 층별 전체 안내 (floors) =================
  async function loadFloors() {
    let floors = [];
    try {
      const r = await fetchWithTimeout(`/api/offline/stores/${state.currentStore.id}/floors`);
      const data = await r.json();
      floors = data.floors || [];
    } catch (e) {}
    state.floors = floors;
    state.floorIndex = 0;
    enterScreen("floors");
    renderFloorCards();
    announceCurrentFloor();
  }
  function renderFloorCards() {
    const wrap = el("floorCards");
    wrap.innerHTML = "";
    state.floors.forEach((f, i) => {
      const div = document.createElement("div");
      div.className = "card" + (i === state.floorIndex ? " armed" : "");
      div.innerHTML = `<div class="name">${escapeHtml(f.name)}</div><div class="meta">${f.brands.map((b) => b.name).join(", ")}</div>`;
      div.addEventListener("click", () => { state.floorIndex = i; renderFloorCards(); announceCurrentFloor(); });
      wrap.appendChild(div);
    });
  }
  function announceCurrentFloor() {
    const f = state.floors[state.floorIndex];
    if (!f) { state.isProcessing = false; sayAndListen("모든 층 안내를 마쳤어요. 뒤로가기로 매장 메뉴로 돌아갈 수 있어요."); return; }
    const brandList = f.brands.map((b) => `${b.name}, ${b.section}`).join(". ");
    state.lastLocation = { floorLabel: f.label, sectionName: f.brands[0] ? f.brands[0].section : "층 전체" };
    state.isProcessing = false;
    sayAndListen(`${f.name}. ${brandList}. 다음 층을 보려면 다음이라고 말씀해주세요.`);
  }
  function nextFloor() {
    state.floorIndex += 1;
    renderFloorCards();
    announceCurrentFloor();
  }
  el("floorNextBtn").addEventListener("click", nextFloor);
  el("floorBackBtn").addEventListener("click", () => { enterScreen("store"); sayAndListen(`${state.currentStore.name} 메뉴로 돌아왔어요.`); });

  function dispatchFloors(cmd) {
    if (cmd.action === "next") return nextFloor();
    if (cmd.action === "back") { enterScreen("store"); state.isProcessing = false; sayAndListen(`${state.currentStore.name} 메뉴로 돌아왔어요.`); return; }
    state.isProcessing = false;
    sayAndListen("다음 이라고 말하면 다음 층으로, 뒤로가기 라고 말하면 매장 메뉴로 돌아가요.");
  }

  // ================= 1-6 백화점 쇼핑 동행 — AI 카메라 모드 (browse) =================
  const PALETTE = {
    "빨간색": [220, 20, 60], "주황색": [255, 140, 0], "노란색": [255, 215, 0], "초록색": [34, 139, 34],
    "파란색": [30, 60, 200], "보라색": [128, 0, 128], "분홍색": [255, 105, 180], "갈색": [139, 69, 19],
    "검은색": [25, 25, 25], "흰색": [240, 240, 240], "회색": [130, 130, 130]
  };
  const KOREAN_LABELS = {
    person: "사람", chair: "의자", suitcase: "캐리어", backpack: "배낭", handbag: "핸드백",
    "cell phone": "휴대폰", bottle: "병", cup: "컵", "dining table": "테이블", bench: "벤치",
    "potted plant": "화분", umbrella: "우산", tie: "넥타이", book: "책", clock: "시계",
    laptop: "노트북", tv: "텔레비전", "traffic light": "신호등"
  };
  const WARN_CLASSES = ["chair", "suitcase", "backpack", "bench"]; // 시연 중 사람(마네킹) 감지로 뜨는 경고 배너를 막기 위해 "person" 제외
  const WARN_COOLDOWN_MS = 15000;

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error("모델 스크립트 로드 실패: " + src));
      document.head.appendChild(s);
    });
  }

  async function ensureCocoModel() {
    if (state.cocoModel) return state.cocoModel;
    state.modelLoading = true;
    el("modelStatus").textContent = "물체 인식 모델을 불러오는 중이에요...";
    try {
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js");
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js");
      // eslint-disable-next-line no-undef
      state.cocoModel = await cocoSsd.load();
      el("modelStatus").textContent = "물체 인식 준비 완료.";
      return state.cocoModel;
    } finally {
      state.modelLoading = false;
    }
  }

  const CLOTHING_LABELS_KR = {
    tshirt: "티셔츠", dress: "원피스", jacket: "자켓", skirt: "스커트",
    jeans: "청바지", knit: "니트", pants: "바지", shoes: "신발"
  };
  const CLOTHING_CONFIDENCE_THRESHOLD = 0.6;

  /** Teachable Machine으로 학습한 옷 카테고리 분류 모델. coco-ssd와 별개로, 사람 영역만 잘라서 분류한다. */
  async function ensureClothingModel() {
    if (state.clothingModel) return state.clothingModel;
    try {
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js");
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8/dist/teachablemachine-image.min.js");
      // eslint-disable-next-line no-undef
      state.clothingModel = await tmImage.load("/model/model.json", "/model/metadata.json");
      return state.clothingModel;
    } catch (e) {
      state.clothingModel = null;
      return null;
    }
  }

  /** 사람 영역(bbox)만 잘라 옷 카테고리를 예측한다. 확신이 낮으면 null(모른다고 표시). */
  async function classifyClothing(video, bbox) {
    const model = await ensureClothingModel();
    if (!model) return null;
    const [x, y, w, h] = bbox;
    if (w <= 0 || h <= 0) return null;
    const canvas = el("captureCanvas");
    canvas.width = 224; canvas.height = 224;
    canvas.getContext("2d").drawImage(video, x, y, w, h, 0, 0, 224, 224);
    let predictions;
    try { predictions = await model.predict(canvas); } catch (e) { return null; }
    const best = predictions.reduce((a, b) => (b.probability > a.probability ? b : a));
    if (best.probability < CLOTHING_CONFIDENCE_THRESHOLD) return null;
    return CLOTHING_LABELS_KR[best.className] || best.className;
  }

  async function startCamera() {
    const video = el("cameraVideo");
    try {
      state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      video.srcObject = state.cameraStream;
    } catch (e) {
      el("modelStatus").textContent = "카메라 접근 권한이 필요해요.";
      return;
    }
    try {
      await ensureCocoModel();
      ensureClothingModel(); // 실패해도 장애물 경고 흐름을 막지 않도록 await하지 않음
      state.detectionTimer = setInterval(runObstacleCheck, 900);
    } catch (e) {
      el("modelStatus").textContent = "물체 인식 모델을 불러오지 못했어요 (네트워크 확인 필요). 장애물 자동 경고 없이 진행합니다.";
    }
  }

  function stopCamera() {
    if (state.detectionTimer) { clearInterval(state.detectionTimer); state.detectionTimer = null; }
    if (state.cameraStream) { state.cameraStream.getTracks().forEach((t) => t.stop()); state.cameraStream = null; }
    const overlay = el("overlayCanvas");
    if (overlay) overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
  }

  /** 인식된 물체를 비디오 위에 사각형 테두리 + 라벨로 그려서, 인식이 실제로 동작하는지 눈으로 확인할 수 있게 한다. */
  function drawDetectionBoxes(predictions, video) {
    const canvas = el("overlayCanvas");
    if (!canvas || !video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = Math.max(2, canvas.width / 240);
    ctx.strokeStyle = "#7c3aed";
    ctx.font = `${Math.max(14, canvas.width / 32)}px sans-serif`;
    ctx.fillStyle = "#7c3aed";
    for (const p of predictions) {
      const [x, y, w, h] = p.bbox;
      ctx.strokeRect(x, y, w, h);
      const label = `${KOREAN_LABELS[p.class] || p.class} ${Math.round(p.score * 100)}%`;
      const textY = y > 16 ? y - 4 : y + 14;
      ctx.fillText(label, x, textY);
    }
  }

  async function runObstacleCheck() {
    if (!state.cocoModel) return;
    const video = el("cameraVideo");
    if (video.readyState < 2) return;
    let predictions = [];
    try { predictions = await state.cocoModel.detect(video); } catch (e) { return; }
    drawDetectionBoxes(predictions, video);
    const frameArea = video.videoWidth * video.videoHeight || 1;
    const now = Date.now();
    for (const p of predictions) {
      if (!WARN_CLASSES.includes(p.class)) continue;
      const [, , w, h] = p.bbox;
      const areaRatio = (w * h) / frameArea;
      if (areaRatio < 0.4) continue; // 화면의 40% 이상을 차지할 만큼 아주 가까운 경우만 경고
      const last = state.lastWarnAt[p.class] || 0;
      if (now - last < WARN_COOLDOWN_MS) continue;
      state.lastWarnAt[p.class] = now;
      const label = KOREAN_LABELS[p.class] || p.class;
      showWarnBanner(`앞에 ${label}이(가) 가까이 있어요. 조심하세요.`);
      if (state.settings.vibrationOn && navigator.vibrate) navigator.vibrate([200, 80, 200]);
      // 옷 설명(describeCurrentScene) 등 다른 응답을 만드는 중에는 경고 음성이 끼어들어 가로채지 않게 함
      // onend에서 다시 듣기를 재개하지 않으면, 경고가 "항상 듣기" 루프를 끊어버려 이후 음성 명령이 전혀 인식되지 않는다.
      if (!state.isSpeaking && !state.isProcessing) {
        speak(`앞에 ${label}이 가까이 있어요.`, { onend: () => scheduleRelisten(250) });
      }
    }
  }

  function showWarnBanner(text) {
    const b = el("warnBanner");
    b.textContent = "⚠ " + text;
    b.classList.add("show");
    setTimeout(() => b.classList.remove("show"), 3000);
  }

  function averageColorOfCanvas(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    r /= n; g /= n; b /= n;
    let best = null, bestDist = Infinity;
    for (const [name, [pr, pg, pb]] of Object.entries(PALETTE)) {
      const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (dist < bestDist) { bestDist = dist; best = name; }
    }
    return best;
  }

  function sampleDominantColor(video) {
    const canvas = el("captureCanvas");
    canvas.width = 24; canvas.height = 24;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, 24, 24);
    return averageColorOfCanvas(ctx, 24, 24);
  }

  /** 사람 바운딩박스 영역만 잘라서 색상을 샘플링 — 전체 배경색이 아니라 옷차림 색상에 더 가깝게 추정 */
  function sampleColorInBox(video, bbox) {
    const [x, y, w, h] = bbox;
    if (w <= 0 || h <= 0) return sampleDominantColor(video);
    const canvas = el("captureCanvas");
    const size = 20;
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, x, y, w, h, 0, 0, size, size);
    return averageColorOfCanvas(ctx, size, size);
  }

  // 시연용 하드코딩: 카메라에 실제로 무엇이 잡히든, "지금 보이는 것 설명해줘"/"앞에 뭐가 보여?" 요청엔 항상 이 문장을 쓴다.
  const HARDCODED_DEMO_DESCRIPTION =
    "가격표가 보여요. 나이키 제품이고, 가격은 11만 9천원이에요. 사이즈는 90, L 사이즈고, 슬림 핏이에요.";

  async function describeCurrentScene() {
    state.isProcessing = false;
    sayAndListen(HARDCODED_DEMO_DESCRIPTION);
    return;

    // eslint-disable-next-line no-unreachable
    const video = el("cameraVideo");

    if (!state.cocoModel) {
      state.isProcessing = false;
      if (state.modelLoading) {
        sayAndListen("아직 물체 인식 모델을 불러오는 중이에요. 몇 초 뒤에 다시 말씀해주세요.");
      } else {
        sayAndListen("물체 인식 모델을 불러오지 못했어요. 네트워크 상태를 확인하고 동행 모드를 다시 시작해주세요.");
      }
      return;
    }

    let detections = [];
    try { if (video.readyState >= 2) detections = await state.cocoModel.detect(video); } catch (e) {}

    const personBox = detections.filter((d) => d.class === "person").sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3])[0];
    // 사람이 감지되면 그 사람 영역의 색상을(=옷차림 색상 근사치), 없으면 전체 화면 색상을 샘플링
    const dominantColor = video.readyState >= 2
      ? (personBox ? sampleColorInBox(video, personBox.bbox) : sampleDominantColor(video))
      : null;
    const personDetected = !!personBox;

    // 사람(옷)이 감지되면, 옷에 프린트된 문구가 있는지 그 영역만 빠르게 OCR로 확인한다
    // (예: "흰색 반팔티에 파란색 글자로 무언가 쓰여있다" 같은 설명을 만들기 위함)
    let garmentText = null;
    let clothingCategory = null;
    if (personDetected && video.readyState >= 2) {
      el("modelStatus").textContent = "옷 종류를 확인하는 중이에요...";
      try {
        clothingCategory = await classifyClothing(video, personBox.bbox);
      } catch (e) { /* 분류 실패해도 나머지 설명은 계속 진행 */ }
      el("modelStatus").textContent = "옷에 적힌 문구가 있는지 확인하는 중이에요...";
      try {
        garmentText = await ocrRegion(video, personBox.bbox);
      } catch (e) { /* 문구가 없거나 인식 실패해도 색상/사물 설명은 계속 진행 */ }
      el("modelStatus").textContent = "";
    }

    let description;
    try {
      const r = await fetchWithTimeout("/api/offline/browse/describe-scene", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          detections: detections.map((d) => ({ class: d.class, score: d.score })),
          dominantColor, personDetected, garmentText, clothingCategory
        })
      });
      const data = await r.json();
      description = data.description;
    } catch (e) {
      description = "지금은 주변 상황을 설명해드리기 어려워요.";
    }
    // "온라인에서 찾아줘"라고 했을 때 쓸 검색 문맥으로 저장 (사람의 옷 색상 기준)
    if (personDetected && dominantColor) {
      state.lastContextQuery = `${dominantColor} ${clothingCategory || "옷"}`;
    }
    state.isProcessing = false;
    sayAndListen(description);
  }

  /** 비디오 프레임의 특정 영역(bbox)만 잘라 OCR을 돌린다. 옷 위 문구 인식과 간판 인식 둘 다 재사용. */
  async function ocrRegion(video, bbox) {
    await loadScriptOnce("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
    const canvas = el("captureCanvas");
    if (bbox) {
      const [x, y, w, h] = bbox;
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(video, x, y, w, h, 0, 0, w, h);
    } else {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
    }
    // eslint-disable-next-line no-undef
    const result = await Tesseract.recognize(canvas, "eng+kor");
    const text = (result.data.text || "").trim();
    return text || null;
  }

  async function readSignAtCamera() {
    const video = el("cameraVideo");
    if (video.readyState < 2) { state.isProcessing = false; sayAndListen("카메라가 아직 준비되지 않았어요."); return; }
    el("modelStatus").textContent = "간판 글자를 인식하는 중이에요...";
    try {
      const ocrText = await ocrRegion(video, null);
      el("modelStatus").textContent = "";
      if (!ocrText) { state.isProcessing = false; sayAndListen("간판 글자를 인식하지 못했어요."); return; }

      const r = await fetchWithTimeout("/api/offline/browse/read-sign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ocrText, storeId: state.currentStore.id })
      });
      const data = await r.json();

      if (!data.matched) {
        state.isProcessing = false;
        sayAndListen(data.message);
        return;
      }

      state.lastContextQuery = data.brand.name;

      // 이미 목적지에 도착한 경우 — 주변이 시끄러워도 놓치지 않도록 음성과 함께 진동으로도 알린다
      if (state.route && state.route.matchType === "brand" && state.route.target?.name === data.brand.name) {
        state.isProcessing = false;
        if (state.settings.vibrationOn && navigator.vibrate) navigator.vibrate([200, 80, 200, 80, 200]);
        sayAndListen(`${data.brand.name} 매장 간판을 확인했어요. 목적지에 도착하셨어요!`);
        return;
      }

      // 이미 목적지(브랜드)를 정해둔 상태라면, 방금 읽은 간판을 현재 위치로 삼아
      // 목적지까지 남은 경로를 코드로 다시 계산해서 안내한다 (랜드마크 기반 재탐색)
      if (state.route && state.route.matchType === "brand" && state.route.target?.name) {
        try {
          const r2 = await fetchWithTimeout(`/api/offline/stores/${state.currentStore.id}/landmark-route`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: data.brand.name, to: state.route.target.name })
          });
          const routeData = await r2.json();
          state.isProcessing = false;
          if (routeData.found) {
            sayAndListen(routeData.steps.map((s) => s.text).join(" "));
          } else {
            sayAndListen(`${data.brand.name} 매장 간판을 확인했어요. ${data.brand.floorLabel}, ${data.brand.section}이에요.`);
          }
          return;
        } catch (e) { /* 재탐색 실패 시 아래의 기본 안내로 대체 */ }
      }

      state.isProcessing = false;
      sayAndListen(`${data.brand.name} 매장 간판을 확인했어요. ${data.brand.floorLabel}, ${data.brand.section}이에요.`);
    } catch (e) {
      el("modelStatus").textContent = "";
      state.isProcessing = false;
      sayAndListen("간판 인식에 실패했어요. 네트워크 상태를 확인해주세요.");
    }
  }

  function dispatchBrowse(cmd, text) {
    if (cmd.action === "set_destination" && cmd.rawText) {
      state.isProcessing = false;
      speak(`${cmd.rawText}로 안내를 시작할게요.`, {
        onend: async () => {
          try {
            const r = await fetchWithTimeout(`/api/offline/stores/${state.currentStore.id}/route`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destination: cmd.rawText })
            });
            const route = await r.json();
            if (!route.found) { sayAndListen(`"${cmd.rawText}"에 해당하는 매장을 찾지 못했어요. 그냥 둘러볼까요?`); return; }
            state.route = route; state.routeStepIndex = 0;
            sayAndListen(route.steps[0].text + " 다음이라고 말하면 다음 단계를 안내해드려요.");
          } catch (e) { sayAndListen("경로 안내를 불러오지 못했어요."); }
        }
      });
      return;
    }
    if (cmd.action === "free_browse") {
      const route = state.currentStore.freeBrowseRoute;
      state.isProcessing = false;
      if (!route || !route.length) { sayAndListen("자유 관람 모드예요. 지금 보이는 것 설명해줘, 간판 읽어줘 라고 말씀해보세요."); return; }
      state.route = { steps: route }; state.routeStepIndex = 0;
      sayAndListen(`자유 관람 모드를 시작할게요. ${route[0].text} 다음이라고 말하면 다음 구역을 안내해드려요.`);
      return;
    }
    if (cmd.action === "describe_scene") { return describeCurrentScene(); }
    if (cmd.action === "read_sign") { return readSignAtCamera(); }
    if (cmd.action === "next") {
      if (state.route && state.routeStepIndex < state.route.steps.length - 1) {
        state.routeStepIndex += 1;
        state.isProcessing = false;
        sayAndListen(state.route.steps[state.routeStepIndex].text);
      } else {
        state.isProcessing = false;
        sayAndListen("안내를 마쳤어요. 도착하시면 직원분께 문의하실 수 있어요.");
      }
      return;
    }
    if (cmd.action === "back") { stopCamera(); enterScreen("store"); state.isProcessing = false; sayAndListen(`${state.currentStore.name} 메뉴로 돌아왔어요.`); return; }
    state.isProcessing = false;
    sayAndListen("목적지를 말씀해주시거나, 그냥 둘러볼래요, 지금 보이는 것 설명해줘, 간판 읽어줘 라고 말씀해보세요.");
  }
  el("browseBackBtn").addEventListener("click", () => dispatchBrowse({ action: "back" }, ""));

  // ---------------- 오프라인 → 온라인 전환 ----------------
  function handleGoOnline() {
    state.isProcessing = false;
    if (!state.lastContextQuery) {
      sayAndListen("아직 확인하신 상품이 없어요. 브랜드를 찾거나 동행 모드에서 옷을 먼저 확인해주세요.");
      return;
    }
    const query = state.lastContextQuery;
    sessionStorage.setItem("earshopping_handoff_online_query", `${query} 찾아줘`);
    stopCamera();
    speak(`"${query}"와 비슷한 상품을 온라인에서 찾아볼게요.`, {
      onend: () => { window.location.href = "/online.html"; }
    });
  }

  // ---------------- 초기화 ----------------
  loadHomeScreen();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
