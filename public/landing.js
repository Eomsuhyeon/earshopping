(function(){
  "use strict";
  const el = (id) => document.getElementById(id);

  function speak(text, onend){
    try{
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ko-KR";
      if(onend) u.onend = onend;
      window.speechSynthesis.speak(u);
    }catch(e){ if(onend) onend(); }
  }

  function goOnline(){ window.location.href = "/online.html"; }
  function goOffline(){ window.location.href = "/offline.html"; }

  el("btnOnline").addEventListener("click", goOnline);
  el("btnOffline").addEventListener("click", goOffline);

  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  if(SpeechRecognitionCtor){
    recognizer = new SpeechRecognitionCtor();
    recognizer.lang = "ko-KR";
    recognizer.interimResults = false;
  }
  const micBtn = el("micBtn");
  let listening = false;

  function startListening(){
    if(!recognizer){ el("statusBar").textContent = "이 브라우저는 음성 인식을 지원하지 않아요. 버튼으로 선택해주세요."; return; }
    try{ recognizer.start(); listening = true; micBtn.classList.add("listening"); }catch(e){}
  }
  micBtn.addEventListener("click", startListening);
  document.addEventListener("keydown", (e) => {
    if(e.code === "Space"){ e.preventDefault(); startListening(); }
  });

  if(recognizer){
    recognizer.onresult = (e) => {
      const text = e.results[0][0].transcript;
      el("statusBar").textContent = `인식: "${text}"`;
      if(/온라인/.test(text)){ el("btnOnline").classList.add("armed"); speak("온라인으로 이동할게요.", goOnline); }
      else if(/오프라인/.test(text)){ el("btnOffline").classList.add("armed"); speak("오프라인 매장 안내로 이동할게요.", goOffline); }
      else { speak("온라인 또는 오프라인이라고 말씀해주세요."); }
    };
    recognizer.onend = () => { listening = false; micBtn.classList.remove("listening"); };
    recognizer.onerror = () => { listening = false; micBtn.classList.remove("listening"); };
  }

  speak("이어쇼핑입니다. 온라인 쇼핑을 하시려면 온라인, 백화점 매장 안내를 받으시려면 오프라인이라고 말씀해주세요.");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
