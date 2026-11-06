import test from "node:test";
import assert from "node:assert/strict";
import { Lobby } from "../server/lobby.js";

const hist = "012345012345012345012";
const teams = Array.from({ length: 6 }, (_, i) => ({ name: `T${i}`, sport: "NFL", conference: "NFC", division: "East", history: hist }));

// The secret team is random, so tests that need a wrong guess must ask which team is wrong.
const notSecret = lobby => teams.map(t => t.name).find(n => n !== [...lobby.matches.values()][0].target.name);

function fakeClock() {
    let t = 1_000_000, id = 0;
    const timers = new Map();
    return {
        now: () => t,
        setTimer: (fn, ms) => { const k = ++id; timers.set(k, { at: t + ms, fn }); return k; },
        clearTimer: k => timers.delete(k),
        tick(ms) {                                            // run every timer that comes due, in order
            const end = t + ms;
            for (; ;) {
                const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                timers.delete(next[0]);
                t = Math.max(t, next[1].at);
                next[1].fn();
            }
            t = end;
        },
    };
}
const conn = () => ({
    sent: [], closed: null, send(o) { this.sent.push(o); }, close(r) { this.closed = r; },
    last(type) { return [...this.sent].reverse().find(m => m.type === type); }
});

function setup(opts = {}) {
    const clock = fakeClock();
    const lobby = new Lobby({ teamsByMode: { pro: teams, ucl: teams }, turnMs: 30000, graceMs: 20000, random: () => 0, ...clock, ...opts });
    const join = (id, name = id) => { const c = conn(); lobby.connect(id, name, c); return c; };
    return { lobby, clock, join };
}

test("two players in the same queue get matched; the starter is p1 when random() is 0", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.enqueue("aaaaaaaa", "pro", false);
    assert.equal(a.last("queued").mode, "pro");
    assert.equal(b.last("state"), undefined);
    lobby.enqueue("bbbbbbbb", "pro", false);
    const sa = a.last("state").state, sb = b.last("state").state;
    assert.equal(sa.you, 0); assert.equal(sb.you, 1);
    assert.equal(sa.yourTurn, true); assert.equal(sb.yourTurn, false);
    assert.equal(sa.answer, null);
    assert.equal(lobby.stats().matches, 1);
});

test("different modes or difficulty never pair", () => {
    const { lobby, join } = setup();
    join("aaaaaaaa"); join("bbbbbbbb"); join("cccccccc");
    lobby.enqueue("aaaaaaaa", "pro", false);
    lobby.enqueue("bbbbbbbb", "ucl", false);
    lobby.enqueue("cccccccc", "pro", true);
    assert.equal(lobby.stats().matches, 0);
    assert.equal(lobby.stats().waiting, 3);
});

test("cancel removes a player from the queue", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"); join("bbbbbbbb");
    lobby.enqueue("aaaaaaaa", "pro", false);
    lobby.dequeue("aaaaaaaa");
    assert.equal(a.last("idle") !== undefined, true);
    lobby.enqueue("bbbbbbbb", "pro", false);
    assert.equal(lobby.stats().matches, 0);
});

test("a mode that failed to load is rejected", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa");
    lobby.enqueue("aaaaaaaa", "ncaa", false);
    assert.equal(a.last("error").code, "bad_mode");
});

test("the turn clock: running out of time reveals more clues and passes the turn", () => {
    const { lobby, clock, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.enqueue("aaaaaaaa", "pro", false); lobby.enqueue("bbbbbbbb", "pro", false);
    clock.tick(29000);
    assert.equal(b.last("state").state.yourTurn, false);
    clock.tick(2000);
    const sb = b.last("state").state;
    assert.equal(sb.yourTurn, true);
    assert.equal(sb.revealed.length, 6);
    assert.equal(sb.guesses[0].timedOut, true);
});

test("guess flow: wrong guess passes the turn and restarts the clock; wrong player gets an error", () => {
    const { lobby, clock, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.enqueue("aaaaaaaa", "pro", false); lobby.enqueue("bbbbbbbb", "pro", false);
    lobby.guess("bbbbbbbb", notSecret(lobby));
    assert.equal(b.last("error").code, "not_your_turn");
    lobby.guess("aaaaaaaa", notSecret(lobby));
    const sb = b.last("state").state;
    assert.equal(sb.yourTurn, true);
    assert.equal(sb.guesses.length, 1);
    clock.tick(29000);                                      // the old timer must not fire for the new turn
    assert.equal(b.last("state").state.guesses.length, 1);
});

test("a dropped player who does not return in time forfeits", () => {
    const { lobby, clock, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.enqueue("aaaaaaaa", "pro", false); lobby.enqueue("bbbbbbbb", "pro", false);
    lobby.disconnect("aaaaaaaa", a);
    assert.equal(b.last("state").state.players[0].connected, false);
    clock.tick(21000);
    const sb = b.last("state").state;
    assert.equal(sb.status, "over");
    assert.equal(sb.reason, "forfeit");
    assert.equal(sb.winner, 1);
    assert.equal(sb.answer !== null, true);
});

test("a player who reconnects within the grace period resumes the match", () => {
    const { lobby, clock, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.enqueue("aaaaaaaa", "pro", false); lobby.enqueue("bbbbbbbb", "pro", false);
    lobby.disconnect("aaaaaaaa", a);
    clock.tick(5000);
    const a2 = conn();
    lobby.connect("aaaaaaaa", "aaaaaaaa", a2);
    assert.equal(a2.last("welcome").resumed, true);
    assert.equal(a2.last("state").state.status, "playing");
    assert.equal(b.last("state").state.players[0].connected, true);
    clock.tick(60000);                                      // the grace timer must be cancelled; only the turn clock runs
    assert.notEqual(b.last("state").state.reason, "forfeit");
});

test("a second tab with the same id takes over; the old connection is told to close", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa");
    const a2 = conn();
    lobby.connect("aaaaaaaa", "aaaaaaaa", a2);
    assert.equal(a.closed, "replaced");
    lobby.disconnect("aaaaaaaa", a);                        // the old socket's close event arrives late: ignored
    assert.equal(lobby.stats().players, 1);
});

test("a disconnected player leaves the queue", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"); join("bbbbbbbb");
    lobby.enqueue("aaaaaaaa", "pro", false);
    lobby.disconnect("aaaaaaaa", a);
    lobby.enqueue("bbbbbbbb", "pro", false);
    assert.equal(lobby.stats().matches, 0);
});

test("rematch is refused once the opponent has left", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.enqueue("aaaaaaaa", "pro", false); lobby.enqueue("bbbbbbbb", "pro", false);
    lobby.leave("aaaaaaaa");                                // end the match quickly: p1 forfeits... then b can't rematch
    assert.equal(b.last("state").state.reason, "forfeit");
    lobby.rematch("bbbbbbbb");
    assert.equal(b.last("error").code, "opponent_gone");
});

test("rematch after a normal finish starts a fresh match with the other player first", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.enqueue("aaaaaaaa", "pro", false); lobby.enqueue("bbbbbbbb", "pro", false);
    const answer = (() => { // find the secret by playing guesses until someone wins
        for (const t of teams) {
            const s = a.last("state").state;
            const who = s.yourTurn ? "aaaaaaaa" : "bbbbbbbb";
            lobby.guess(who, t.name);
            if (a.last("state").state.status === "over") return t.name;
        }
    })();
    assert.ok(answer);
    lobby.rematch("aaaaaaaa");
    assert.equal(a.last("state").state.status, "over");     // one vote is not enough
    assert.deepEqual(a.last("state").state.rematch, [true, false]);
    lobby.rematch("bbbbbbbb");
    const sa = a.last("state").state, sb = b.last("state").state;
    assert.equal(sa.status, "playing");
    assert.equal(sa.guesses.length, 0);
    assert.equal(sb.yourTurn, true);                        // p2 starts the rematch
    assert.equal(lobby.stats().matches, 1);
});

test("new opponent: leaves the finished match, re-queues, and pairs with the next waiting player", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb"), c = join("cccccccc");
    lobby.enqueue("aaaaaaaa", "pro", false); lobby.enqueue("bbbbbbbb", "pro", false);
    lobby.leave("bbbbbbbb");                                // match over by forfeit
    lobby.enqueue("cccccccc", "pro", false);
    lobby.newOpponent("aaaaaaaa");
    assert.ok(a.last("state").state.players.some(pl => pl.name === "cccccccc"));
    assert.equal(a.last("state").state.status, "playing");
    assert.equal(lobby.stats().matches, 1);                 // the old match was cleaned up
});

test("cannot queue while a match is in progress", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"); join("bbbbbbbb");
    lobby.enqueue("aaaaaaaa", "pro", false); lobby.enqueue("bbbbbbbb", "pro", false);
    lobby.enqueue("aaaaaaaa", "pro", false);
    assert.equal(a.last("error").code, "in_match");
});

test("a late guess is rejected and the turn passes", () => {
    const { lobby, clock, join } = setup({});
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.enqueue("aaaaaaaa", "pro", false); lobby.enqueue("bbbbbbbb", "pro", false);
    // move the clock past the deadline without letting the timer run (simulates the guess racing the timer)
    const m = [...lobby.matches.values()][0];
    m.deadline = clock.now() - 1;
    lobby.guess("aaaaaaaa", notSecret(lobby));
    assert.equal(a.last("error").code, "too_late");
    assert.equal(b.last("state").state.yourTurn, true);
});

test("a name sent with the queue request is used in the match", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa", "Old"), b = join("bbbbbbbb", "Bo");
    lobby.enqueue("aaaaaaaa", "pro", false, "Ann");
    lobby.enqueue("bbbbbbbb", "pro", false);
    assert.deepEqual(a.last("state").state.players.map(pl => pl.name), ["Ann", "Bo"]);
});

// ---------------- private lobbies (invite friends, up to 7) ----------------
const names = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee", "ffffffff", "gggggggg", "hhhhhhhh"];
const secret = lobby => [...lobby.matches.values()].find(m => m.status === "playing").target.name;
const wrong = (lobby, n = 1) => teams.map(t => t.name).filter(t => t !== secret(lobby)).slice(0, n);
const lobbyOf = c => {                                     // the freshest lobby info a player has received
    const last = [...c.sent].reverse().find(m => m.type === "room" || (m.type === "state" && m.state.lobby));
    return last && (last.type === "room" ? last.room : last.state.lobby);
};
function lobbyOfN(n, opts = {}) {                         // n connected players; the first one has opened a lobby
    const ctx = setup(opts);
    const c = names.slice(0, n).map(id => ctx.join(id));
    ctx.lobby.createRoom(names[0], "pro", false);
    const code = c[0].last("room").room.code;
    for (let i = 1; i < n; i++) ctx.lobby.joinRoom(names[i], code);
    return { ...ctx, c, code };
}

test("a lobby: the host opens it, friends join with the code in any case, and everyone sees the roster", () => {
    const { lobby, join } = setup();
    const a = join(names[0]), b = join(names[1]), c = join(names[2]);
    lobby.createRoom(names[0], "ucl", true);
    const first = a.last("room").room;
    assert.match(first.code, /^[A-HJ-NP-Z2-9]{5}$/);
    assert.deepEqual([first.mode, first.hard, first.max, first.status, first.isHost, first.canStart], ["ucl", true, 7, "waiting", true, false]);
    lobby.joinRoom(names[1], first.code.toLowerCase());
    lobby.joinRoom(names[2], first.code);
    for (const x of [a, b, c]) assert.deepEqual(lobbyOf(x).members.map(m => m.name), names.slice(0, 3));
    assert.equal(lobbyOf(a).isHost, true); assert.equal(lobbyOf(b).isHost, false);
    assert.equal(lobbyOf(b).canStart, true); assert.equal(lobbyOf(b).readyCount, 3);
    assert.ok(lobbyOf(b).members.find(m => m.you).name === names[1]);
    assert.equal(lobby.stats().matches, 0);                  // joining does not start anything
});

test("up to 7 people fit; the 8th is turned away", () => {
    const { lobby, c, code } = lobbyOfN(7);
    const h = conn(); lobby.connect(names[7], names[7], h);
    lobby.joinRoom(names[7], code);
    assert.equal(h.last("error").code, "room_full");
    assert.equal(lobbyOf(c[0]).members.length, 7);
});

test("start: only the host can, and it needs two people", () => {
    const { lobby, join } = setup();
    const a = join(names[0]), b = join(names[1]);
    lobby.createRoom(names[0], "pro", false);
    lobby.startRoom(names[0]);
    assert.equal(a.last("error").code, "not_enough_players");
    lobby.joinRoom(names[1], a.last("room").room.code);
    lobby.startRoom(names[1]);
    assert.equal(b.last("error").code, "not_host");
    lobby.startRoom(names[0]);
    assert.equal(a.last("state").state.status, "playing");
    assert.equal(b.last("state").state.players.length, 2);
    assert.equal(lobbyOf(b).status, "playing");
    lobby.startRoom(names[0]);
    assert.equal(a.last("error").code, "already_playing");
});

test("a 3-player game rotates turns in order, shares one board, and the clock passes the turn", () => {
    const { lobby, clock, c } = lobbyOfN(3);
    lobby.startRoom(names[0]);                               // random() is 0, so the host starts
    const turnOf = () => c.findIndex(x => x.last("state").state.yourTurn);
    assert.equal(turnOf(), 0);
    const [w1, w2] = wrong(lobby, 2);
    lobby.guess(names[0], w1); assert.equal(turnOf(), 1);
    lobby.guess(names[1], w2); assert.equal(turnOf(), 2);
    clock.tick(30100);                                       // player 3 does nothing
    assert.equal(turnOf(), 0);
    const s = c[1].last("state").state;
    assert.equal(s.guesses.length, 3);
    assert.equal(s.guesses[2].timedOut, true);
    assert.equal(s.revealed.length, 12);                     // 3 + 3 per finished turn
    assert.equal(s.players.length, 3);
});

test("wins are counted per player across games; the starter rotates", () => {
    const { lobby, c } = lobbyOfN(3);
    lobby.startRoom(names[0]);
    lobby.guess(names[0], secret(lobby));                    // the host wins game 1
    let l = lobbyOf(c[1]);
    assert.deepEqual(l.members.map(m => m.wins), [1, 0, 0]);
    assert.equal(l.status, "waiting");
    assert.equal(c[1].last("state").state.status, "over");
    assert.deepEqual(l.members.map(m => m.ready), [false, false, false]);   // everyone has to say if they want more
    for (const id of names.slice(0, 3)) lobby.rematch(id);
    assert.equal(lobbyOf(c[0]).readyCount, 3);
    lobby.startRoom(names[0]);
    assert.equal(c[1].last("state").state.yourTurn, true);   // game 2 starts with player 2
    lobby.guess(names[1], secret(lobby));
    assert.deepEqual(lobbyOf(c[2]).members.map(m => m.wins), [1, 1, 0]);
    assert.deepEqual(c[2].last("state").state.players.map(pl => pl.wins), [1, 1, 0]);
});

test("play again: only the players who said yes are in the next game; the rest are released", () => {
    const { lobby, c } = lobbyOfN(3);
    lobby.startRoom(names[0]);
    lobby.guess(names[0], secret(lobby));
    lobby.rematch(names[0]); lobby.rematch(names[1]);        // player 3 does not answer
    assert.equal(lobbyOf(c[0]).readyCount, 2);
    lobby.startRoom(names[0]);
    assert.ok(c[2].last("idle"));
    assert.equal(c[2].last("error").code, "removed_not_ready");
    const s = c[0].last("state").state;
    assert.equal(s.status, "playing");
    assert.deepEqual(s.players.map(pl => pl.name), [names[0], names[1]]);
    assert.deepEqual(lobbyOf(c[1]).members.map(m => m.wins), [1, 0]);       // scores are kept for the people who stay
});

test("the host does not have to press Play again before Start: starting counts them as ready", () => {
    const { lobby, c } = lobbyOfN(3);
    lobby.startRoom(names[0]);
    lobby.guess(names[0], secret(lobby));
    lobby.rematch(names[1]);                                 // only one other player is ready; the host has not clicked
    assert.equal(lobbyOf(c[0]).startCount, 2);
    assert.equal(lobbyOf(c[0]).canStart, true);
    lobby.startRoom(names[0]);
    assert.equal(c[0].last("state").state.status, "playing");
    assert.equal(c[0].last("state").state.players.length, 2);
});

test("play again: if everyone else leaves, the last player stays in the waiting room and the code still works", () => {
    const { lobby, join, c, code } = lobbyOfN(3);
    lobby.startRoom(names[0]);
    lobby.guess(names[0], secret(lobby));
    lobby.leave(names[1]); lobby.leave(names[2]);
    const l = lobbyOf(c[0]);
    assert.equal(l.members.length, 1);
    assert.equal(l.canStart, false);
    lobby.rematch(names[0]); lobby.startRoom(names[0]);
    assert.equal(c[0].last("error").code, "not_enough_players");
    const d = join(names[3]);
    lobby.joinRoom(names[3], code);
    assert.equal(lobbyOf(c[0]).members.length, 2);
    assert.equal(d.last("room").room.members.length, 2);     // the newcomer has no game to show, so they get the waiting room
    lobby.rematch(names[0]); lobby.startRoom(names[0]);
    assert.equal(d.last("state").state.status, "playing");
});

test("leaving mid-game: the player is skipped and the game goes on", () => {
    const { lobby, c } = lobbyOfN(3);
    lobby.startRoom(names[0]);
    const [w1, w2] = wrong(lobby, 2);
    lobby.leave(names[2]);                                   // player 3 leaves while it is player 1's turn
    assert.equal(c[0].last("state").state.status, "playing");
    assert.equal(c[0].last("state").state.players[2].left, true);
    lobby.guess(names[0], w1); lobby.guess(names[1], w2);
    assert.equal(c[0].last("state").state.yourTurn, true);   // back to player 1, skipping player 3
    assert.equal(lobbyOf(c[0]).members.length, 2);
});

test("leaving on your own turn loses that turn and the clues move on", () => {
    const { lobby, c } = lobbyOfN(3);
    lobby.startRoom(names[0]);
    const [w1, w2] = wrong(lobby, 2);
    lobby.guess(names[0], w1); lobby.guess(names[1], w2);    // now it is player 3's turn
    lobby.leave(names[2]);
    const s = c[0].last("state").state;
    assert.equal(s.yourTurn, true);
    assert.equal(s.guesses[2].left, true);
    assert.equal(s.revealed.length, 12);
});

test("if everyone else leaves mid-game, the last player wins and is credited", () => {
    const { lobby, c } = lobbyOfN(3);
    lobby.startRoom(names[0]);
    lobby.leave(names[1]); lobby.leave(names[2]);
    const s = c[0].last("state").state;
    assert.equal(s.status, "over");
    assert.equal(s.reason, "forfeit");
    assert.equal(s.winner, 0);
    assert.equal(lobbyOf(c[0]).members[0].wins, 1);
    assert.equal(lobbyOf(c[0]).status, "waiting");
});

test("the host leaving passes the host role on; the last person out closes the lobby", () => {
    const { lobby, c } = lobbyOfN(3);
    lobby.leave(names[0]);
    assert.equal(lobbyOf(c[1]).isHost, true);
    assert.equal(lobbyOf(c[2]).isHost, false);
    assert.equal(lobbyOf(c[1]).members.length, 2);
    lobby.leave(names[1]); lobby.leave(names[2]);
    assert.equal(lobby.stats().rooms, 0);
    assert.equal(lobby.stats().matches, 0);
});

test("joining mid-game is refused; joining after the game works and lands in the waiting room", () => {
    const { lobby, join, c, code } = lobbyOfN(2);
    const d = join(names[3]);
    lobby.startRoom(names[0]);
    lobby.joinRoom(names[3], code);
    assert.equal(d.last("error").code, "room_busy");
    lobby.guess(names[0], secret(lobby));
    lobby.joinRoom(names[3], code);
    assert.equal(d.last("room").room.members.length, 3);
    assert.equal(lobbyOf(c[0]).members.length, 3);
    assert.equal(c[0].last("state").state.status, "over");   // the others stay on their results screen
});

test("a member who drops and never returns is removed after the grace period; a returning one keeps their seat", () => {
    const { lobby, clock, c } = lobbyOfN(3);
    lobby.disconnect(names[0], c[0]);                        // the host drops
    assert.equal(lobbyOf(c[1]).members[0].connected, false);
    assert.equal(lobbyOf(c[1]).canStart, true);              // 2 others are still connected and ready
    lobby.disconnect(names[2], c[2]);
    clock.tick(5000);
    const c3 = conn(); lobby.connect(names[2], names[2], c3);
    assert.equal(c3.last("welcome").resumed, true);
    assert.equal(c3.last("room").room.members.length, 3);
    clock.tick(21000);                                       // the host never came back
    const l = lobbyOf(c[1]);
    assert.equal(l.members.length, 2);
    assert.equal(l.isHost, true);                            // the next person became host
    assert.equal(l.members.some(m => m.name === names[0]), false);
});

test("a reconnecting player gets their game back, with the lobby info", () => {
    const { lobby, c } = lobbyOfN(2);
    lobby.startRoom(names[0]);
    lobby.disconnect(names[1], c[1]);
    assert.equal(c[0].last("state").state.players[1].connected, false);
    const b2 = conn(); lobby.connect(names[1], names[1], b2);
    assert.equal(b2.last("state").state.status, "playing");
    assert.equal(b2.last("state").state.lobby.members.length, 2);
    assert.equal(c[0].last("state").state.players[1].connected, true);
});

test("scores survive leaving and rejoining the same lobby? (they are kept only while the lobby exists)", () => {
    const { lobby, c, code } = lobbyOfN(3);
    lobby.startRoom(names[0]);
    lobby.guess(names[0], secret(lobby));
    lobby.leave(names[0]);                                   // the winner leaves; the lobby (2 people) lives on
    assert.equal(lobbyOf(c[1]).isHost, true);
    lobby.joinRoom(names[0], code);
    assert.equal(lobbyOf(c[0]).members.find(m => m.you).wins, 1);
});

test("an idle lobby expires, but one with a game running is never closed", () => {
    const a = lobbyOfN(2);
    a.clock.tick(30 * 60 * 1000 + 100);
    assert.equal(a.c[0].last("error").code, "room_expired");
    assert.equal(a.lobby.stats().rooms, 0);

    const b = lobbyOfN(2, { turnMs: 10 ** 9 });
    b.lobby.startRoom(names[0]);
    b.clock.tick(31 * 60 * 1000);
    assert.equal(b.lobby.stats().rooms, 1);
    assert.equal(b.c[0].last("state").state.status, "playing");
});

test("two people with the same name get told apart", () => {
    const { lobby, join } = setup();
    const a = join(names[0], "Sam"), b = join(names[1], "Sam");
    lobby.createRoom(names[0], "pro", false);
    lobby.joinRoom(names[1], a.last("room").room.code);
    assert.deepEqual(lobbyOf(b).members.map(m => m.name), ["Sam", "Sam 2"]);
});

test("lobby errors: unknown code, wrong mode, and you can't do it while in a public match", () => {
    const { lobby, join } = setup();
    const a = join(names[0]), b = join(names[1]), c = join(names[2]);
    lobby.joinRoom(names[0], "ZZZZZ");
    assert.equal(a.last("error").code, "room_not_found");
    lobby.createRoom(names[0], "ncaa", false);
    assert.equal(a.last("error").code, "bad_mode");
    lobby.createRoom(names[2], "pro", false);
    const code = c.last("room").room.code;
    lobby.enqueue(names[0], "pro", false); lobby.enqueue(names[1], "pro", false);
    lobby.joinRoom(names[0], code);
    assert.equal(a.last("error").code, "in_match");
    lobby.createRoom(names[0], "pro", false);
    assert.equal(a.last("error").code, "in_match");
});

test("opening or joining a lobby pulls you out of the public queue; queueing leaves your lobby", () => {
    const { lobby, join } = setup();
    const a = join(names[0]), b = join(names[1]);
    lobby.enqueue(names[1], "pro", false);
    assert.equal(lobby.stats().waiting, 1);
    lobby.createRoom(names[0], "pro", false);
    lobby.joinRoom(names[1], a.last("room").room.code);
    assert.equal(lobby.stats().waiting, 0);
    assert.equal(lobbyOf(b).members.length, 2);
    lobby.enqueue(names[1], "pro", false);                   // changed their mind
    assert.equal(b.last("queued").mode, "pro");
    assert.equal(lobbyOf(a).members.length, 1);
    lobby.enqueue(names[0], "pro", false);                   // the host too: the lobby closes
    assert.equal(lobby.stats().rooms, 0);
});

test("opening a second lobby leaves the first (and hands it over)", () => {
    const { lobby, c, code } = lobbyOfN(2);
    lobby.createRoom(names[1], "ucl", false);
    assert.equal(lobbyOf(c[0]).members.length, 1);
    assert.notEqual(c[1].last("room").room.code, code);
    assert.equal(lobby.stats().rooms, 2);
});

test("joining the lobby you are already in just refreshes your screen", () => {
    const { lobby, c, code } = lobbyOfN(2);
    const before = c[1].sent.length;
    lobby.joinRoom(names[1], code);
    assert.ok(c[1].sent.length > before);
    assert.equal(lobbyOf(c[1]).members.length, 2);
});

test("a finished lobby game: New opponent leaves the lobby and joins the public queue", () => {
    const { lobby, c } = lobbyOfN(2);
    lobby.startRoom(names[0]);
    lobby.guess(names[0], secret(lobby));
    lobby.newOpponent(names[1]);
    assert.equal(c[1].last("queued").mode, "pro");
    assert.equal(lobbyOf(c[0]).members.length, 1);
});
