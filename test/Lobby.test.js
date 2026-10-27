import test from "node:test";
import assert from "node:assert/strict";
import { Lobby } from "../server/lobby.js";

const hist = "012345012345012345012";
const teams = Array.from({ length: 6 }, (_, i) => ({ name: `T${i}`, sport: "NFL", conference: "NFC", division: "East", history: hist }));

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
    lobby.guess("bbbbbbbb", "T1");
    assert.equal(b.last("error").code, "not_your_turn");
    lobby.guess("aaaaaaaa", "T1");
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
    assert.equal(b.last("state").state.opponent.connected, false);
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
    assert.equal(b.last("state").state.opponent.connected, true);
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
    assert.equal(a.last("state").state.opponent.name, "cccccccc");
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
    lobby.guess("aaaaaaaa", "T1");
    assert.equal(a.last("error").code, "too_late");
    assert.equal(b.last("state").state.yourTurn, true);
});

test("a name sent with the queue request is used in the match", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa", "Old"), b = join("bbbbbbbb", "Bo");
    lobby.enqueue("aaaaaaaa", "pro", false, "Ann");
    lobby.enqueue("bbbbbbbb", "pro", false);
    assert.deepEqual(a.last("state").state.players, ["Ann", "Bo"]);
});

// ---------------- private rooms (invite a friend) ----------------
test("a room: the host gets a code, a friend joins with it (any case), and they are matched in the host's game", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa", "Ann"), b = join("bbbbbbbb", "Bo");
    lobby.createRoom("aaaaaaaa", "ucl", true);
    const room = a.last("room");
    assert.match(room.code, /^[A-HJ-NP-Z2-9]{5}$/);
    assert.equal(room.mode, "ucl"); assert.equal(room.hard, true);
    assert.equal(lobby.stats().rooms, 1);
    lobby.joinRoom("bbbbbbbb", room.code.toLowerCase());
    const sa = a.last("state").state, sb = b.last("state").state;
    assert.equal(sa.mode, "ucl"); assert.equal(sb.mode, "ucl"); assert.equal(sb.hard, true);
    assert.deepEqual(sa.players, ["Ann", "Bo"]);
    assert.equal(lobby.stats().rooms, 0);                   // the invite is used up
    assert.equal(lobby.stats().matches, 1);
});

test("room errors: unknown code, your own room, a room that was already used", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb"), c = join("cccccccc");
    lobby.joinRoom("bbbbbbbb", "ZZZZZ");
    assert.equal(b.last("error").code, "room_not_found");
    lobby.createRoom("aaaaaaaa", "pro", false);
    const code = a.last("room").code;
    lobby.joinRoom("aaaaaaaa", code);
    assert.equal(a.last("error").code, "own_room");
    lobby.joinRoom("bbbbbbbb", code);
    lobby.joinRoom("cccccccc", code);                       // a third person with the same link
    assert.equal(c.last("error").code, "room_not_found");
});

test("the host can cancel; the code stops working", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.createRoom("aaaaaaaa", "pro", false);
    const code = a.last("room").code;
    lobby.cancel("aaaaaaaa");
    assert.ok(a.last("idle"));
    assert.equal(lobby.stats().rooms, 0);
    lobby.joinRoom("bbbbbbbb", code);
    assert.equal(b.last("error").code, "room_not_found");
});

test("an unused invite expires", () => {
    const { lobby, clock, join } = setup();
    const a = join("aaaaaaaa");
    lobby.createRoom("aaaaaaaa", "pro", false);
    clock.tick(15 * 60 * 1000 + 100);
    assert.equal(a.last("error").code, "room_expired");
    assert.equal(lobby.stats().rooms, 0);
});

test("the host can refresh: reconnecting within the grace period brings the room back", () => {
    const { lobby, clock, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.createRoom("aaaaaaaa", "pro", false);
    const code = a.last("room").code;
    lobby.disconnect("aaaaaaaa", a);
    lobby.joinRoom("bbbbbbbb", code);                       // the host is away right now
    assert.equal(b.last("error").code, "room_not_found");
    clock.tick(3000);
    const a2 = conn();
    lobby.connect("aaaaaaaa", "aaaaaaaa", a2);
    assert.equal(a2.last("room").code, code);
    lobby.joinRoom("bbbbbbbb", code);
    assert.equal(b.last("state").state.status, "playing");
});

test("a host who never comes back loses the room", () => {
    const { lobby, clock, join } = setup();
    const a = join("aaaaaaaa");
    lobby.createRoom("aaaaaaaa", "pro", false);
    lobby.disconnect("aaaaaaaa", a);
    clock.tick(21000);
    assert.equal(lobby.stats().rooms, 0);
    assert.equal(lobby.stats().players, 0);
});

test("joining a room pulls you out of the public queue; hosting then queueing closes the room", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.enqueue("bbbbbbbb", "pro", false);
    assert.equal(lobby.stats().waiting, 1);
    lobby.createRoom("aaaaaaaa", "pro", false);
    lobby.joinRoom("bbbbbbbb", a.last("room").code);
    assert.equal(lobby.stats().waiting, 0);
    assert.equal(b.last("state").state.status, "playing");

    const c = join("cccccccc");
    lobby.createRoom("cccccccc", "pro", false);
    lobby.enqueue("cccccccc", "pro", false);                // changed their mind: go public instead
    assert.equal(lobby.stats().rooms, 0);
    assert.equal(c.last("queued").mode, "pro");
});

test("you cannot open or join a room in the middle of a match", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb"), c = join("cccccccc");
    lobby.createRoom("cccccccc", "pro", false);
    const code = c.last("room").code;
    lobby.enqueue("aaaaaaaa", "pro", false); lobby.enqueue("bbbbbbbb", "pro", false);
    lobby.joinRoom("aaaaaaaa", code);
    assert.equal(a.last("error").code, "in_match");
    lobby.createRoom("aaaaaaaa", "pro", false);
    assert.equal(a.last("error").code, "in_match");
});

test("a mode that did not load cannot host a room", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa");
    lobby.createRoom("aaaaaaaa", "ncaa", false);
    assert.equal(a.last("error").code, "bad_mode");
});

test("a finished private match: play again works, and New opponent re-queues publicly", () => {
    const { lobby, join } = setup();
    const a = join("aaaaaaaa"), b = join("bbbbbbbb");
    lobby.createRoom("aaaaaaaa", "pro", false);
    lobby.joinRoom("bbbbbbbb", a.last("room").code);
    lobby.leave("aaaaaaaa");                                // end it fast
    lobby.newOpponent("bbbbbbbb");
    assert.equal(b.last("queued").mode, "pro");
});
