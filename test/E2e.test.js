// End-to-end: starts the real server on a free port with two tiny teams, then plays a match
// with two real WebSocket clients. Run with: npm test
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const hist = "012345012345012345012";
const TEAMS = [
  { name: "Alpha", sport: "NFL", conference: "NFC", division: "East", history: hist },
  { name: "Beta", sport: "NFL", conference: "NFC", division: "West", history: hist },
];

let proc, port;

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

before(async () => {
  port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "duel-"));
  writeFileSync(join(dir, "pro.json"), JSON.stringify(TEAMS));
  proc = spawn(process.execPath, [fileURLToPath(new URL("../server/index.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, TURN_MS: "700", GRACE_MS: "1500" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((res, rej) => {
    proc.stdout.on("data", d => { if (String(d).includes("listening")) res(); });
    proc.on("exit", c => rej(new Error("server exited early: " + c)));
    setTimeout(() => rej(new Error("server did not start")), 5000);
  });
});

after(() => { proc && proc.kill(); });

function client(id, name) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const msgs = [];
  const c = {
    ws, msgs,
    send: o => ws.send(JSON.stringify(o)),
    last: type => [...msgs].reverse().find(m => m.type === type),
    state: () => c.last("state")?.state,
    waitFor(pred, ms = 3000) {
      return new Promise((res, rej) => {
        const t0 = Date.now();
        const tick = () => {
          const hit = pred(c);
          if (hit) return res(hit);
          if (Date.now() - t0 > ms) return rej(new Error("timed out waiting; last messages: " + JSON.stringify(msgs.slice(-3))));
          setTimeout(tick, 15);
        };
        tick();
      });
    },
  };
  ws.on("message", raw => msgs.push(JSON.parse(raw.toString())));
  return new Promise(res => ws.on("open", () => { c.send({ type: "hello", playerId: id, name }); res(c); }));
}

test("static endpoints: teams.json has no histories, healthz works", async () => {
  const teams = await (await fetch(`http://localhost:${port}/teams.json`)).json();
  assert.equal(teams.pro.length, 2);
  assert.ok(!JSON.stringify(teams).includes("history"));
  assert.equal(teams.ncaa, undefined);                    // modes with no data file are disabled
  const health = await (await fetch(`http://localhost:${port}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal((await fetch(`http://localhost:${port}/../server/index.js`)).status === 200, false);
});

test("two clients queue, get paired, play to a win, and never see the answer early", async () => {
  const a = await client("player-aaaa", "Ann"), b = await client("player-bbbb", "Bo");
  await a.waitFor(c => c.last("welcome")); await b.waitFor(c => c.last("welcome"));
  a.send({ type: "queue", mode: "pro" }); b.send({ type: "queue", mode: "pro" });
  await a.waitFor(c => c.state()); await b.waitFor(c => c.state());

  const first = a.state().yourTurn ? a : b, second = first === a ? b : a;
  assert.equal(first.state().revealed.length, 3);
  assert.equal(first.state().answer, null);
  assert.equal(second.state().yourTurn, false);

  first.send({ type: "guess", team: "Alpha" });
  await second.waitFor(c => c.state() && c.state().guesses.length === 1 ? c.state() : null);
  const s = second.state();
  if (s.status === "over") {                              // Alpha was the answer: first player won
    assert.equal(s.winner, s.you === 0 ? 1 : 0);
  } else {                                                // otherwise Beta must be the answer: second player wins
    assert.equal(s.yourTurn, true);
    assert.equal(s.revealed.length, 6);
    second.send({ type: "guess", team: "Beta" });
    await first.waitFor(c => c.state().status === "over");
    assert.equal(first.state().winner, first.state().you === 0 ? 1 : 0);
    assert.equal(first.state().answer.name, "Beta");
    assert.equal(first.state().revealed.length, 21);
  }
  a.ws.close(); b.ws.close();
});

test("the server clock moves the game along when a player is too slow", async () => {
  const a = await client("player-cccc", "Cy"), b = await client("player-dddd", "Di");
  a.send({ type: "queue", mode: "pro" }); b.send({ type: "queue", mode: "pro" });
  await a.waitFor(c => c.state()); await b.waitFor(c => c.state());
  const first = a.state().yourTurn ? a : b, second = first === a ? b : a;
  const s = await second.waitFor(c => c.state() && c.state().yourTurn ? c.state() : null, 3000);
  assert.equal(s.guesses[0].timedOut, true);
  assert.equal(s.revealed.length, 6);
  a.ws.close(); b.ws.close();
});

test("a player who drops and never returns forfeits after the grace period", async () => {
  const a = await client("player-eeee", "Ed"), b = await client("player-ffff", "Flo");
  a.send({ type: "queue", mode: "pro", hard: true }); b.send({ type: "queue", mode: "pro", hard: true });
  await a.waitFor(c => c.state()); await b.waitFor(c => c.state());
  a.ws.close();
  await b.waitFor(c => c.state().opponent.connected === false);
  await b.waitFor(c => c.state().status === "over", 4000);
  assert.equal(b.state().reason, "forfeit");
  assert.equal(b.state().winner, b.state().you);
  b.ws.close();
});

test("bad input is refused without crashing the server", async () => {
  const a = await client("player-gggg", "Gus");
  await a.waitFor(c => c.last("welcome"));
  a.ws.send("not json");
  a.send({ type: "queue", mode: "nope" });
  a.send({ type: "wat" });
  await a.waitFor(c => c.msgs.filter(m => m.type === "error").length >= 3);
  assert.deepEqual(a.msgs.filter(m => m.type === "error").map(m => m.code), ["bad_json", "bad_mode", "unknown_type"]);
  a.ws.close();
});

test("the first message on a connection must be hello", async () => {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const got = await new Promise(res => { ws.on("open", () => ws.send(JSON.stringify({ type: "cancel" }))); ws.on("message", r => res(JSON.parse(r.toString()))); });
  assert.equal(got.code, "say_hello_first");
  ws.close();
});

test("private room over real sockets: host gets a code, a friend joins it, both are in the host's game", async () => {
  const a = await client("player-hhhh", "Hal"), b = await client("player-iiii", "Ida");
  await a.waitFor(c => c.last("welcome")); await b.waitFor(c => c.last("welcome"));
  a.send({ type: "createRoom", mode: "pro", name: "Hal" });
  const room = await a.waitFor(c => c.last("room"));
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{5}$/);
  b.send({ type: "joinRoom", code: room.code.toLowerCase(), name: "Ida" });
  await a.waitFor(c => c.state()); await b.waitFor(c => c.state());
  assert.deepEqual(a.state().players.sort(), ["Hal", "Ida"]);
  assert.equal(a.state().answer, null);
  b.send({ type: "joinRoom", code: room.code });          // the same code again is dead
  await b.waitFor(c => c.last("error"));
  assert.ok(["room_not_found", "in_match"].includes(b.last("error").code));
  a.ws.close(); b.ws.close();
});

test("a malformed room code is refused", async () => {
  const a = await client("player-jjjj", "Jo");
  await a.waitFor(c => c.last("welcome"));
  a.send({ type: "joinRoom", code: "!!" });
  await a.waitFor(c => c.last("error"));
  assert.equal(a.last("error").code, "bad_code");
  a.ws.close();
});
