/* ATOM remote - voice. Tap the mic and talk: it stops by itself when you stop talking and sends.
 * Hold the mic to talk walkie-talkie style: let go to send. Tap ✕ to throw it away.
 *
 * Two engines, picked in Settings (Automatic by default):
 *   laptop - records the clip here (MediaRecorder) and ATOM transcribes it with Gemini. Works the same
 *            everywhere, including iPhone home-screen apps where the browser's speech recognition is flaky.
 *   phone  - the browser's own speech recognition: words appear live as you talk.
 * Automatic uses the laptop on iPhone/iPad and the phone engine elsewhere, and falls back to the laptop
 * engine by itself if the phone engine fails. */
(function () {
  "use strict";

  const KEY = "atom-voice-engine";
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const CAN_RECORD = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const HOLD_MS = 380;            // pressed longer than this = walkie-talkie
  const END_SILENCE = 1250;       // ms of quiet after speech that ends a tap-started recording
  const NO_SPEECH = 8000;         // give up if nothing is said
  const MAX_MS = 45000;
  const WARM_MS = 60000;          // keep the mic stream open this long after use: the next tap starts instantly

  const store = {
    get() { try { return localStorage.getItem(KEY) || "auto"; } catch (_) { return "auto"; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch (_) {} },
    broken() { try { return localStorage.getItem(KEY + "-phone-broken") === "1"; } catch (_) { return false; } },
    markBroken(on) { try { on ? localStorage.setItem(KEY + "-phone-broken", "1") : localStorage.removeItem(KEY + "-phone-broken"); } catch (_) {} },
  };
  function engine() {
    const pref = store.get();
    if (pref === "phone" && SR) return "phone";
    if (pref === "laptop" && CAN_RECORD) return "laptop";
    if (!CAN_RECORD) return SR ? "phone" : null;
    if (!SR || IOS || store.broken()) return "laptop";
    return "phone";
  }

  function pickMime() {
    const list = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } }) || "";
  }
  function blobToB64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] || "");
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }
  const haptic = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} };

  function init(o) {
    // o: { mic, cancel, bar, canvas, timer, input, composer, grow, toast, onText(text), onAudio({mime,data}), canSend() }
    const eng0 = engine();
    if (!eng0) return { engine, set: () => {} };
    o.mic.hidden = false;

    let session = null;           // the current listening session
    let stream = null, warmTimer = null, ctx = null;

    function ui(on, mode) {
      o.mic.classList.toggle("on", on);
      o.composer.classList.toggle("listening", on);
      o.composer.dataset.voice = on ? mode : "";
      o.cancel.hidden = !on;
      o.bar.hidden = !(on && mode === "laptop");
      o.mic.setAttribute("aria-label", on ? "Stop and send" : "Speak a command");
      if (o.send) o.send.disabled = on ? false : !o.input.value.trim();   // while listening, send = send now
      o.input.placeholder = on ? (mode === "phone" ? "Listening…" : "") : "Ask ATOM to do something…";
    }

    // ---- laptop engine: record + live waveform + voice-activity end -------------------------
    async function getStream() {
      clearTimeout(warmTimer);
      if (stream && stream.getAudioTracks().some((t) => t.readyState === "live")) return stream;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      return stream;
    }
    function releaseSoon() {
      clearTimeout(warmTimer);
      warmTimer = setTimeout(releaseNow, WARM_MS);
    }
    function releaseNow() {
      clearTimeout(warmTimer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }

    async function startLaptop(s) {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; ctx = AC ? new AC() : null; }
      if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});   // must happen inside the tap
      let st;
      try { st = await getStream(); }
      catch (e) {
        end(s);
        const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
        o.toast(denied ? "Allow the microphone for this app in Settings" : "Couldn't use the microphone");
        return;
      }
      if (s.dead) { releaseSoon(); return; }
      const mime = pickMime();
      let rec;
      try { rec = new MediaRecorder(st, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined); }
      catch (_) { rec = new MediaRecorder(st); }
      s.rec = rec; s.chunks = []; s.mime = rec.mimeType || mime || "audio/mp4";
      rec.ondataavailable = (e) => { if (e.data && e.data.size) s.chunks.push(e.data); };
      rec.onstop = () => finishLaptop(s);
      rec.start(250);
      s.t0 = performance.now();
      haptic(12);

      // level meter + "has the person stopped talking?"
      let an = null, buf = null;
      if (ctx) {
        try {
          const src = ctx.createMediaStreamSource(st);
          an = ctx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.2;
          src.connect(an); s.src = src;
          buf = new Float32Array(an.fftSize);
        } catch (_) { an = null; }
      }
      const levels = new Array(48).fill(0);
      let floor = 0.01, floorN = 0, spoke = false, lastLoud = performance.now();
      const g = o.canvas.getContext("2d");
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const tick = () => {
        if (s.dead || s.stopping) return;
        const now = performance.now(), el = now - s.t0;
        let rms = 0;
        if (an) {
          an.getFloatTimeDomainData(buf);
          for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
          rms = Math.sqrt(rms / buf.length);
          if (el < 300) { floor = (floor * floorN + rms) / (floorN + 1); floorN++; }
          const loud = rms > Math.max(0.018, floor * 3);
          if (loud) { lastLoud = now; if (el > 120) spoke = true; }
        } else { rms = 0.04 + 0.03 * Math.sin(now / 90); spoke = true; }
        s.spoke = spoke;
        levels.push(Math.min(1, rms * 9)); levels.shift();
        // draw
        const w = o.canvas.clientWidth, h = o.canvas.clientHeight;
        if (o.canvas.width !== Math.round(w * dpr)) { o.canvas.width = Math.round(w * dpr); o.canvas.height = Math.round(h * dpr); }
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        const n = levels.length, gap = 3, bw = Math.max(2, (w - gap * (n - 1)) / n);
        for (let i = 0; i < n; i++) {
          const v = levels[i], bh = Math.max(3, v * (h - 2));
          g.fillStyle = `rgba(255,255,255,${0.35 + 0.65 * (i / n)})`;
          const x = i * (bw + gap), y = (h - bh) / 2;
          g.beginPath(); g.roundRect ? g.roundRect(x, y, bw, bh, bw / 2) : g.rect(x, y, bw, bh); g.fill();
        }
        const sec = Math.floor(el / 1000);
        o.timer.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
        // auto end (not while holding)
        if (!s.holding) {
          if (spoke && now - lastLoud > END_SILENCE) return stop(true);
          if (!spoke && el > NO_SPEECH) { o.toast("Didn't hear anything"); return stop(false); }
        }
        if (el > MAX_MS) return stop(true);
        s.raf = requestAnimationFrame(tick);
      };
      s.raf = requestAnimationFrame(tick);
    }

    async function finishLaptop(s) {
      try { s.src && s.src.disconnect(); } catch (_) {}
      releaseSoon();
      const dur = performance.now() - (s.t0 || performance.now());
      const blob = new Blob(s.chunks, { type: s.mime });
      end(s);
      if (!s.send) return;
      if (!s.spoke || dur < 450 || blob.size < 1200) { o.toast("Didn't hear anything"); return; }
      if (blob.size > 650000) { o.toast("That was too long - keep it under 30 seconds"); return; }
      try { o.onAudio({ mime: s.mime.split(";")[0], data: await blobToB64(blob) }); haptic(8); }
      catch (_) { o.toast("Couldn't send the recording"); }
    }

    // ---- phone engine: the browser's speech recognition, live text ---------------------------
    function startPhone(s) {
      const base = o.input.value.trim();
      let finals = "", interim = "", restarts = 0, lastHeard = performance.now();
      s.t0 = performance.now();
      const text = () => [base, finals, interim].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      const show = () => { o.input.value = text(); o.grow(); };
      const begin = () => {
        const rec = new SR();
        rec.lang = navigator.language || "en-US";
        rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
        rec.onresult = (e) => {
          interim = "";
          let seg = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i], t = r[0].transcript.trim();
            if (r.isFinal) {
              // some browsers resend everything said so far as each new final: keep the newest copy only
              if (finals && t.toLowerCase().startsWith(finals.toLowerCase())) finals = t;
              else if (!finals.toLowerCase().endsWith(t.toLowerCase())) finals = (finals + " " + t).trim();
            } else seg += " " + t;
          }
          interim = seg.trim();
          if (finals && interim.toLowerCase().startsWith(finals.toLowerCase())) interim = interim.slice(finals.length).trim();
          s.spoke = true; lastHeard = performance.now();
          show();
        };
        rec.onerror = (e) => {
          s.err = e.error;
          if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture"
              || e.error === "network" || e.error === "language-not-supported") s.fatal = true;
        };
        rec.onend = () => {
          if (s.dead) return;
          if (s.fatal) {                                   // this phone's recognizer doesn't work here
            if (e2Laptop(s)) return;
            o.toast(s.err === "not-allowed" ? "Allow the microphone for this app in Settings" : "Voice isn't available here");
            return end(s);
          }
          if (s.stopping || (!s.holding && s.spoke && performance.now() - lastHeard > END_SILENCE - 200)) return finishPhone(s);
          if (restarts++ < 6 && performance.now() - s.t0 < MAX_MS) { try { begin(); } catch (_) { finishPhone(s); } return; }
          finishPhone(s);
        };
        s.rec = rec;
        rec.start();
      };
      s.text = text;
      try { begin(); } catch (_) { if (!e2Laptop(s)) { o.toast("Voice didn't start - try again"); end(s); } return; }
      haptic(12);
      const tick = () => {                                // silence timer (the recognizer's own is unreliable)
        if (s.dead || s.stopping) return;
        const now = performance.now();
        if (!s.holding) {
          if (s.spoke && now - lastHeard > END_SILENCE) return stop(true);
          if (!s.spoke && now - s.t0 > NO_SPEECH) { o.toast("Didn't hear anything"); return stop(false); }
        }
        if (now - s.t0 > MAX_MS) return stop(true);
        s.raf = requestAnimationFrame(tick);
      };
      s.raf = requestAnimationFrame(tick);
    }
    function finishPhone(s) {
      if (s.finished) return;
      s.finished = true;
      const t = s.text ? s.text() : "";
      end(s);
      if (!s.send) return;
      if (!t || !s.spoke) { if (!s.cancelled) o.toast("Didn't hear anything"); return; }
      o.input.value = t; o.grow();
      haptic(8);
      o.onText(t);
    }
    function e2Laptop(s) {                                // phone engine failed: switch for good, keep going
      if (store.get() !== "auto" || !CAN_RECORD) return false;
      store.markBroken(true);
      o.toast("Switched to laptop voice - talk again");
      end(s);
      return true;
    }

    // ---- session control ----------------------------------------------------------------------
    function start(holding) {
      if (session) return;
      if (o.canSend && !o.canSend()) return;
      const mode = engine();
      const s = session = { mode, holding: !!holding, send: true, spoke: false };
      o.input.blur();
      ui(true, mode);
      if (mode === "laptop") startLaptop(s); else startPhone(s);
    }
    function stop(send) {
      const s = session;
      if (!s || s.stopping) return;
      s.stopping = true; s.send = send; s.cancelled = !send;
      cancelAnimationFrame(s.raf);
      if (s.mode === "laptop") {
        if (s.rec && s.rec.state !== "inactive") { try { s.rec.stop(); } catch (_) { finishLaptop(s); } }
        else end(s);
      } else {
        if (!send) { try { s.rec && s.rec.abort(); } catch (_) {} return finishPhone(s); }
        try { s.rec && s.rec.stop(); } catch (_) {}
        setTimeout(() => finishPhone(s), 900);            // last words arrive with onend; don't wait forever
      }
    }
    function end(s) {
      s.dead = true;
      cancelAnimationFrame(s.raf);
      if (session === s) { session = null; ui(false); }
    }

    // tap = talk until you stop talking; hold = walkie-talkie
    let downAt = 0, downStarted = false;
    o.mic.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      e.preventDefault();
      try { o.mic.setPointerCapture(e.pointerId); } catch (_) {}   // the release always comes back here
      downAt = performance.now();
      if (session) { downStarted = false; return; }      // second tap ends it (on release)
      downStarted = true;
      start(true);
    });
    const release = () => {
      if (!downAt) return;
      const held = performance.now() - downAt;
      downAt = 0;
      if (!session) return;
      if (!downStarted) return stop(true);               // tap while listening = send now
      if (held >= HOLD_MS) return stop(true);            // walkie-talkie: let go to send
      session.holding = false;                           // a tap: keep listening, end on silence
    };
    o.mic.addEventListener("pointerup", release);
    o.mic.addEventListener("pointercancel", release);
    window.addEventListener("pointerup", release);       // belt and braces if capture isn't supported
    o.mic.addEventListener("contextmenu", (e) => e.preventDefault());
    o.mic.addEventListener("click", (e) => e.preventDefault());
    o.mic.addEventListener("keydown", (e) => {          // keyboard: Space / Enter toggles
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      if (session) stop(true); else { start(false); }
    });
    o.cancel.addEventListener("click", () => stop(false));
    o.input.addEventListener("pointerdown", () => {     // tap the text while listening: stop, keep it to edit
      if (session && session.mode === "phone") { session.send = false; stop(false); }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { if (session) stop(false); releaseNow(); }
    });

    return {
      engine,
      active: () => !!session,
      sendNow: () => stop(true),
      pref: store.get,
      set(v) { store.set(v); store.markBroken(false); releaseNow(); },
      available: { phone: !!SR, laptop: CAN_RECORD },
    };
  }

  window.Voice = { init };
})();
