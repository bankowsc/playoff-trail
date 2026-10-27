import test from "node:test";
import assert from "node:assert/strict";
import { Match } from "../server/match.js";
import { MAX_STEPS } from "../server/rules.js";

// T0 is the secret answer. T1/T2 share its conference; T3 is another sport.
const hist = "012345012345012345012";
const TEAMS = [
    { name: "T0", sport: "NFL", conference: "NFC", division: "East", history: hist },
    { name: "T1", sport: "NFL", conference: "NFC", division: "West", history: hist },
    { name: "T2", sport: "NFL", conference: "NFC", division: "East", history: hist },
    { name: "T3", sport: "NBA", conference: "East", division: "Atlantic", history: hist },
    ...Array.from({ length: 8 }, (_, i) => ({ name: `X${i}`, sport: "NBA", conference: "West", division: "Pacific", history: hist })),
];
const P = [{ id: "p1", name: "Ann" }, { id: "p2", name: "Bo" }];
const make = (extra = {}) => {
    const m = new Match({ mode: "pro", teams: TEAMS, players: P, target: TEAMS[0], turnMs: 30000, seed: "s", ...extra });
    m.start(1000);
    return m;
};

test("start: p1 is on the clock, 3 seasons shown, the answer is hidden", () => {
    const m = make();
    const v1 = m.view("p1", 1000), v2 = m.view("p2", 1000);
    assert.equal(v1.yourTurn, true);
    assert.equal(v2.yourTurn, false);
    assert.equal(v1.revealed.length, 3);
    assert.equal(v1.answer, null);
    assert.equal(v1.deadline, 31000);
    assert.ok(!JSON.stringify(v1).includes('"target"'));
});

test("wrong guess: turn flips, 6 seasons shown, result recorded", () => {
    const m = make();
    const r = m.submitGuess("p1", "T1", 2000);
    assert.deepEqual(r, { ok: true, correct: false });
    const v = m.view("p2", 2000);
    assert.equal(v.yourTurn, true);
    assert.equal(v.revealed.length, 6);
    assert.deepEqual(v.guesses[0].result, { sport: true, conf: true, third: 0 });
    assert.equal(v.deadline, 2000 + 30000);
});

test("only the player on the clock can guess", () => {
    const m = make();
    assert.equal(m.submitGuess("p2", "T1", 2000).error, "not_your_turn");
    assert.equal(m.submitGuess("nobody", "T1", 2000).error, "not_in_match");
});

test("unknown team and repeat guesses do not use up the turn", () => {
    const m = make();
    assert.equal(m.submitGuess("p1", "Nope", 2000).error, "unknown_team");
    assert.equal(m.view("p1", 2000).yourTurn, true);
    m.submitGuess("p1", "T1", 2000);
    assert.equal(m.submitGuess("p2", "t1", 3000).error, "already_guessed");   // case-insensitive, shared board
    assert.equal(m.view("p2", 3000).yourTurn, true);
});

test("a correct guess ends the match and reveals everything", () => {
    const m = make();
    m.submitGuess("p1", "T1", 2000);
    const r = m.submitGuess("p2", "T0", 3000);
    assert.deepEqual(r, { ok: true, correct: true });
    const v = m.view("p1", 3000);
    assert.equal(v.status, "over");
    assert.equal(v.winner, 1);
    assert.equal(v.reason, "guess");
    assert.equal(v.answer.name, "T0");
    assert.equal(v.revealed.length, 21);
    assert.equal(v.deadline, null);
    assert.equal(m.submitGuess("p1", "T2", 4000).error, "not_playing");
});

test("timeout: skips the turn, reveals more, flips the turn", () => {
    const m = make();
    assert.equal(m.timeout(31000, 0), true);
    const v = m.view("p2", 31000);
    assert.equal(v.yourTurn, true);
    assert.equal(v.revealed.length, 6);
    assert.equal(v.guesses[0].timedOut, true);
    assert.equal(v.guesses[0].team, null);
});

test("timeout is ignored when early or for a stale turn", () => {
    const m = make();
    assert.equal(m.timeout(20000, 0), false);          // before the deadline
    m.submitGuess("p1", "T1", 2000);                    // turn moved on
    assert.equal(m.timeout(99999, 0), false);          // timer from the old turn
    assert.equal(m.turnNo, 1);
});

test("a guess that arrives after the deadline is rejected and the turn is lost", () => {
    const m = make();
    const r = m.submitGuess("p1", "T1", 31500);
    assert.deepEqual(r, { ok: false, error: "too_late", changed: true });
    assert.equal(m.view("p2", 31500).yourTurn, true);
    assert.equal(m.guesses.length, 1);
    assert.equal(m.guesses[0].timedOut, true);
});

test("draw after seven turns with no correct guess", () => {
    const m = make();
    let now = 2000;
    const order = ["p1", "p2", "p1", "p2", "p1", "p2", "p1"];
    const wrong = ["T1", "T3", "X0", "X1", "X2", "X3", "X4"];
    order.forEach((p, i) => { assert.equal(m.submitGuess(p, wrong[i], now += 1000).ok, true); });
    assert.equal(m.step, MAX_STEPS);
    const v = m.view("p1", now);
    assert.equal(v.status, "over");
    assert.equal(v.reason, "draw");
    assert.equal(v.winner, null);
    assert.equal(v.answer.name, "T0");
});

test("forfeit gives the win to the other player", () => {
    const m = make();
    m.forfeit("p1");
    assert.equal(m.winner, 1);
    assert.equal(m.reason, "forfeit");
});

test("hard mode reveals seasons in a shuffled but stable order", () => {
    const a = make({ hard: true, seed: "abc" }), b = make({ hard: true, seed: "abc" }), n = make({ hard: false });
    const idx = m => m.view("p1", 0).revealed.map(r => r[0]);
    assert.deepEqual(idx(a), idx(b));
    assert.notDeepEqual(idx(a), idx(n));
    assert.deepEqual(idx(n), [0, 1, 2]);
});

test("hints reveal a value only after someone matches it", () => {
    const m = make();
    assert.deepEqual(m.hints(), { sport: null, conf: null, third: null });
    m.submitGuess("p1", "T1", 2000);                    // same sport + conference, wrong division
    assert.deepEqual(m.hints(), { sport: "NFL", conf: "NFC", third: null });
});

test("ncaa hints reveal colors one at a time", () => {
    const teams = [
        { name: "Target", sport: "NCAAM", conference: "BigEast", colors: ["🔵", "⚪"], history: hist },
        { name: "Guess", sport: "NCAAM", conference: "BigTen", colors: ["🔵", "🔴"], history: hist },
    ];
    const m = new Match({ mode: "ncaa", teams, players: P, target: teams[0], seed: "s" });
    m.start(0);
    m.submitGuess("p1", "Guess", 1);
    assert.deepEqual(m.hints().third, ["🔵", null]);
    assert.equal(m.guesses[0].result.third, 1);
});
