import test from "node:test";
import assert from "node:assert/strict";
import { compare, colorScore, makeOrder, visibleCount, revealedSeasons, hash, YEARS, checkTeams } from "../server/rules.js";

test("same conference, different division: sport + conf green, third red", () => {
    const a = { sport: "NFL", conference: "NFC", division: "West" };
    const b = { sport: "NFL", conference: "NFC", division: "East" };
    assert.deepEqual(compare(a, b, "pro"), { sport: true, conf: true, third: 0 });
});

test("exact division match is green", () => {
    const a = { sport: "NBA", conference: "East", division: "Atlantic" };
    assert.deepEqual(compare(a, { ...a }, "pro"), { sport: true, conf: true, third: 2 });
});

test("different sport: nothing matches", () => {
    const a = { sport: "NFL", conference: "NFC", division: "West" };
    const b = { sport: "NBA", conference: "West", division: "Pacific" };
    assert.deepEqual(compare(a, b, "pro"), { sport: false, conf: false, third: 0 });
});

test("ncaa: colors match even when conferences differ", () => {
    const target = { sport: "NCAAM", conference: "BigEast", colors: ["🔵", "⚪"] };
    const one = { sport: "NCAAM", conference: "BigTen", colors: ["🔵", "🔴"] };
    const both = { sport: "NCAAM", conference: "ACC", colors: ["⚪", "🔵"] };
    const none = { sport: "NCAAM", conference: "ACC", colors: ["🟢", "🟡"] };
    assert.equal(compare(one, target, "ncaa").third, 1);
    assert.equal(compare(both, target, "ncaa").third, 2);
    assert.equal(compare(none, target, "ncaa").third, 0);
});

test("ncaa: emoji with and without the variation selector still match", () => {
    assert.equal(colorScore({ colors: ["⚪\uFE0F"] }, { colors: ["⚪"] }), 2);
});

test("ncaa: colors can also come from the old emoji-in-division field", () => {
    assert.equal(colorScore({ division: "🟠🔵" }, { division: "🔵⚪" }), 1);
});

test("hard order is a stable permutation of all seasons", () => {
    const o = makeOrder("seed-1", true);
    assert.deepEqual(o, makeOrder("seed-1", true));
    assert.deepEqual([...o].sort((a, b) => a - b), Array.from({ length: YEARS }, (_, i) => i));
    assert.notDeepEqual(o, makeOrder("seed-2", true));
});

test("normal order is newest first", () => {
    assert.deepEqual(makeOrder("x", false).slice(0, 4), [0, 1, 2, 3]);
});

test("reveal counts: 3 on the first turn, all 21 by the last", () => {
    assert.equal(visibleCount(0), 3);
    assert.equal(visibleCount(1), 6);
    assert.equal(visibleCount(6), 21);
    assert.equal(visibleCount(99), 21);
});

test("revealedSeasons only returns the visible seasons with their levels", () => {
    const target = { history: "012345012345012345012" };
    const r = revealedSeasons(target, makeOrder("x", false), 0);
    assert.deepEqual(r, [[0, 0], [1, 1], [2, 2]]);
});

test("hash is deterministic", () => assert.equal(hash("2026-10-9"), hash("2026-10-9")));

test("checkTeams flags a short history and a missing field", () => {
    const problems = checkTeams([{ name: "A", sport: "NFL", conference: "NFC", history: "012" }, { name: "B", sport: "NFL", history: "0".repeat(21) }]);
    assert.equal(problems.length, 2);
});
