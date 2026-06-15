/* ────────────────────────────────────────────────────────────────────────
   controller-base.js — shared render + interaction layer.
   Generic over whatever .screen[data-theme] elements exist on the page.
   Each page only declares its theme tabs + caption text (window.CAPTIONS).
   ──────────────────────────────────────────────────────────────────────── */

const STATE = {
  you: { name: "Jordy", turn: 3, life: 40, lib: 47 },
  phase: ["Untap", "Upkeep", "Draw", "Main 1", "Combat", "Main 2", "End"],
  activePhase: 4, // Combat — so the attacker reads as live
  pool: [["w", 2], ["u", 1], ["b", 0], ["r", 3], ["g", 0]],
  opps: [
    { name: "Mara", life: 33, threat: false },
    { name: "Theo", life: 18, threat: true },
    { name: "Ines", life: 40, threat: false },
  ],
  board: [
    { nm: "Goblin Welder",      cost: ["r"],             type: "Creature — Goblin", pt: "1/1", summoning: true },
    { nm: "Ureni",              cost: ["3", "g", "u"],   type: "Creature — Dragon", pt: "8/8", attacking: true },
    { nm: "Solemn Simulacrum",  cost: ["4"],             type: "Artifact Creature", pt: "2/2" },
    { nm: "Smuggler's Copter",  cost: ["2"],             type: "Artifact — Vehicle", pt: "3/3", tapped: true },
  ],
  lands: [
    { tapped: false }, { tapped: false }, { tapped: true },
    { tapped: false }, { tapped: true }, { tapped: false },
  ],
  hand: [
    { nm: "Lightning Bolt", cost: ["r"],          type: "Instant" },
    { nm: "Farseek",        cost: ["1", "g"],     type: "Sorcery" },
    { nm: "Dragonlord",     cost: ["4", "u", "u"],type: "Creature — Dragon", pt: "5/7" },
    { nm: "Sol Ring",       cost: ["1"],          type: "Artifact" },
    { nm: "Counterspell",   cost: ["u", "u"],     type: "Instant" },
  ],
  zones: [{ b: "5", s: "Grave" }, { b: "2", s: "Exile" }, { b: "47", s: "Library" }],
  stack: 1,
};

const PIP = (sym, sm) => {
  const cls = isNaN(sym) ? sym.toLowerCase() : "c";
  return `<span class="pip ${cls}${sm ? " sm" : ""}">${sym.toUpperCase ? sym.toUpperCase() : sym}</span>`;
};
const cost = (arr, sm) => arr.map((c) => PIP(c, sm)).join("");

function poolHTML() {
  return `<div class="pool">${STATE.pool
    .map(([c, n]) => `<span class="manapip ${n === 0 ? "empty" : ""}">${PIP(c)}<span>${n}</span></span>`)
    .join("")}</div>`;
}

function cardHTML(c, idx, where) {
  const cls = [c.attacking ? "attacking" : "", c.tapped ? "tapped" : "", c.summoning ? "summoning" : ""].join(" ");
  return `<div class="card ${cls}" data-card="${idx}" data-where="${where}">
    <div class="banner"><span class="nm">${c.nm}</span><span class="cost">${cost(c.cost, true)}</span></div>
    <div class="art"></div>
    <div class="type">${c.type}</div>
    ${c.pt ? `<span class="pt">${c.pt}</span>` : ""}
  </div>`;
}

function controllerHTML() {
  const phasePills = STATE.phase
    .map((p, i) => `<span class="pill ${i === STATE.activePhase ? "on" : ""}">${p}</span>`)
    .join("");
  const opps = STATE.opps
    .map((o) => `<div class="opp ${o.threat ? "threat" : ""}"><span class="dot"></span>${o.name} <span class="hp">${o.life}</span></div>`)
    .join("");
  const perms = STATE.board.map((c, i) => cardHTML(c, i, "board")).join("");
  const lands = STATE.lands.map((l) => `<div class="land ${l.tapped ? "tapped" : ""}"></div>`).join("");
  const hand = STATE.hand.map((c, i) => cardHTML(c, i, "hand")).join("");
  const zones = STATE.zones.map((z) => `<div class="zbtn" data-zone="${z.s}"><b>${z.b}</b><small>${z.s}</small></div>`).join("");

  return `
    <div class="topbar">
      <div class="seg"><span class="dot"></span><b>${STATE.you.name}</b><span class="mini">T${STATE.you.turn}</span></div>
      <div class="phase-pills">${phasePills}</div>
      <div class="seg">${poolHTML()}</div>
      <div class="seg"><span class="mini">LIB ${STATE.you.lib}</span><span class="life">${STATE.you.life}</span></div>
    </div>

    <div class="opp-row">${opps}</div>

    <div class="board">
      <div class="row-label">Your battlefield</div>
      <div class="perms">${perms}</div>
      <div class="row-label">Lands</div>
      <div class="lands">${lands}</div>
    </div>

    <div class="handzone">
      <div class="hand">${hand}</div>
      <div class="grow"></div>
      <div class="zones">${zones}</div>
      <div class="prio has-priority">
        <span class="prio-stack ${STATE.stack ? "live" : ""}">Stack ${STATE.stack}</span>
        <button class="pbtn" data-hold>Hold</button>
        <button class="pbtn main" data-priority>Pass Priority</button>
        <button class="pbtn gear" data-gear>⚙</button>
        <div class="autopass" data-autopass>
          <h5>Auto-pass</h5>
          <div class="opt checked" data-opt><span class="box">✓</span>Pass on empty stack</div>
          <div class="opt checked" data-opt><span class="box">✓</span>Stop on my turn</div>
          <div class="opt" data-opt><span class="box"></span>Stop for instants</div>
          <div class="opt" data-opt><span class="box"></span>Stop when attacked</div>
        </div>
      </div>
    </div>

    <!-- action sheet -->
    <div class="sheet-wrap" data-sheet>
      <div class="modal-back" data-close></div>
      <div class="sheet">
        <div class="sheet-head">
          <div class="mini-card"></div>
          <div><h4 data-sheet-name>Card</h4><div class="type" data-sheet-type>—</div></div>
          <div class="cost" data-sheet-cost></div>
        </div>
        <div class="acts" data-sheet-acts></div>
      </div>
    </div>

    <!-- decision prompt (scry demo) -->
    <div class="prompt-wrap" data-prompt-wrap>
      <div class="modal-back" data-close></div>
      <div class="prompt">
        <div><h4>Scry 2</h4><span class="sub">Look at the top two cards — keep on top or send to the bottom.</span></div>
        <div class="scry-rows">
          ${[
            { nm: "Sol Ring", cost: ["1"], type: "Artifact" },
            { nm: "Mountain", cost: [], type: "Basic Land" },
          ]
            .map(
              (c, i) => `<div class="scry-card">
                ${cardHTML(c, "s" + i, "scry")}
                <div class="scry-toggle" data-scry>
                  <button class="sel">Top</button><button>Bottom</button>
                </div></div>`
            )
            .join("")}
        </div>
        <div class="prompt-foot"><button class="act primary" data-close>Confirm</button></div>
      </div>
    </div>`;
}

/* ── render every screen present on the page ───────────────────────────── */
const THEMES = Array.from(document.querySelectorAll(".screen")).map((s) => s.dataset.theme);
THEMES.forEach((t) => {
  document.getElementById("screen-" + t).innerHTML = controllerHTML();
});

/* ── tab switching ─────────────────────────────────────────────────────── */
const caption = document.getElementById("caption");
function activate(theme) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.dataset.theme === theme));
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.go === theme));
  if (window.CAPTIONS && caption) caption.innerHTML = window.CAPTIONS[theme] || "";
}
document.getElementById("tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (b) activate(b.dataset.go);
});
activate(THEMES[0]);

/* ── per-screen interactions ───────────────────────────────────────────── */
const ACTS = {
  hand: (c) => [
    { t: "Cast", s: "pay " + (c.cost.length ? "cost" : "free"), primary: true },
    { t: "Discard" },
    { t: "Reveal" },
    { t: "Details" },
  ],
  board: (c) => [
    { t: c.tapped ? "Untap" : "Tap", primary: true },
    ...(c.type.includes("Creature") ? [{ t: "Attack" }, { t: "Block" }] : []),
    { t: "Activate", s: "ability" },
    { t: "Move…", s: "to zone" },
    { t: "Details" },
  ],
};

document.querySelectorAll(".screen").forEach((screen) => {
  const sheet = screen.querySelector("[data-sheet]");
  const sName = screen.querySelector("[data-sheet-name]");
  const sType = screen.querySelector("[data-sheet-type]");
  const sCost = screen.querySelector("[data-sheet-cost]");
  const sActs = screen.querySelector("[data-sheet-acts]");
  const promptWrap = screen.querySelector("[data-prompt-wrap]");
  const autopass = screen.querySelector("[data-autopass]");

  function openSheet(card, where) {
    sName.textContent = card.nm;
    sType.textContent = card.type;
    sCost.innerHTML = cost(card.cost || [], false);
    sActs.innerHTML = (ACTS[where] || ACTS.board)(card)
      .map((a) => `<div class="act ${a.primary ? "primary" : ""}">${a.t}${a.s ? `<span class="sub">${a.s}</span>` : ""}</div>`)
      .join("");
    sheet.classList.add("show");
  }

  screen.addEventListener("click", (e) => {
    // card → action sheet
    const card = e.target.closest(".card[data-card]");
    if (card && card.dataset.where !== "scry") {
      const idx = card.dataset.card;
      const where = card.dataset.where;
      openSheet(STATE[where][idx], where);
      return;
    }
    // close any modal
    if (e.target.closest("[data-close]")) {
      sheet.classList.remove("show");
      promptWrap.classList.remove("show");
      return;
    }
    // land tap toggle
    const land = e.target.closest(".land");
    if (land) { land.classList.toggle("tapped"); return; }
    // library zone → scry demo prompt
    const zone = e.target.closest("[data-zone]");
    if (zone && zone.dataset.zone === "Library") { promptWrap.classList.add("show"); return; }
    // scry top/bottom toggle
    const scryBtn = e.target.closest(".scry-toggle button");
    if (scryBtn) {
      scryBtn.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("sel"));
      scryBtn.classList.add("sel");
      return;
    }
    // pass priority feedback
    const prio = e.target.closest("[data-priority]");
    if (prio) {
      const cluster = prio.closest(".prio");
      const orig = prio.textContent;
      prio.textContent = "Passed ✓";
      cluster.classList.remove("has-priority");
      setTimeout(() => { prio.textContent = orig; cluster.classList.add("has-priority"); }, 800);
      return;
    }
    // hold priority toggle
    const hold = e.target.closest("[data-hold]");
    if (hold) { hold.classList.toggle("held"); hold.textContent = hold.classList.contains("held") ? "Holding" : "Hold"; return; }
    // gear → auto-pass popover
    if (e.target.closest("[data-gear]")) { autopass.classList.toggle("show"); return; }
    // auto-pass option toggle
    const opt = e.target.closest("[data-opt]");
    if (opt) { opt.classList.toggle("checked"); opt.querySelector(".box").textContent = opt.classList.contains("checked") ? "✓" : ""; return; }
    // action inside sheet closes it (except keep open feel)
    if (e.target.closest(".sheet .act")) { sheet.classList.remove("show"); return; }
  });
});
