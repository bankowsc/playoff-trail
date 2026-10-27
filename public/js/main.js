// public/js/main.js — boots the app and wires the buttons to the server.

import { MODES } from "./modes.js";
import { createNet } from "./net.js";
import { createAutocomplete } from "./autocomplete.js";
import { buildShare } from "./share.js";
import { confetti } from "./fx.js";
import { startBackground } from "./bg.js";
import * as ui from "./ui.js";

const $ = ui.$;

// ---------- small helpers ----------
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { } },
};
function autoName() {                                       // "Player482", stable per tab so two tabs get different names
  try {
    let n = sessionStorage.getItem("duel:auto");
    if (!n) { n = "Player" + (100 + Math.floor(Math.random() * 900)); sessionStorage.setItem("duel:auto", n); }
    return n;
  } catch { return "Player"; }
}
const getName = () => ($("name").value.trim() || store.get("duel:name", "") || autoName()).slice(0, 16);

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const a = document.createElement("textarea"); a.value = t; document.body.appendChild(a); a.select();
    try { document.execCommand("copy"); } catch { }
    a.remove();
  }
}

// ---------- state ----------
let teams = {};                                             // { pro: [{name, sport, conference, division}], ... } from /teams.json
let available = [];
let snap = null;                                            // the latest match snapshot from the server
let room = null;                                            // { code, mode, hard, link } while you wait for a friend
let joining = false;                                        // true while a "join this room" request is in flight
const inviteLink = code => `${location.origin}${location.pathname}?room=${code}`;

// Opened from a friend's link (?room=ABCDE)? Remember the code; we join as soon as the connection is up.
const urlCode = (new URLSearchParams(location.search).get("room") || "").toUpperCase();
let pendingRoom = /^[A-Z0-9]{4,8}$/.test(urlCode) ? urlCode : null;

function joinWith(code) {
  joining = true;
  ui.renderJoining(code);
  ui.showScreen("searching");
  if (!net.send("joinRoom", { code, name: getName() })) { joining = false; ui.toast("Not connected yet. One moment…"); showLobby(); }
}
const settings = { mode: store.get("duel:mode", "pro"), hard: store.get("duel:hard", "0") === "1" };

// ---------- connection ----------
const net = createNet({
  url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  getName,
  onStatus: ui.setStatus,
  onMessage(m) {
    switch (m.type) {
      case "welcome":
        if (pendingRoom) {                                      // we arrived through an invite link
          const code = pendingRoom;
          pendingRoom = null;
          history.replaceState(null, "", location.pathname);    // so a refresh doesn't try the same code again
          joinWith(code);
        }
        break;
      case "idle":
        if (joining) break;                                     // the server says "idle" right after "welcome"; ignore it while joining
        snap = null; room = null; ui.resetMatchView(); document.title = "Playoff Duel";
        showLobby();
        break;
      case "queued":
        joining = false; snap = null; room = null;
        ui.renderSearching({ mode: m.mode, hard: m.hard });
        ui.showScreen("searching");
        break;
      case "room":
        joining = false; snap = null;
        room = { code: m.code, mode: m.mode, hard: m.hard, link: inviteLink(m.code) };
        ui.renderRoom(room);
        ui.showScreen("room");
        break;
      case "state":
        joining = false; room = null;
        onState(m.state);
        break;
      case "error":
        ui.toast(ui.errorText(m.code));
        if (m.code === "unknown_team" || m.code === "too_late" || m.code === "not_your_turn") ui.shake();
        if (joining && m.code !== "bad_json") { joining = false; showLobby(); }   // a failed join: back to the lobby
        break;
    }
  },
});

function onState(s) {
  snap = s;
  ui.showScreen("match");
  const info = ui.renderMatch(s, net.offset);
  ac.close(true);
  if (info.won) confetti();
  if (info.gotYourTurn && matchMedia("(hover: hover)").matches) $("input").focus();
  document.title = s.status === "playing" && s.yourTurn ? "⏱ Your turn · Playoff Duel" : "Playoff Duel";
}

function showLobby() {
  ui.renderLobby({ available, mode: settings.mode, hard: settings.hard });
  ui.showScreen("lobby");
}

// ---------- autocomplete ----------
const ac = createAutocomplete({
  input: $("input"), list: $("acList"),
  getTeams: () => (snap ? teams[snap.mode] || [] : []),
  getUsed: () => (snap ? snap.guesses.filter(g => g.team).map(g => g.team) : []),
  canOpen: () => !!snap && snap.status === "playing" && snap.yourTurn,
});

// ---------- Dark / Light: dark by default (it does NOT follow the computer's setting), remembered ----------
function applyScheme(light) {
  document.documentElement.dataset.scheme = light ? "light" : "dark";
  $("light").checked = light;
}
applyScheme(store.get("duel:scheme", "dark") === "light");
$("light").addEventListener("change", () => {
  store.set("duel:scheme", $("light").checked ? "light" : "dark");
  applyScheme($("light").checked);
});

// ---------- Patterns (colour-blind friendly colours + dot patterns): off by default, remembered ----------
function applyPatterns(on) {
  document.documentElement.dataset.theme = on ? "Patterns" : "Default";
  $("patterns").checked = on;
}
applyPatterns(store.get("duel:patterns", "0") === "1");
$("patterns").addEventListener("change", () => {
  store.set("duel:patterns", $("patterns").checked ? "1" : "0");
  applyPatterns($("patterns").checked);
});

// ---------- lobby controls ----------
$("name").value = store.get("duel:name", "");
$("name").addEventListener("change", () => store.set("duel:name", $("name").value.trim()));
$("name").addEventListener("keydown", e => { if (e.key === "Enter") $("find").click(); });

$("modeSeg").addEventListener("click", e => {
  const b = e.target.closest("button[data-m]");
  if (!b || b.disabled) return;
  settings.mode = b.dataset.m;
  store.set("duel:mode", settings.mode);
  ui.renderLobby({ available, ...settings });
});
$("hard").addEventListener("change", () => { settings.hard = $("hard").checked; store.set("duel:hard", settings.hard ? "1" : "0"); });

$("find").addEventListener("click", () => {
  if (!available.includes(settings.mode)) return ui.toast("That game isn't available right now.");
  store.set("duel:name", $("name").value.trim());
  if (!net.send("queue", { mode: settings.mode, hard: settings.hard, name: getName() })) ui.toast("Not connected yet. One moment…");
});
$("cancel").addEventListener("click", () => net.send("cancel"));

// ---------- invite a friend ----------
function makeRoom() {
  if (!available.includes(settings.mode)) return ui.toast("That game isn't available right now.");
  store.set("duel:name", $("name").value.trim());
  if (!net.send("createRoom", { mode: settings.mode, hard: settings.hard, name: getName() })) ui.toast("Not connected yet. One moment…");
}
$("invite").addEventListener("click", makeRoom);
$("inviteInstead").addEventListener("click", makeRoom);          // from the "searching" screen: leaves the queue and opens a room

function joinTyped() {
  const code = $("codeIn").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) return ui.toast(ui.errorText("bad_code"));
  joinWith(code);
}
$("joinBtn").addEventListener("click", joinTyped);
$("codeIn").addEventListener("keydown", e => { if (e.key === "Enter") joinTyped(); });

$("roomLink").addEventListener("focus", () => $("roomLink").select());
$("cancelRoom").addEventListener("click", () => net.send("cancel"));
$("copyLink").addEventListener("click", async () => {
  if (!room) return;
  await copyText(room.link);
  const b = $("copyLink"); b.textContent = "Copied!";
  setTimeout(() => { b.textContent = "Copy link"; }, 1800);
});
$("shareLink").addEventListener("click", async () => {          // phones get the real share sheet (messages, WhatsApp, ...)
  if (!room) return;
  const text = "Think you know your playoff history? Duel me!";
  if (navigator.share) {
    try { await navigator.share({ title: "Playoff Duel", text, url: room.link }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }       // closed the sheet: do nothing; any other failure falls back to copying
  }
  await copyText(`${text} ${room.link}`);
  ui.toast("Invite copied. Paste it to a friend.", true);
});

// ---------- match controls ----------
$("form").addEventListener("submit", e => {
  e.preventDefault();
  if (!snap || !snap.yourTurn) return;
  const typed = $("input").value.trim().toLowerCase();
  const team = (teams[snap.mode] || []).find(t => t.name.toLowerCase() === typed);
  if (!team) { ui.toast(ui.errorText("unknown_team")); ui.shake(); return; }
  if (snap.guesses.some(g => g.team === team.name)) { ui.toast(ui.errorText("already_guessed")); ui.shake(); return; }
  if (net.send("guess", { team: team.name })) { $("input").value = ""; ac.close(true); }
  else ui.toast("Not connected. Your guess wasn't sent.");
});

$("end").addEventListener("click", async e => {              // the end-card buttons are re-rendered, so listen on the parent
  const b = e.target.closest("button[id]");
  if (!b || b.disabled) return;
  if (b.id === "rematch") net.send("rematch");
  else if (b.id === "newOpp") net.send("newOpponent");
  else if (b.id === "toLobby") net.send("leave");
  else if (b.id === "share" && snap) {
    await copyText(buildShare(snap));
    const old = b.textContent; b.textContent = "Copied!";
    setTimeout(() => { if (b.isConnected) b.textContent = old; }, 1800);
  }
});

// ---------- start ----------
(async function boot() {
  startBackground();
  try {
    teams = await (await fetch("/teams.json")).json();
    available = Object.keys(teams).filter(m => MODES[m]);
    if (!available.includes(settings.mode)) settings.mode = available[0] || "pro";
  } catch {
    ui.toast("Couldn't load the team list. Is the server running?");
  }
  showLobby();
  net.connect();
})();
