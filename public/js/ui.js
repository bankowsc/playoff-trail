// public/js/ui.js — turns server snapshots into DOM. No networking in here, and no game rules:
// the server decides everything, this file only draws what it is told.

import { MODES } from "./modes.js";

export const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const normColor = c => String(c).replace(/\uFE0F/g, "").toLowerCase();

// ---------- screens, status, messages ----------
const SCREENS = ["lobby", "searching", "room", "match"];
export function showScreen(name) { for (const s of SCREENS) $("screen-" + s).hidden = s !== name; }

const STATUS = { connecting: "Connecting…", online: "Online", reconnecting: "Reconnecting…", replaced: "Open in another tab" };
export function setStatus(state) {
  const el = $("status");
  el.textContent = STATUS[state] || state;
  el.dataset.state = state;
  const banner = $("banner");
  banner.hidden = !(state === "reconnecting" || state === "replaced");
  banner.textContent = state === "replaced"
    ? "This player is now open in another tab. Close the other tab, then refresh this one."
    : "Connection lost. Trying to get you back in…";
}

const ERRORS = {
  not_your_turn: "It's not your turn.", unknown_team: "Pick a team from the list.", already_guessed: "That team was already guessed.",
  too_late: "Too slow! Your time ran out.", in_match: "You're already in a match.", bad_mode: "That game isn't available right now.",
  opponent_gone: "Your opponent has left.", not_over: "The match isn't finished yet.", no_match: "You're not in a match.",
  bad_team: "Pick a team from the list.", not_playing: "The match is over.",
  room_not_found: "That invite isn't valid anymore. Ask your friend for a new link.", own_room: "That's your own invite. Send it to a friend.",
  room_expired: "That lobby closed because nobody was using it.", bad_code: "That code doesn't look right.",
  room_full: "That lobby is full (7 players).", room_busy: "A game is in progress in that lobby. Try again when it ends.",
  not_host: "Only the host can start the game.", not_enough_players: "You need at least 2 players who are ready.",
  already_playing: "A game is already running.", no_room: "You're not in a lobby.",
  removed_not_ready: "You weren't ready for the next game, so you left the lobby.",
};
export const errorText = code => ERRORS[code] || "Something went wrong. Try again.";

let toastTimer;
export function toast(msg, good = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("ok", good);
  el.hidden = false;
  el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

export function shake() {
  const f = $("form");
  f.classList.remove("shake"); void f.offsetWidth; f.classList.add("shake");
}

// ---------- lobby + searching ----------
export function renderLobby({ available, mode, hard }) {
  $("modeSeg").innerHTML = Object.entries(MODES).map(([m, c]) =>
    `<button type="button" data-m="${m}" class="${m === mode ? "on" : ""}" ${available.includes(m) ? "" : "disabled"}>${esc(c.label)}<small>${esc(c.blurb)}</small></button>`).join("");
  $("hard").checked = hard;
  $("find").disabled = !available.includes(mode);
  $("invite").disabled = !available.includes(mode);
}

export function renderSearching({ mode, hard }) {
  $("searchTitle").textContent = "Looking for an opponent…";
  $("searchInfo").textContent = `${MODES[mode].label}${hard ? " · Hard mode" : ""}`;
  $("inviteInstead").hidden = false;
}

// Shown while a friend's invite code is being checked.
export function renderJoining(code) {
  $("searchTitle").textContent = "Joining your friend's room…";
  $("searchInfo").textContent = `Room ${code}`;
  $("inviteInstead").hidden = true;
}

// The private-room screen: the code, the link to share, and what game it is.
export function renderRoom(lobby, link) {
  $("roomCode").textContent = lobby.code;
  $("roomLink").value = link;
  $("roomInfo").textContent = `${MODES[lobby.mode].label}${lobby.hard ? " · Hard mode" : ""} · up to ${lobby.max} players`;
  $("roomCount").textContent = `${lobby.members.length} / ${lobby.max}`;
  $("members").innerHTML = membersHtml(lobby.members);
  const start = $("startBtn");
  start.hidden = !lobby.isHost;
  start.disabled = !lobby.canStart;
  start.textContent = lobby.canStart ? `Start game (${lobby.startCount} players)` : "Start game (need 2 or more)";
  $("roomHint").textContent = lobby.isHost
    ? (lobby.canStart ? "Ready when you are. Press Start." : "Share the code or link. You can start once a second player joins.")
    : "Waiting for the host to start the game…";
  $("shareLink").hidden = $("copyLink").hidden = lobby.members.length >= lobby.max;
}

// One row per lobby member: crown for the host, win count, and whether they are in for the next game.
function membersHtml(members) {
  return members.map(m =>
    `<li class="member${m.you ? " you" : ""}${m.connected ? "" : " away"}">` +
    `<span class="mName">${m.host ? "👑 " : ""}${esc(m.name)}${m.you ? " <small>(you)</small>" : ""}${m.connected ? "" : " <small>reconnecting…</small>"}</span>` +
    `<span class="mRight"><span class="mWins" title="Wins in this lobby">🏆 ${m.wins}</span>` +
    `<span class="mReady ${m.ready ? "yes" : "no"}">${m.ready ? "ready" : "deciding"}</span></span></li>`).join("");
}

// ---------- match ----------
let prev = { matchId: null, revealed: new Set(), yourTurn: false, over: false };
let raf = 0;

export function resetMatchView() { stopClock(); prev = { matchId: null, revealed: new Set(), yourTurn: false, over: false }; }
export function stopClock() { cancelAnimationFrame(raf); }

// Returns what changed, so main.js can react (confetti, focusing the box).
export function renderMatch(snap, offset) {
  const cfg = MODES[snap.mode];
  const newMatch = snap.matchId !== prev.matchId;
  if (newMatch) {
    prev = { matchId: snap.matchId, revealed: new Set(), yourTurn: false, over: false };
    $("legend").innerHTML = cfg.legend.map(([cls, icon, text], i) => `<span style="--i:${i}"><i class="dot ${cls}">${icon}</i>${esc(text)}</span>`).join("");
    $("input").value = "";
  }
  renderBar(snap);
  renderTrail(snap, cfg);
  renderHints(snap, cfg);
  renderGuesses(snap);
  renderEnd(snap);
  renderInput(snap);
  runClock(snap, offset);

  const over = snap.status === "over";
  const info = { newMatch, justOver: over && !prev.over, won: over && !prev.over && snap.winner === snap.you, gotYourTurn: snap.yourTurn && !prev.yourTurn };
  prev.yourTurn = snap.yourTurn;
  prev.over = over;
  return info;
}

function renderBar(snap) {
  const me = snap.you, playing = snap.status === "playing", n = snap.players.length;
  $("vs").innerHTML = snap.players.map((pl, i) => {
    const note = i === me ? "you" : pl.left ? "left" : !pl.connected ? "reconnecting…" : "";
    const wins = snap.lobby ? `<small class="wins">🏆${pl.wins || 0}</small>` : "";
    return `<div class="who ${i === me ? "you" : "opp"} ${playing && snap.turn === i ? "turn" : ""} ${pl.left ? "gone" : ""}" style="--pc:var(--p${i})">` +
      `<span class="pmark"></span><b>${esc(pl.name)}</b>${note ? `<small>${note}</small>` : ""}${wins}</div>`;
  }).join(n === 2 ? `<span class="vsTxt">vs</span>` : "");
  $("turnMsg").textContent = playing
    ? (snap.yourTurn ? "Your turn. Name the franchise!" : `${snap.players[snap.turn].name} is thinking…`)
    : "Match over";
  $("leaveGame").hidden = !playing;                      // you can walk away while a game is running
  $("bar").classList.toggle("mine", snap.yourTurn);
  $("bar").classList.toggle("over", !playing);
  $("bar").classList.remove("low");
}

function renderTrail(snap, cfg) {
  const rev = new Map(snap.revealed);
  let html = "";
  for (let i = 0; i < snap.years; i++) {
    const hidden = !rev.has(i), v = rev.get(i);
    const isNew = !hidden && !prev.revealed.has(i);
    const dot = hidden ? "" : v === 0 ? "x" : cfg.prefix + v;
    html += `<div class="season${hidden ? " hidden" : ""}${isNew ? " new" : ""}"><i class="dot ${dot}">${hidden ? "?" : (cfg.icons[v] ?? "")}</i><b>${snap.startYear - i}</b></div>`;
  }
  $("trail").innerHTML = html;
  prev.revealed = new Set(rev.keys());
  $("count").textContent = snap.status === "playing" ? `Turn ${Math.min(snap.step + 1, snap.maxSteps)} of ${snap.maxSteps}` : "Final";
  $("shown").textContent = `Showing ${rev.size} of ${snap.years} seasons`;
  $("shown").parentElement.style.setProperty("--p", rev.size / snap.years);       // fills the thin progress bar under this line
}

function renderHints(snap, cfg) {
  const L = cfg.labels, h = snap.hints, real = snap.guesses.filter(g => g.result), over = snap.status === "over";
  const got = { sport: real.some(g => g.result.sport), conf: real.some(g => g.result.conf), third: real.some(g => g.result.third === 2) };
  const cell = (cls, label, val) => `<div class="hint ${cls}"><small>${esc(label)}</small><strong>${val}</strong></div>`;
  const std = (k, label, val) => cell(got[k] ? "on" : val ? "reveal" : "", label, val ? esc(val) : "?");

  let third;
  if (Array.isArray(h.third)) {                                     // NCAA colors: one slot per color
    const guessed = new Set(real.flatMap(g => g.colors || []).map(normColor));
    const all = h.third.length && h.third.every(c => c && guessed.has(normColor(c)));
    const some = h.third.some(c => c && guessed.has(normColor(c)));
    const shown = h.third.map(c => c ? `<span class="cdot">${esc(c)}</span>` : "?").join(" ");
    third = cell(all ? "on" : some ? "part" : over ? "reveal" : "", L[2], shown || "?");
  } else {
    third = std("third", L[2], h.third);
  }
  $("hints").innerHTML = std("sport", L[0], h.sport) + std("conf", L[1], h.conf) + third;
}

function renderGuesses(snap) {
  const me = snap.you;
  const chip = (cls, html) => `<span class="chip ${cls}">${html || "—"}</span>`;
  $("guesses").innerHTML = snap.guesses.slice().reverse().map(g => {           // newest first
    const mine = g.by === me, who = mine ? "You" : snap.players[g.by].name, pc = `style="--pc:var(--p${g.by})"`;
    if (g.timedOut || g.left) return `<div class="guess timed ${mine ? "mine" : "theirs"}" ${pc}><span class="n"><small>${esc(who)}</small>${g.left ? "🚪 left the game" : "⏱ ran out of time"}</span></div>`;
    const r = g.result;
    const third = g.colors
      ? chip(["", "part", "ok"][r.third], g.colors.map(c => `<span class="cdot">${esc(c)}</span>`).join(""))
      : chip(r.third === 2 ? "ok" : "", esc(g.division));
    return `<div class="guess ${mine ? "mine" : "theirs"}" ${pc}><span class="n"><small>${esc(who)}</small>${esc(g.team)}</span>` +
      `${chip(r.sport ? "ok" : "", esc(g.sport))}${chip(r.conf ? "ok" : "", esc(g.conference))}${third}</div>`;
  }).join("");
}

function renderEnd(snap) {
  const el = $("end");
  if (snap.status !== "over") { el.innerHTML = ""; return; }
  const me = snap.you, won = snap.winner === me, draw = snap.winner === null, L = snap.lobby;
  const winName = draw ? "" : snap.players[snap.winner].name;
  let head, sub;
  if (draw) { head = "Draw"; sub = "Every season was revealed and nobody got it."; }
  else if (snap.reason === "forfeit") { head = won ? "You win!" : `${winName} wins`; sub = snap.players.length === 2 ? "Your opponent left the match." : "Everyone else left the match."; }
  else { head = won ? "You got it!" : `${winName} got it`; sub = won ? "Nice work." : "Better luck next time."; }
  const a = snap.answer || {};
  const top =
    `<div class="endHead">${won ? '<span class="bigTrophy">🏆</span>' : ""}<h2>${esc(head)}</h2></div>` +
    `<p>${esc(sub)}</p>` +
    `<p class="answerLine">The team was <b>${esc(a.name)}</b></p>` +
    `<p class="answerSub">${esc([a.sport, a.conference, a.colors ? a.colors.join("") : a.division].filter(Boolean).join(" · "))}</p>`;
  const cls = won ? "won" : draw ? "draw" : "lost";

  if (!L) {                                                // a public 1v1 match: rematch with the same opponent, or find a new one
    const others = snap.players.filter((_, i) => i !== me);
    const gone = others.every(p => p.left || !p.connected);
    const mineVote = snap.rematch[me], theirVote = snap.rematch.some((v, i) => v && i !== me);
    const rematchLabel = gone ? "Opponent left" : mineVote ? "Waiting for opponent…" : "Play again";
    el.innerHTML = `<div class="end ${cls}">${top}` +
      (theirVote && !mineVote && !gone ? `<p class="rematchNote">${esc(others[0].name)} wants a rematch!</p>` : "") +
      `<div class="endBtns">` +
      `<button id="rematch" class="primary" type="button" ${mineVote || gone ? "disabled" : ""}>${rematchLabel}</button>` +
      `<button id="newOpp" class="alt" type="button">New opponent</button>` +
      `<button id="share" class="alt" type="button">Share</button>` +
      `<button id="toLobby" class="alt" type="button">Lobby</button>` +
      `</div></div>`;
    return;
  }

  // A private lobby: the scoreboard, who is ready for the next game, and the host's Start button.
  const mine = L.members.find(m => m.you) || {};
  const board = membersHtml([...L.members].sort((x, y) => y.wins - x.wins));      // most wins first; ties keep join order
  const hint = L.isHost
    ? (L.members.length < 2 ? "You're the only one here. Invite friends with the code or link."
      : L.canStart ? "Start when everyone who wants another game is ready. Anyone who isn't ready is left out of the next game."
        : "Press Play again, then wait for at least one other player to be ready.")
    : (mine.ready ? "You're in. Waiting for the host to start the next game…" : "Press Play again to stay in for the next game.");
  el.innerHTML = `<div class="end ${cls}">${top}` +
    `<ul class="members board">${board}</ul>` +
    `<p class="lobbyHint">${esc(hint)}</p>` +
    `<div class="endBtns">` +
    `<button id="rematch" class="${L.isHost ? "alt" : "primary"}" type="button" ${mine.ready ? "disabled" : ""}>${mine.ready ? "Ready ✓" : "Play again"}</button>` +
    (L.isHost ? `<button id="startNext" class="primary" type="button" ${L.canStart ? "" : "disabled"}>Start next game (${L.startCount})</button>` : "") +
    (L.members.length < L.max ? `<button id="inviteMore" class="alt" type="button">Invite more (${L.members.length}/${L.max})</button>` : "") +
    `<button id="share" class="alt" type="button">Share</button>` +
    `<button id="toLobby" class="alt" type="button">Leave lobby</button>` +
    `</div></div>`;
}

function renderInput(snap) {
  const can = snap.status === "playing" && snap.yourTurn;
  $("input").disabled = !can;
  $("btn").disabled = !can;
  $("input").placeholder = can ? "Your turn. Pick a team" : snap.status === "playing" ? `Waiting for ${snap.players[snap.turn].name}…` : "Match over";
  $("form").hidden = snap.status === "over";
  $("form").classList.toggle("off", !can);
}

// Counts down to the server's deadline. Uses the server's clock (offset), never the player's own.
function runClock(snap, offset) {
  stopClock();
  const num = $("clockNum"), bar = $("clockBar"), box = $("bar");
  if (snap.status !== "playing" || !snap.deadline) { num.textContent = ""; bar.style.width = "0%"; return; }
  const tick = () => {
    const left = Math.max(0, snap.deadline - (Date.now() + offset));
    num.textContent = Math.ceil(left / 1000);
    bar.style.width = `${Math.min(100, 100 * left / snap.turnMs)}%`;
    box.classList.toggle("low", left > 0 && left <= Math.min(5000, snap.turnMs / 3));
    if (left > 0) raf = requestAnimationFrame(tick);
  };
  tick();
}
