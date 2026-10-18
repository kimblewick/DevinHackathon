"use strict";

const $ = (s) => document.querySelector(s);
const SCREENS = ["s-join", "s-lobby", "s-game", "s-dead", "s-end"];
const POLL_MS = 700;
const DETECT_MS = 100;
const MAXDIM = 480;
const POSE_TTL = 900;      // keep drawing a marker this long after last detection
const FIRE_MS = 220;
const FLIGHT_MS = 260;
const TAP_SLOP = 1.7;      // tap counts if within this * marker radius (min 44px)
const MARKER_M = 0.08;     // printed marker width, for rough sighting distance
const TELEMETRY_MS = 1000;

const me = {
  load() { try { return JSON.parse(localStorage.getItem("pb_me")); } catch { return null; } },
  save(v) { localStorage.setItem("pb_me", JSON.stringify(v)); },
  clear() { localStorage.removeItem("pb_me"); },
};

let cfg = { hits_to_eliminate: 3, cooldown_s: 0.3 };
let detector = null;
let camStream = null, liveMode = false, armed = false;
let detectTimer = null, rafId = null;
let mode = "idle";
let st = null, byMarker = new Map();   // marker id -> player (from server state)
let myColor = "#ff6a00";

// ---------- helpers ----------

function show(id) { SCREENS.forEach((s) => $("#" + s).classList.toggle("hidden", s !== id)); }
function msg(text) { $("#join-msg").textContent = text; }
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function flash(color) {
  const f = $("#flash");
  f.style.background = color; f.style.opacity = "0.45";
  setTimeout(() => (f.style.opacity = "0"), 220);
}
let hudTimer = null;
function hud(text, ms = 900) {
  const el = $("#hud-msg");
  el.textContent = text; el.classList.add("show");
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => el.classList.remove("show"), ms);
}
async function post(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Player-Token"] = token;
  const r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  return r.json();
}
async function getState() {
  const m = me.load();
  const r = await fetch("/api/state" + (m ? "?token=" + m.token : ""));
  const s = await r.json();
  s._token = m ? m.token : null;   // which session this answer is about
  return s;
}
const rand = (a, b) => a + Math.random() * (b - a);
const FONT = 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
const ease = (k) => 1 - (1 - k) * (1 - k);
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(((n >> 16) & 255) * k) | 0},${(((n >> 8) & 255) * k) | 0},${((n & 255) * k) | 0})`;
}

// ---------- audio ----------

let actx = null;
function audioInit() {
  if (actx) return;
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { actx = null; }
}
function blip(f0, f1, dur, type = "square", gain = 0.1) {
  if (!actx) return;
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
}
const sfx = {
  shot: () => blip(520, 140, 0.1, "square", 0.07),
  miss: () => blip(300, 120, 0.12, "triangle", 0.05),
  hit: () => { blip(220, 60, 0.16, "sawtooth", 0.12); blip(700, 1100, 0.1, "square", 0.08); },
  splat: () => { blip(660, 990, 0.09, "square", 0.1); setTimeout(() => blip(990, 1480, 0.16, "square", 0.1), 80); },
  ouch: () => { blip(160, 50, 0.22, "sawtooth", 0.16); blip(90, 40, 0.3, "square", 0.08); },
  down: () => { blip(400, 60, 0.5, "sawtooth", 0.16); setTimeout(() => blip(200, 30, 0.6, "square", 0.1), 150); },
};

// ---------- camera / canvas ----------

const video = $("#cam"), ar = $("#ar");
const arx = ar.getContext("2d");
const work = document.createElement("canvas");
const workCtx = work.getContext("2d", { willReadFrequently: true });
const view = { cw: 0, ch: 0, dw: 0, dh: 0, scale: 1, ox: 0, oy: 0, dpr: 1 };

function camAvailable() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
async function startVideo() {
  if (camStream) return true;
  if (!camAvailable()) return false;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    video.srcObject = camStream;
    await video.play();
    return true;
  } catch { return false; }
}
function stopVideo() {
  clearInterval(detectTimer); detectTimer = null;
  cancelAnimationFrame(rafId); rafId = null;
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
}
function layout() {
  const vw = video.videoWidth || 720, vh = video.videoHeight || 1280;
  const s = Math.min(1, MAXDIM / Math.max(vw, vh));
  view.dw = Math.max(1, Math.round(vw * s)); view.dh = Math.max(1, Math.round(vh * s));
  work.width = view.dw; work.height = view.dh;
  const wrap = $("#cam-wrap");
  view.cw = wrap.clientWidth; view.ch = wrap.clientHeight;
  view.dpr = Math.min(2, window.devicePixelRatio || 1);
  ar.width = Math.round(view.cw * view.dpr); ar.height = Math.round(view.ch * view.dpr);
  arx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  view.scale = Math.max(view.cw / view.dw, view.ch / view.dh);   // object-fit: cover
  view.ox = (view.dw * view.scale - view.cw) / 2;
  view.oy = (view.dh * view.scale - view.ch) / 2;
}
window.addEventListener("resize", () => { if (mode === "play") layout(); });
const toDisp = (px, py) => [px * view.scale - view.ox, py * view.scale - view.oy];

// ---------- marker detection ----------

const targets = new Map();   // marker id -> {corners:[[X,Y]x4] (display px), cx, cy, r, t}

function detectFrame() {
  if (!video.videoWidth || document.hidden) return;
  workCtx.drawImage(video, 0, 0, view.dw, view.dh);
  let marks = [];
  try { marks = detector.detect(workCtx.getImageData(0, 0, view.dw, view.dh)); } catch { return; }
  const now = performance.now();
  for (const m of marks) {
    const corners = m.corners.map((c) => toDisp(c.x, c.y));
    const cx = corners.reduce((a, c) => a + c[0], 0) / 4, cy = corners.reduce((a, c) => a + c[1], 0) / 4;
    const r = Math.max(...corners.map((c) => Math.hypot(c[0] - cx, c[1] - cy)));
    const sideDet = Math.hypot(m.corners[1].x - m.corners[0].x, m.corners[1].y - m.corners[0].y);
    const dist = sideDet > 2 ? (0.78 * view.dw * MARKER_M) / sideDet : null;
    targets.set(m.id, { corners, cx, cy, r, dist, t: now });
  }
  for (const [id, tg] of targets) if (now - tg.t > POSE_TTL) targets.delete(id);
}
function visibleTargets() {
  const now = performance.now(), out = [];
  for (const [id, tg] of targets) if (now - tg.t <= POSE_TTL) out.push([id, tg]);
  return out;
}

// ---------- ink sprites ----------

const spriteCache = new Map();
function splatSprite(color, seed) {
  const key = color + "|" + seed;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const S = 256, c = document.createElement("canvas"); c.width = c.height = S;
  const x = c.getContext("2d"), cx = S / 2, cy = S / 2;
  let r = seed * 9301 + 49297; const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  x.fillStyle = color;
  x.beginPath(); x.arc(cx, cy, 64, 0, Math.PI * 2); x.fill();
  const n = 7 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, d = 40 + rnd() * 60, rr = 8 + rnd() * 28;
    x.beginPath(); x.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, 0, Math.PI * 2); x.fill();
  }
  for (let i = 0; i < 2 + Math.floor(rnd() * 2); i++) {
    const dx = cx + (rnd() - 0.5) * 70, len = 30 + rnd() * 50, w = 8 + rnd() * 8;
    x.beginPath(); x.ellipse(dx, cy + 50 + len / 2, w, len / 2, 0, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.arc(dx, cy + 50 + len, w * 1.2, 0, Math.PI * 2); x.fill();
  }
  x.globalAlpha = 0.35; x.fillStyle = "#fff";
  x.beginPath(); x.ellipse(cx - 18, cy - 22, 22, 12, -0.6, 0, Math.PI * 2); x.fill();
  spriteCache.set(key, c);
  return c;
}

// ---------- shots ----------

let balls = [];       // {x0,y0,x1,y1,targetId|null,color,born}
let pops = [];        // {X,Y,color,born,miss}
let damage = [];      // ink thrown onto MY screen when I get hit: {X,Y,size,color,born,seed,vx,vy}
let lastHitsTaken = null;
let deadTimer = null;
const pending = new Map();   // marker id -> local hits not yet reflected in server state
const seenPaint = new Map(); // marker id -> paint count last seen from server
let lastFire = 0;

function fireAt(X, Y) {
  const now = performance.now();
  if (now - lastFire < FIRE_MS) return;
  lastFire = now;
  let hitId = null, best = Infinity;
  for (const [id, tg] of visibleTargets()) {
    const d = Math.hypot(X - tg.cx, Y - tg.cy), lim = Math.max(44, tg.r * TAP_SLOP);
    if (d < lim && d < best) { best = d; hitId = id; }
  }
  balls.push({ x0: view.cw / 2, y0: view.ch + 30, x1: X, y1: Y, targetId: hitId, color: myColor, born: now });
  sfx.shot();
}

async function landBall(b) {
  const tg = b.targetId != null ? targets.get(b.targetId) : null;
  const X = tg ? tg.cx : b.x1, Y = tg ? tg.cy : b.y1;
  if (b.targetId == null) { pops.push({ X, Y, color: b.color, born: performance.now(), miss: true }); sfx.miss(); return; }
  pops.push({ X, Y, color: b.color, born: performance.now(), miss: false });
  const m = me.load();
  if (!m) return;
  const victim = byMarker.get(b.targetId);
  if (!victim) { hud("#" + b.targetId + " not in game", 800); return; }
  if (victim.id === m.id) { hud("that's YOU", 700); return; }
  if (!victim.alive) { hud("already splatted", 700); return; }
  pending.set(b.targetId, (pending.get(b.targetId) || 0) + 1);
  sfx.hit();
  const res = await post("/api/hit", { player_id: m.id, marker_id: b.targetId }, m.token);
  if (res.ok) {
    if (res.result === "eliminated") { hud("SPLATTED " + (res.victim?.name || "") + "!", 1400); flash("rgba(255,42,168,.8)"); sfx.splat(); }
    else if (res.result === "hit") { hud("HIT!", 500); flash(rgba(myColor, 0.45)); }
    else if (res.result !== "already_out") pending.set(b.targetId, Math.max(0, (pending.get(b.targetId) || 1) - 1));
  } else {
    pending.set(b.targetId, Math.max(0, (pending.get(b.targetId) || 1) - 1));
    if (res.error === "dead") show("s-dead");
    else if (res.error === "cooldown") hud("reloading…", 400);
    else hud(res.message || res.error, 900);
  }
}

// ---------- sensors: compass heading + step counter (for the host map) ----------

const sensors = { heading: null, steps: 0, ok: false };
let accLP = 9.81, accPrev = 9.81, lastStepT = 0, stepArmed = true;
window.addEventListener("deviceorientation", (e) => {
  let h = null;
  if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;   // iOS: degrees CW from north
  else if (e.absolute && typeof e.alpha === "number") h = (360 - e.alpha) % 360;  // Android absolute
  else if (typeof e.alpha === "number") h = (360 - e.alpha) % 360;               // relative fallback
  if (h != null) { sensors.heading = h; sensors.ok = true; }
}, true);
window.addEventListener("devicemotion", (e) => {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const mag = Math.hypot(a.x, a.y, a.z);
  accLP = accLP * 0.8 + mag * 0.2;                 // smooth
  const now = performance.now();
  // a step = smoothed magnitude rising through +1.2 m/s² above gravity, then re-arming below it
  if (stepArmed && accLP > 9.81 + 1.2 && accPrev <= 9.81 + 1.2 && now - lastStepT > 320) {
    sensors.steps++; lastStepT = now; stepArmed = false;
  }
  if (accLP < 9.81 + 0.4) stepArmed = true;
  accPrev = accLP;
});
async function requestSensors() {
  for (const E of [window.DeviceOrientationEvent, window.DeviceMotionEvent]) {
    try { if (E && E.requestPermission) await E.requestPermission(); } catch { /* denied: map just shows HP */ }
  }
}
let teleTimer = null;
function startTelemetry() {
  clearInterval(teleTimer);
  teleTimer = setInterval(async () => {
    const m = me.load();
    if (!m || mode !== "play" || document.hidden) return;
    const sightings = visibleTargets()
      .filter(([id, tg]) => tg.dist != null && byMarker.has(id))
      .map(([id, tg]) => ({ marker_id: id, dist: Math.round(tg.dist * 10) / 10 }));
    try {
      await post("/api/telemetry", {
        player_id: m.id, heading: sensors.heading, steps: sensors.steps, sightings,
      }, m.token);
    } catch { /* offline blip, next tick */ }
  }, TELEMETRY_MS);
}
function stopTelemetry() { clearInterval(teleTimer); teleTimer = null; }

// ---------- taking damage ----------

function gotHit(color, left, hp) {
  const now = performance.now();
  const n = 5 + Math.floor(rand(0, 3));
  for (let i = 0; i < n; i++) {
    const edge = Math.random() < 0.5;   // bias splats toward the screen edges
    const X = edge ? (Math.random() < 0.5 ? rand(-20, view.cw * 0.25) : rand(view.cw * 0.75, view.cw + 20)) : rand(0, view.cw);
    const Y = rand(-20, view.ch + 20);
    damage.push({ X, Y, size: rand(70, 160), color, born: now + i * 30, seed: Math.floor(rand(0, 1e6)), vy: rand(6, 18) });
  }
  if (damage.length > 40) damage.splice(0, damage.length - 40);
  flash(rgba(color, 0.55));
  $("#cam-wrap").classList.remove("shake"); void $("#cam-wrap").offsetWidth; $("#cam-wrap").classList.add("shake");
  if (navigator.vibrate) navigator.vibrate(left > 0 ? [60, 40, 60] : [200, 60, 200]);
  if (left > 0) { hud(`HIT!  ${left}/${hp} HP`, 1000); sfx.ouch(); }
  else { hud("SPLATTED!", 1600); sfx.down(); }
}

// ---------- drawing ----------

function quad(corners) {
  arx.beginPath(); arx.moveTo(corners[0][0], corners[0][1]);
  for (let i = 1; i < 4; i++) arx.lineTo(corners[i][0], corners[i][1]);
  arx.closePath();
}

function drawMarker(id, tg) {
  const p = byMarker.get(id);
  const hp = cfg.hits_to_eliminate;
  const serverPaint = p ? p.paint : [];
  const extra = Math.min(pending.get(id) || 0, Math.max(0, hp - serverPaint.length));
  const paint = serverPaint.concat(Array(extra).fill(myColor));
  const hits = Math.min(hp, paint.length);
  const dead = p ? !p.alive : false;

  // ink on the code: splats clipped to the marker, more coverage per hit
  if (paint.length) {
    arx.save(); quad(tg.corners); arx.clip();
    const size = tg.r * (dead ? 1.6 : 0.55 + 0.35 * (hits / hp));
    paint.forEach((color, i) => {
      let r = (id * 131 + i * 17) % 233280; const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
      const X = tg.cx + (rnd() - 0.5) * tg.r * 1.1, Y = tg.cy + (rnd() - 0.5) * tg.r * 1.1;
      arx.drawImage(splatSprite(color, id * 7 + i), X - size, Y - size, size * 2, size * 2);
    });
    if (dead) {
      arx.fillStyle = rgba(paint[paint.length - 1], 0.85);
      arx.fillRect(tg.cx - tg.r * 2, tg.cy - tg.r * 2, tg.r * 4, tg.r * 4);
    }
    arx.restore();
  }

  // outline
  quad(tg.corners);
  arx.lineWidth = 2; arx.strokeStyle = dead ? "rgba(255,255,255,.35)" : (p ? p.color : "rgba(255,255,255,.6)");
  arx.setLineDash(dead ? [6, 6] : []); arx.stroke(); arx.setLineDash([]);

  // name plate + segmented HP bar above the marker
  const left = Math.max(0, hp - hits);
  const label = dead ? "SPLATTED" : (p ? p.name : "#" + id + " · not in game");
  arx.font = "800 14px " + FONT;
  arx.textAlign = "left"; arx.textBaseline = "middle";
  const tw = arx.measureText(label).width;
  const w = Math.max(tw + 24, Math.min(220, tg.r * 2.2)), h = dead ? 30 : 42;
  const X = tg.cx - w / 2, Y = Math.min(...tg.corners.map((c) => c[1])) - h - 12;
  arx.fillStyle = "rgba(11,11,16,.82)"; roundRect(X, Y, w, h, 10); arx.fill();
  arx.strokeStyle = p ? rgba(p.color, 0.9) : "rgba(255,255,255,.25)"; arx.lineWidth = 1.5; arx.stroke();
  arx.fillStyle = dead ? "#ff4d5e" : "#fff"; arx.fillText(label, X + 12, Y + 15);
  if (!dead) {
    arx.font = "700 12px " + MONO; arx.textAlign = "right"; arx.fillStyle = "#b8b8c8";
    arx.fillText(`${left}/${hp}`, X + w - 10, Y + 15);
    const bx = X + 12, bw = w - 24, by = Y + 28, bh = 6, gap = 2, seg = (bw - gap * (hp - 1)) / hp;
    const col = left / hp <= 0.25 ? "#ff4d5e" : left / hp <= 0.5 ? "#ffc53d" : "#4ade80";
    for (let i = 0; i < hp; i++) {
      arx.fillStyle = i < left ? col : "rgba(255,255,255,.18)";
      roundRect(bx + i * (seg + gap), by, seg, bh, 2); arx.fill();
    }
  }
}
function roundRect(x, y, w, h, r) {
  arx.beginPath(); arx.moveTo(x + r, y); arx.arcTo(x + w, y, x + w, y + h, r); arx.arcTo(x + w, y + h, x, y + h, r);
  arx.arcTo(x, y + h, x, y, r); arx.arcTo(x, y, x + w, y, r); arx.closePath();
}

function frame() {
  rafId = requestAnimationFrame(frame);
  const now = performance.now();
  arx.clearRect(0, 0, view.cw, view.ch);

  for (const [id, tg] of visibleTargets()) drawMarker(id, tg);

  // paintballs in flight (arc up then into the target)
  const keep = [];
  for (const b of balls) {
    const k = Math.min(1, (now - b.born) / FLIGHT_MS);
    const tg = b.targetId != null ? targets.get(b.targetId) : null;
    const x1 = tg ? tg.cx : b.x1, y1 = tg ? tg.cy : b.y1;
    const e = ease(k);
    const X = b.x0 + (x1 - b.x0) * e, Y = b.y0 + (y1 - b.y0) * e - Math.sin(k * Math.PI) * 60;
    const r = 26 - 16 * e;
    for (let i = 3; i >= 1; i--) {
      const kk = Math.max(0, k - i * 0.05), ee = ease(kk);
      arx.globalAlpha = 0.15 * (4 - i) / 3; arx.fillStyle = b.color;
      arx.beginPath(); arx.arc(b.x0 + (x1 - b.x0) * ee, b.y0 + (y1 - b.y0) * ee - Math.sin(kk * Math.PI) * 60, r * 0.8, 0, Math.PI * 2); arx.fill();
    }
    arx.globalAlpha = 1;
    const g = arx.createRadialGradient(X - r * 0.35, Y - r * 0.35, r * 0.1, X, Y, r);
    g.addColorStop(0, "#fff"); g.addColorStop(0.25, b.color); g.addColorStop(1, shade(b.color, 0.5));
    arx.fillStyle = g; arx.beginPath(); arx.arc(X, Y, r, 0, Math.PI * 2); arx.fill();
    if (k >= 1) landBall(b); else keep.push(b);
  }
  balls = keep;

  // ink on my own screen from being hit — slides down a little, then fades
  damage = damage.filter((d) => now - d.born < 3200);
  for (const d of damage) {
    const age = now - d.born;
    if (age < 0) continue;
    const grow = Math.min(1, age / 120), fade = age < 2200 ? 1 : 1 - (age - 2200) / 1000;
    const sz = d.size * (0.5 + 0.5 * grow), Y = d.Y + d.vy * Math.min(1, age / 1200) * 4;
    arx.globalAlpha = 0.92 * fade;
    arx.drawImage(splatSprite(d.color, d.seed), d.X - sz, Y - sz, sz * 2, sz * 2);
  }
  arx.globalAlpha = 1;

  // impact pops (misses fade out, hits ring)
  pops = pops.filter((p) => now - p.born < 420);
  for (const p of pops) {
    const k = (now - p.born) / 420;
    if (p.miss) {
      arx.globalAlpha = 0.6 * (1 - k);
      const s = 30 + 20 * k;
      arx.drawImage(splatSprite(p.color, 3), p.X - s, p.Y - s, s * 2, s * 2);
    } else {
      arx.globalAlpha = 1 - k; arx.strokeStyle = p.color; arx.lineWidth = 7 * (1 - k);
      arx.beginPath(); arx.arc(p.X, p.Y, 14 + 80 * k, 0, Math.PI * 2); arx.stroke();
    }
  }
  arx.globalAlpha = 1;
}

// ---------- input ----------

const wrap = $("#cam-wrap");
wrap.addEventListener("pointerdown", (e) => {
  if (mode !== "play" || !liveMode || !armed) return;
  if (e.target.closest("#photo-ui")) return;
  const rect = wrap.getBoundingClientRect();
  fireAt(e.clientX - rect.left, e.clientY - rect.top);
  e.preventDefault();
});
wrap.addEventListener("contextmenu", (e) => e.preventDefault());
$("#btn-arm").addEventListener("click", async () => {
  audioInit(); if (actx && actx.state === "suspended") actx.resume();
  await requestSensors();
  armed = true; $("#arm").classList.add("hidden");
  hud("GO!", 700);
});

// ---------- join ----------

$("#btn-join").onclick = async () => {
  const name = $("#name").value.trim();
  const number = parseInt($("#number").value, 10);
  if (!name) { msg("enter your name"); return; }
  if (!(number >= 1 && number <= 20)) { msg("enter your marker number (1–20)"); return; }
  msg("joining…");
  const m = me.load();
  const res = await post("/api/join", { name, marker_id: number, token: m ? m.token : undefined });
  if (res.ok) { me.save(res.player); msg(""); show("s-lobby"); render(); }
  else msg(res.message || "join failed — try again");
};

// ---------- photo-mode fallback (plain HTTP) ----------

$("#btn-shoot").onclick = () => $("#shot-capture").click();
$("#shot-capture").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f || mode !== "play") return;
  hud("reading…", 600);
  const bmp = await createImageBitmap(f);
  const s = Math.min(1, MAXDIM / Math.max(bmp.width, bmp.height));
  work.width = Math.round(bmp.width * s); work.height = Math.round(bmp.height * s);
  workCtx.drawImage(bmp, 0, 0, work.width, work.height); bmp.close();
  let marks = [];
  try { marks = detector.detect(workCtx.getImageData(0, 0, work.width, work.height)); } catch { /* ignore */ }
  if (!marks.length) { hud("no marker in shot", 900); return; }
  landBall({ targetId: marks[0].id, x1: 0, y1: 0, color: myColor });
};

// ---------- screens ----------

function hpBar(p) {
  const hp = cfg.hits_to_eliminate, left = Math.max(0, hp - p.hits_taken);
  const cls = left / hp <= 0.25 ? "crit" : left / hp <= 0.5 ? "low" : "";
  return `<span class="hp ${cls}">${Array.from({ length: hp }, (_, i) => `<i class="${i < left ? "on" : ""}"></i>`).join("")}</span>`;
}
function playerRow(p) {
  const m = me.load();
  const cls = (p.alive ? "" : "dead ") + (m && p.id === m.id ? "me" : "");
  return `<li class="${cls}"><span class="sw" style="background:${p.color}"></span>
    <span class="nm">${esc(p.name)}<span class="num">#${p.marker_id}</span>${hpBar(p)}</span>
    <span class="kills"><b>${p.kills}</b> splat${p.kills === 1 ? "" : "s"}</span></li>`;
}
function httpsUrl(s) {
  if (!s.tls_port || location.protocol === "https:") return null;
  const m = me.load();
  // carry the session over: localStorage is per-origin, so the secure page would otherwise forget us
  return `https://${location.hostname}:${s.tls_port}${location.pathname}` + (m ? `?t=${m.token}` : "");
}
function renderLiveCta(s) {
  const url = camAvailable() ? null : httpsUrl(s);
  $("#live-cta").classList.toggle("hidden", !url);
  $("#live-link-game").classList.toggle("hidden", !url);
  if (url) $("#live-link").href = $("#live-link-game").href = url;
}
function renderLobby(s) {
  const m = me.load();
  const you = s.players.find((p) => m && p.id === m.id);
  $("#lobby-you").innerHTML = you ? `<span class="sw" style="background:${you.color}"></span>You are <b>${esc(you.name)}</b> · marker #${you.marker_id}` : "";
  $("#lobby-players").innerHTML = s.players.map(playerRow).join("");
}
function renderStandings(sel, s) {
  const sorted = [...s.players].sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
  $(sel).innerHTML = sorted.map(playerRow).join("");
}
function renderFeed(events) {
  $("#feed").innerHTML = events.slice(-4).reverse().map((e) => `<li>${esc(e.msg)}</li>`).join("");
}
function renderMyHp(s) {
  const el = $("#my-hp");
  if (!s.you) { el.innerHTML = ""; return; }
  const hp = cfg.hits_to_eliminate, left = Math.max(0, hp - s.you.hits_taken);
  el.innerHTML = `<span class="k">Your HP</span><span class="v">${left}<span style="color:var(--text-3)">/${hp}</span></span>${hpBar(s.you)}`;
}

async function enterPlay() {
  mode = "play";
  balls = []; pops = []; damage = []; pending.clear(); seenPaint.clear(); targets.clear();
  liveMode = await startVideo();
  $("#photo-ui").classList.toggle("hidden", liveMode);
  $("#arm").classList.toggle("hidden", !liveMode || armed);
  if (liveMode) {
    await new Promise((r) => (video.videoWidth ? r() : video.addEventListener("loadedmetadata", r, { once: true })));
    layout();
    detectTimer = setInterval(detectFrame, DETECT_MS);
    rafId = requestAnimationFrame(frame);
    startTelemetry();
  }
}
function leavePlay() { mode = "idle"; stopVideo(); stopTelemetry(); }

async function render() {
  try { st = await getState(); } catch { return; }
  const s = st, m = me.load();
  cfg = { ...cfg, ...s.config };
  if (s.you === null && m && s._token === m.token) {   // our *current* token is really gone
    me.clear(); leavePlay(); msg("The host restarted the match — join again.");
  }
  if (s.you) {
    myColor = s.you.color;
    const hp = cfg.hits_to_eliminate;
    if (lastHitsTaken !== null && s.you.hits_taken > lastHitsTaken && mode === "play") {
      const attacker = s.you.paint[s.you.paint.length - 1] || "#ff4d5e";
      gotHit(attacker, Math.max(0, hp - s.you.hits_taken), hp);
    }
    lastHitsTaken = s.you.hits_taken;
  } else lastHitsTaken = null;
  byMarker = new Map(s.players.map((p) => [p.marker_id, p]));
  for (const p of s.players) {                  // retire optimistic hits the server has now confirmed
    const seen = seenPaint.get(p.marker_id) ?? p.paint.length;
    const confirmed = p.paint.length - seen;
    if (confirmed > 0 && pending.has(p.marker_id)) {
      const left = pending.get(p.marker_id) - confirmed;
      if (left > 0) pending.set(p.marker_id, left); else pending.delete(p.marker_id);
    }
    seenPaint.set(p.marker_id, p.paint.length);
  }
  $("#hud-alive").textContent = `${s.alive}/${s.players.length}`;
  renderMyHp(s);
  renderFeed(s.events);
  renderLiveCta(s);

  if (s.phase === "lobby") {
    leavePlay(); renderLobby(s);
    show(me.load() ? "s-lobby" : "s-join");
  } else if (s.phase === "running") {
    if (!me.load()) { leavePlay(); msg("Game in progress — join now to jump straight in."); show("s-join"); }
    else if (s.you && !s.you.alive) {
      renderStandings("#dead-standings", s);
      if (mode === "play" && !deadTimer) deadTimer = setTimeout(() => { deadTimer = null; leavePlay(); show("s-dead"); }, 1600);
      else if (mode !== "play") show("s-dead");
    }
    else { if (mode !== "play") await enterPlay(); show("s-game"); }
  } else if (s.phase === "ended") {
    leavePlay();
    $("#winner").innerHTML = s.winner ? `<span style="color:${s.winner.color};font-weight:800">${esc(s.winner.name)}</span> takes it.` : "No one left standing.";
    renderStandings("#end-standings", s);
    show("s-end");
  }
}

async function adoptHandoff() {
  const t = new URLSearchParams(location.search).get("t");
  if (!t) return;
  history.replaceState(null, "", location.pathname);
  try {
    const s = await (await fetch("/api/state?token=" + encodeURIComponent(t))).json();
    if (s.you) me.save({ ...s.you, token: t });
  } catch { /* fall through to a normal join */ }
}

window.addEventListener("load", async () => {
  try { detector = new AR.Detector(); } catch { msg("marker library failed to load"); return; }
  await adoptHandoff();
  render();
  setInterval(render, POLL_MS);
});
