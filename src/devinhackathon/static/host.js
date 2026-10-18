"use strict";
const $ = (s) => document.querySelector(s);

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

async function admin(body) {
  const r = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await r.json();
  $("#admin-msg").textContent = res.ok ? "ok" : res.message || "failed";
  return res;
}

let qrFor = "";
function renderQr(url) {
  if (url === qrFor) return;
  qrFor = url;
  const q = qrcode(0, "M");
  q.addData(url);
  q.make();
  $("#qr").innerHTML = q.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
}

// ---------- live map ----------

const mapEl = $("#map"), mx = mapEl.getContext("2d");
let lastState = null;
const hitFlash = new Map();     // victim name -> time of last hit (from the event feed)
const seenEvents = new Set();
function noteHits(events) {
  for (const e of events) {
    const key = e.ts + e.msg;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    const m = e.msg.match(/^(.+?) (?:inked|SPLATTED) (.+?)(?: \(|!|$)/);
    if (m && Date.now() / 1000 - e.ts < 5) hitFlash.set(m[2], performance.now());
  }
}
const smooth = new Map();       // id -> displayed pos, eased toward server pos
function drawMap() {
  requestAnimationFrame(drawMap);
  const s = lastState; if (!s || !s.map) return;
  const dpr = Math.min(2, devicePixelRatio || 1), W = mapEl.clientWidth, H = mapEl.clientHeight;
  if (mapEl.width !== W * dpr) { mapEl.width = W * dpr; mapEl.height = H * dpr; }
  mx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mx.clearRect(0, 0, W, H);
  const players = s.players, now = performance.now();
  // ease displayed positions
  for (const p of players) {
    const t = s.map[p.id]; if (!t) continue;
    const cur = smooth.get(p.id) || t.pos.slice();
    cur[0] += (t.pos[0] - cur[0]) * 0.12; cur[1] += (t.pos[1] - cur[1]) * 0.12;
    smooth.set(p.id, cur);
  }
  // fit bounds (include trails), min 8 m across
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const grow = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (const p of players) { const c = smooth.get(p.id); if (c) grow(c[0], c[1]); for (const q of (s.map[p.id]?.trail || [])) grow(q[0], q[1]); }
  if (!isFinite(minX)) { minX = -4; maxX = 4; minY = -4; maxY = 4; }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const span = Math.max(8, maxX - minX + 3, maxY - minY + 3);
  const k = Math.min(W, H) / span;
  const P = (x, y) => [W / 2 + (x - cx) * k, H / 2 + (y - cy) * k];
  const u = Math.max(1, Math.min(W, H) / 560);   // glyph scale for big screens
  // 1 m grid
  mx.strokeStyle = "rgba(255,255,255,.05)"; mx.lineWidth = 1;
  for (let g = Math.floor(cx - span); g <= cx + span; g++) { const [X] = P(g, 0); mx.beginPath(); mx.moveTo(X, 0); mx.lineTo(X, H); mx.stroke(); }
  for (let g = Math.floor(cy - span); g <= cy + span; g++) { const [, Y] = P(0, g); mx.beginPath(); mx.moveTo(0, Y); mx.lineTo(W, Y); mx.stroke(); }
  // scale bar + north
  mx.fillStyle = "rgba(255,255,255,.5)"; mx.font = `700 ${11 * u}px ui-monospace, Menlo, monospace`; mx.textAlign = "left"; mx.textBaseline = "alphabetic";
  mx.fillRect(W - 14 * u - k, 16 * u, k, 2); mx.fillText("1 m", W - 14 * u - k, 30 * u);
  mx.fillText("N ↑", W - 14 * u - k, 48 * u);
  // sighting lines
  for (const p of players) {
    const t = s.map[p.id]; const a = smooth.get(p.id); if (!t || !a) continue;
    for (const sg of t.seen) {
      const b = smooth.get(sg.id); if (!b) continue;
      const [x1, y1] = P(a[0], a[1]), [x2, y2] = P(b[0], b[1]);
      mx.strokeStyle = `rgba(255,255,255,${0.45 * (1 - sg.age / 3)})`; mx.lineWidth = 1.5; mx.setLineDash([4, 5]);
      mx.beginPath(); mx.moveTo(x1, y1); mx.lineTo(x2, y2); mx.stroke(); mx.setLineDash([]);
    }
  }
  // trails
  for (const p of players) {
    const t = s.map[p.id]; if (!t || t.trail.length < 2) continue;
    mx.lineWidth = 2 * u; mx.lineCap = "round"; mx.lineJoin = "round";
    for (let i = 1; i < t.trail.length; i++) {
      const a = P(...t.trail[i - 1]), b = P(...t.trail[i]);
      mx.strokeStyle = hexA(p.color, 0.08 + 0.5 * (i / t.trail.length));
      mx.beginPath(); mx.moveTo(a[0], a[1]); mx.lineTo(b[0], b[1]); mx.stroke();
    }
  }
  // players
  const hp = s.config.hits_to_eliminate;
  for (const p of players) {
    const t = s.map[p.id]; const c = smooth.get(p.id); if (!t || !c) continue;
    const [X, Y] = P(c[0], c[1]);
    const fl = hitFlash.get(p.name); const flashK = fl ? Math.max(0, 1 - (now - fl) / 900) : 0;
    if (flashK > 0) { mx.strokeStyle = `rgba(255,77,94,${flashK})`; mx.lineWidth = 3; mx.beginPath(); mx.arc(X, Y, (16 + 26 * (1 - flashK)) * u, 0, Math.PI * 2); mx.stroke(); }
    if (t.moving && p.alive) { mx.strokeStyle = hexA("#d6ff3d", 0.35 + 0.35 * Math.sin(now / 150)); mx.lineWidth = 2; mx.beginPath(); mx.arc(X, Y, 18 * u, 0, Math.PI * 2); mx.stroke(); }
    // heading wedge
    if (p.alive && t.online) {
      const h = (t.heading - 90) * Math.PI / 180;
      mx.fillStyle = hexA(p.color, 0.25);
      mx.beginPath(); mx.moveTo(X, Y); mx.arc(X, Y, 34 * u, h - 0.45, h + 0.45); mx.closePath(); mx.fill();
    }
    // dot
    mx.fillStyle = p.alive ? p.color : "#3b3b4e"; mx.beginPath(); mx.arc(X, Y, 11 * u, 0, Math.PI * 2); mx.fill();
    mx.strokeStyle = t.online ? "#0b0b10" : "rgba(255,255,255,.4)"; mx.lineWidth = 2; mx.stroke();
    if (!p.alive) { mx.strokeStyle = "#ff4d5e"; mx.lineWidth = 2.5; mx.beginPath(); mx.moveTo(X - 5 * u, Y - 5 * u); mx.lineTo(X + 5 * u, Y + 5 * u); mx.moveTo(X + 5 * u, Y - 5 * u); mx.lineTo(X - 5 * u, Y + 5 * u); mx.stroke(); }
    // label + HP pips
    mx.font = `800 ${12 * u}px ui-rounded, system-ui, sans-serif`; mx.textAlign = "center"; mx.textBaseline = "top";
    const label = p.name + (t.online ? "" : " · offline"), tw = mx.measureText(label).width;
    mx.fillStyle = "rgba(11,11,16,.85)"; rr(X - tw / 2 - 7 * u, Y + 15 * u, tw + 14 * u, 30 * u, 8 * u); mx.fill();
    mx.fillStyle = p.alive ? "#fff" : "#7e7e92"; mx.fillText(label, X, Y + 20 * u);
    const left = Math.max(0, hp - p.hits_taken), pw = Math.min(tw + 4 * u, 60 * u), seg = (pw - 2 * u * (hp - 1)) / hp;
    for (let i = 0; i < hp; i++) {
      mx.fillStyle = i < left ? (left / hp <= 0.34 ? "#ff4d5e" : left / hp <= 0.67 ? "#ffc53d" : "#4ade80") : "rgba(255,255,255,.18)";
      rr(X - pw / 2 + i * (seg + 2 * u), Y + 36 * u, seg, 4 * u, 1.5 * u); mx.fill();
    }
  }
}
function rr(x, y, w, h, r) { mx.beginPath(); mx.moveTo(x + r, y); mx.arcTo(x + w, y, x + w, y + h, r); mx.arcTo(x + w, y + h, x, y + h, r); mx.arcTo(x, y + h, x, y, r); mx.arcTo(x, y, x + w, y, r); mx.closePath(); }
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
requestAnimationFrame(drawMap);

let dirty = false;
["cfg-hits", "cfg-cd"].forEach((id) => {
  $("#" + id).addEventListener("input", () => (dirty = true));
});

async function render() {
  let s;
  try { s = await (await fetch("/api/state?map=1")).json(); } catch { return; }
  lastState = s;
  noteHits(s.events);
  $("#phase").textContent = s.phase;
  $("#alive").textContent = s.alive;
  $("#total").textContent = s.players.length;
  $("#winner").textContent = s.winner ? s.winner.name : "—";
  $("#winner").style.color = s.winner ? s.winner.color : "";
  // Always use the raw IP: ".local" (mDNS) doesn't resolve reliably on phones / event Wi-Fi.
  const host = s.lan_ip || location.hostname;
  const joinUrl = s.tls_port ? `https://${host}:${s.tls_port}` : `${location.protocol}//${host}:${location.port || 80}`;
  $("#join-url").textContent = joinUrl;
  renderQr(joinUrl);
  if (!dirty) {
    $("#cfg-hits").value = s.config.hits_to_eliminate;
    $("#cfg-cd").value = s.config.cooldown_s;
  }
  const hpN = s.config.hits_to_eliminate;
  const pips = (p) => {
    const left = Math.max(0, hpN - p.hits_taken), cls = left / hpN <= 0.34 ? "crit" : left / hpN <= 0.67 ? "low" : "";
    return `<span class="hp ${cls}">${Array.from({ length: hpN }, (_, i) => `<i class="${i < left ? "on" : ""}"></i>`).join("")}</span>`;
  };
  $("#board").innerHTML = s.players
    .map(
      (p) => `<tr class="${p.alive ? "" : "dead"}">
        <td><span class="sw-cell" style="background:${p.color}"></span>${esc(p.name)}${p.alive ? "" : ' <span class="tag out">out</span>'}</td>
        <td class="num">${p.marker_id}</td>
        <td>${pips(p)}</td>
        <td class="num">${p.kills}</td>
      </tr>`
    )
    .join("");
  $("#feed").innerHTML = s.events.slice(-15).reverse()
    .map((e) => `<li>${esc(e.msg)}</li>`).join("");
}

$("#btn-start").onclick = () => admin({ action: "start" });
$("#btn-reset").onclick = () => admin({ action: "reset" });
$("#btn-wipe").onclick = () => {
  if (confirm("Kick every player and start over? They will need to rejoin.")) admin({ action: "wipe" });
};
$("#btn-cfg").onclick = async () => {
  await admin({
    action: "config",
    hits_to_eliminate: Number($("#cfg-hits").value),
    cooldown_s: Number($("#cfg-cd").value),
  });
  dirty = false;
};

render();
setInterval(render, 1000);
