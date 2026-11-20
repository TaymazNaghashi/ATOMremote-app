/* ATOM remote - send commands to ATOM on the laptop. Talks to atom_remote.py through remote.json on
 * the private ATOMremote repo's data branch. Keys are single-writer: the phone writes c<id> (command),
 * a:<cid> (allow / deny) and x:<cid> (stop); ATOM writes r:<cid> (result) and hb (heartbeat). */
(function () {
  "use strict";
  const { icon, $, $$, esc } = UI;
  let toastTimer = null;
  function flash(text) {                                      // small pill above the dock
    const t = $("#toast");
    t.textContent = text; t.classList.add("on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2200);
  }

  const DEMO = new URLSearchParams(location.search).has("demo");
  const KEEP_MS = 7 * 24 * 3600 * 1000;
  const sync = new DocSync.Syncer({
    storageKey: DEMO ? "remote-demo" : "remote", file: "remote.json", collection: "items", device: "phone",
    onChange: render, onStatus: (s) => { lastStatus = s; renderIsland(); },
  });
  let lastStatus = { state: "idle", text: "" };
  const SUGGEST = ["Lock my laptop", "Mute the volume", "Open Spotify", "What's on my screen?", "Set brightness to 40%", "Add todo buy milk"];
  // slash commands ATOM's brain handles itself (same as the island): /model, /effort, /ignorelimit
  const SLASH = ["/model ", "/effort ", "/ignorelimit 1", "/ignorelimit 0"];
  const MODEL_NAMES = ["Auto", "Haiku", "Sonnet", "Opus", "Fable", "Hydrogen", "Argon", "Neon", "Gemini", "Qwen3 8B", "Qwen3 4B", "Qwen3 30B"];
  const EFFORTS = ["auto", "low", "medium", "high", "xhigh", "max"];
  function chipsFor(v) {
    const t = v.trimStart().toLowerCase();
    if (/^\/model\s/.test(t)) return MODEL_NAMES.map((m) => `/model ${m}`);
    if (/^\/effort\s/.test(t)) return EFFORTS.map((e) => `/effort ${e}`);
    if (t.startsWith("/")) return SLASH.filter((c) => c.startsWith(t.split(/\s/)[0]) || t === "/");
    return [...SUGGEST, ...SLASH.slice(0, 2)];
  }
  let chipKey = "";
  function renderChips(v) {
    const list = chipsFor(v || ""), key = list.join("|");
    if (key === chipKey) return;
    chipKey = key;
    $("#chips").innerHTML = list.map((c) => `<button type="button" data-chip="${esc(c)}">${esc(c.trim())}</button>`).join("");
    $("#chips").scrollLeft = 0;
  }
  const FINAL = new Set(["done", "error", "denied", "expired", "off", "stopped"]);

  // ---- model --------------------------------------------------------------------------------
  const items = () => sync.items;
  const commands = () => items().filter((i) => i.type === "command").sort((a, b) => a.createdAt - b.createdAt).slice(-40);
  const result = (cid) => sync.get(`r:${cid}`);
  function active() {                                         // newest command still in flight
    const cs = commands(), c = cs[cs.length - 1];
    if (!c) return null;
    const r = result(c.id);
    if (r && FINAL.has(r.status)) return null;
    if (!r && Date.now() - c.createdAt > 5 * 60 * 1000) return null;
    return { c, r };
  }
  function heartbeat() {
    const hb = sync.get("hb");
    if (!hb) return { online: false, text: sync.connected ? "Waiting for your laptop" : "Not connected" };
    const ago = Date.now() - hb.at;
    if (hb.enabled === false) return { online: "off", text: "Phone remote is off on the laptop" };
    if (ago < 7 * 60 * 1000) return { online: "yes", text: "Laptop online" };
    return { online: false, text: `Laptop last seen ${since(hb.at)}` };
  }
  function since(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
  }
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function send(text, extra) {
    text = text.trim();
    if (!text && !(extra && extra.audio)) return;
    const now = Date.now();
    sync.put(Object.assign({ id: DocSync.uid("c"), type: "command", text: text.slice(0, 500), createdAt: now, device: "phone" }, extra || {}),
             text ? `Command: ${text.slice(0, 40)}` : "Voice command");
    clearTimeout(sync.timer); sync.sync();                    // don't wait for the debounce
    render(); scrollToEnd(true); poll(true);
  }
  function answer(cid, allow) {
    sync.put({ id: `a:${cid}`, type: "answer", cid, allow }, allow ? "Allow" : "Deny");
    clearTimeout(sync.timer); sync.sync(); render(); poll(true);
  }
  function stop(cid) {
    sync.put({ id: `x:${cid}`, type: "cancel", cid }, "Stop");
    clearTimeout(sync.timer); sync.sync(); flash("Stopping…");
  }

  function said(c) {                                          // what to show for a command (voice: what ATOM heard)
    if (c.text) return c.text;
    const r = result(c.id);
    return r && r.heard ? r.heard : "";
  }
  function stripAudio() {                                     // the clip isn't needed once ATOM has it
    for (const c of commands()) {
      if (!c.audio) continue;
      const r = result(c.id);
      if (!r || (r.heard === undefined && !FINAL.has(r.status))) continue;
      const copy = Object.assign({}, c, { text: (r.heard || "").slice(0, 500) });
      delete copy.audio;
      sync.put(copy, "Voice transcribed");
    }
  }

  // ---- island -----------------------------------------------------------------------------
  function renderIsland() {
    const el = $("#island"), a = active(), hb = heartbeat();
    const cs = commands(), last = cs[cs.length - 1], lr = last && result(last.id);
    let state = "idle", title = "ATOM", sub = hb.text, steps = "";
    if (!sync.connected && !DEMO) { sub = "Tap to connect"; }
    else if (lastStatus.state === "error") { sub = lastStatus.text; }
    if (a) {
      state = a.r && a.r.status === "confirm" ? "confirm" : "working";
      title = said(a.c) || "Voice command";
      steps = !a.r ? (hb.online === "yes" ? "Sending to your laptop…" : "Waiting for your laptop…")
            : a.r.status === "confirm" ? "Needs your OK" : (a.r.message || "Working");
    } else if (lr && FINAL.has(lr.status) && Date.now() - (lr.finishedAt || lr.updatedAt) < 6000) {
      state = lr.status === "done" ? "done" : "error";
      title = lr.message || (state === "done" ? "Done" : "Didn't work");
      sub = said(last) || "Voice command";
    }
    el.dataset.state = state;
    el.dataset.online = hb.online === true ? "yes" : hb.online || "no";
    $("#island-title").textContent = title;
    $("#island-sub").textContent = sub;
    $("#island-steps").textContent = steps;
    $("#island-mark").innerHTML = state === "done" ? icon("check") : state === "error" ? icon("x") : state === "confirm" ? "!" : "";
    $("#edge-glow").classList.toggle("on", state === "working" || state === "confirm");
  }

  // ---- feed -------------------------------------------------------------------------------
  const LABEL = { running: "Working", confirm: "Needs your OK", done: "Done", error: "Didn't work", denied: "Cancelled",
                  expired: "Expired", off: "Remote is off", stopped: "Stopped" };
  function replyHTML(c) {
    const r = result(c.id);
    if (!r) {
      const stale = Date.now() - c.createdAt > 5 * 60 * 1000;
      return `<div class="reply ${stale ? "expired" : "running"}"><div class="head"><span class="dot"></span>${stale ? "Never reached the laptop" : c.audio ? "Sending your voice…" : "Sending…"}</div></div>`;
    }
    const steps = r.status === "running" && (r.steps || []).length
      ? `<ul class="steps">${r.steps.slice(-4).map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : "";
    let body = `<div class="msg">${esc(r.message || LABEL[r.status] || "")}</div>${steps}`;
    if (r.status === "confirm") {
      const answered = sync.get(`a:${c.id}`);
      body = `<div class="msg">${esc((r.confirm && r.confirm.summary) || r.message)}</div>
        ${r.confirm && r.confirm.command ? `<code>${esc(r.confirm.command)}</code>` : ""}
        ${answered ? `<div class="msg" style="font-size:14px;color:var(--label-2);margin-top:8px">${answered.allow ? "Allowed - running…" : "Cancelling…"}</div>`
          : `<div class="actions"><button class="deny" data-deny="${c.id}">Don't Allow</button><button class="allow" data-allow="${c.id}">Allow</button></div>`}`;
    }
    if (r.status === "running") body += `<div class="actions"><button class="stop" data-stop="${c.id}">Stop</button></div>`;
    return `<div class="reply ${r.status}"><div class="head"><span class="dot"></span>${LABEL[r.status] || r.status}${r.finishedAt ? ` · ${clock(r.finishedAt)}` : ""}</div>${body}</div>`;
  }
  const MIC_SVG = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
  function meHTML(c) {
    const t = said(c);
    if (!c.voice) return `<div class="me">${esc(t)}</div>`;
    return t ? `<div class="me voice"><span class="vmark">${MIC_SVG}</span>${esc(t)}</div>`
             : `<div class="me voice pending"><span class="vmark">${MIC_SVG}</span><span class="vbars"><i></i><i></i><i></i><i></i><i></i></span>Voice</div>`;
  }
  function render() {
    stripAudio();
    const cs = commands();
    const feed = $("#feed");
    const nearEnd = innerHeight + scrollY > document.body.scrollHeight - 140;
    if (!cs.length) {
      feed.innerHTML = `<div class="welcome"><h1>What should I do on your laptop?</h1>
        <p>${sync.connected || DEMO ? "Type or dictate a command below. ATOM runs it on your laptop and reports back here. Type / to change the model, effort or time limit."
          : "Connect to your ATOMremote repo once, then type or dictate commands for your laptop."}</p>
        ${sync.connected || DEMO ? "" : `<div style="padding-top:20px"><button class="btn press" id="connect">Connect</button></div>`}</div>`;
    } else {
      feed.innerHTML = cs.map((c) => `<div class="ex" data-id="${c.id}">${meHTML(c)}${replyHTML(c)}</div>`).join("");
    }
    renderIsland();
    if (nearEnd) scrollToEnd();
  }
  function scrollToEnd(smooth) { requestAnimationFrame(() => scrollTo({ top: document.body.scrollHeight, behavior: smooth ? "smooth" : "auto" })); }

  // ---- polling: fast while a command is in flight, relaxed otherwise --------------------------
  let pollTimer = null;
  function poll(now) {
    clearTimeout(pollTimer);
    const run = async () => {
      if (!document.hidden && (sync.connected || DEMO)) { await sync.sync(); render(); }
      pollTimer = setTimeout(run, active() ? 1500 : 12000);
    };
    if (now) run(); else pollTimer = setTimeout(run, active() ? 1500 : 12000);
  }

  // ---- wiring -----------------------------------------------------------------------------
  function prune() {                                          // same 7-day rule as ATOM
    const cutoff = Date.now() - KEEP_MS;
    for (const [k, v] of Object.entries(sync.doc.items)) if (!v || (v.updatedAt || 0) < cutoff) delete sync.doc.items[k];
  }
  let voice = null;
  function bind() {
    $("#btn-settings").innerHTML = icon("gear");
    $("#send").innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`;
    UI.bindStatus(document.createElement("span"));            // status shows in the island instead
    renderChips("");
    const input = $("#input"), btn = $("#send");
    const grow = () => { input.style.height = "auto"; input.style.height = Math.min(132, input.scrollHeight) + "px";
                         btn.disabled = !input.value.trim(); renderChips(input.value); };
    input.addEventListener("input", grow);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); } });
    $("#composer").onsubmit = (e) => {
      e.preventDefault();
      if (voice && voice.active && voice.active()) return voice.sendNow();   // listening: send what was said
      if (!sync.connected && !DEMO) return openSettings();
      const t = input.value; input.value = ""; grow(); send(t);
    };
    $("#chips").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      input.value = b.dataset.chip || b.textContent; grow(); input.focus();
    };
    voice = Voice.init({
      mic: $("#mic"), cancel: $("#vcancel"), bar: $("#voicebar"), canvas: $("#wave"), timer: $("#vtimer"),
      input, composer: $("#composer"), send: $("#send"), grow, toast: flash,
      canSend: () => { if (!sync.connected && !DEMO) { openSettings(); return false; } return true; },
      onText: (t) => { input.value = ""; grow(); send(t, { voice: true }); },
      onAudio: (audio) => send("", { voice: true, audio }),
    });
    $("#mic").innerHTML = MIC_SVG;
    $("#vcancel").innerHTML = icon("x");
    $("#feed").addEventListener("click", (e) => {
      const t = e.target.closest("[data-allow],[data-deny],[data-stop],#connect"); if (!t) return;
      if (t.id === "connect") return openSettings();
      if (t.dataset.allow) answer(t.dataset.allow, true);
      else if (t.dataset.deny) answer(t.dataset.deny, false);
      else if (t.dataset.stop) stop(t.dataset.stop);
    });
    $("#island").onclick = () => { if (!sync.connected && !DEMO) openSettings(); else { poll(true); scrollToEnd(true); } };
    $("#btn-settings").onclick = openSettings;
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(true); });
    setInterval(renderIsland, 5000);                          // "last seen" and the result flash age out
  }
  function voiceNow() {
    const e = voice && voice.engine();
    return e === "laptop" ? "Now: recorded here, transcribed on your laptop (most accurate, works everywhere)."
         : e === "phone" ? "Now: this phone's speech recognition (words appear as you talk)." : "Voice isn't available in this browser.";
  }
  function voiceSettingsHTML() {
    if (!voice || !voice.pref) return "";
    const p = voice.pref(), av = voice.available;
    const b = (v, label, ok) => `<button type="button" data-v="${v}" class="${p === v ? "sel" : ""}" ${ok ? "" : "disabled"}>${label}</button>`;
    return `<div class="section"><div class="section-head">Voice</div><div class="group"><div class="row" style="display:block">
      <div class="seg" id="voice-seg">${b("auto", "Automatic", true)}${b("laptop", "Laptop", av.laptop)}${b("phone", "Phone", av.phone)}</div>
      <div id="voice-now" style="color:var(--label-2);font-size:13px;line-height:1.35;margin-top:10px">${voiceNow()}</div>
      <div style="color:var(--label-3);font-size:13px;line-height:1.35;margin-top:6px">Tap the mic and talk - it sends when you stop. Hold it to talk, let go to send. Start with "model hydrogen, effort medium" to switch model too.</div>
    </div></div></div>`;
  }
  function openSettings() {
    UI.settingsSheet(sync, {
      repoHint: "TaymazNaghashi/ATOMremote", appName: "ATOM Remote",
      extra: `<div class="section"><div class="section-head">How it works</div><div class="group"><div class="row" style="display:block;color:var(--label-2);font-size:15px;line-height:1.4">
        Commands go through your private ATOMremote repo. ATOM on the laptop checks it every few seconds, runs the command and replies here.
        Anything risky asks for your OK first, the island on the laptop shows every remote command, and the <b>Phone remote</b>
        switch in ATOM's extended view turns it off.</div></div></div>${voiceSettingsHTML()}`,
      mountExtra: (el) => {
        const seg = el.querySelector("#voice-seg");
        if (!seg) return;
        seg.onclick = (e) => {
          const b = e.target.closest("button[data-v]"); if (!b || b.disabled) return;
          voice.set(b.dataset.v);
          seg.querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x === b));
          el.querySelector("#voice-now").textContent = voiceNow();
        };
      },
    });
  }

  function demo() {
    const now = Date.now(), m = 60000;
    const put = (o) => { sync.doc.items[o.id] = Object.assign({ updatedAt: now }, o); };
    put({ id: "hb", type: "heartbeat", at: now - 20000, enabled: true });
    put({ id: "c1", type: "command", text: "Mute the volume", createdAt: now - 9 * m });
    put({ id: "r:c1", type: "result", cid: "c1", status: "done", message: "Muted", finishedAt: now - 9 * m + 4000 });
    put({ id: "c2", type: "command", text: "Clear my Downloads folder", createdAt: now - 3 * m });
    put({ id: "r:c2", type: "result", cid: "c2", status: "confirm", message: "Delete 38 files in Downloads",
          confirm: { summary: "Delete 38 files in Downloads", command: "Remove-Item \"$env:USERPROFILE\\Downloads\\*\" -Recurse" } });
    put({ id: "c3", type: "command", text: "Open Spotify and play my liked songs", createdAt: now - 20000 });
    put({ id: "r:c3", type: "result", cid: "c3", status: "running", message: "Clicking Liked Songs", steps: ["Opening Spotify", "Waiting for the window", "Clicking Liked Songs"] });
  }

  bind();
  prune();
  if (DEMO) demo();
  render();
  UI.registerSW();
  if (!DEMO) poll(true);
  scrollToEnd();
})();
