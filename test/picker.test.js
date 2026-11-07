import test from "node:test";
import assert from "node:assert/strict";
import { TeamPicker } from "../server/picker.js";

const sports = [["NFL", 32], ["MLB", 30], ["NBA", 30], ["NHL", 32]];
const pro = sports.flatMap(([s, n]) => Array.from({ length: n }, (_, i) => ({ name: `${s} ${i}`, sport: s })));
const one = Array.from({ length: 20 }, (_, i) => ({ name: `U${i}`, sport: "UCL" }));
const make = () => new TeamPicker({ pro, ucl: one });

test("every group of four games contains each sport exactly once", () => {
    const p = make();
    for (let round = 0; round < 50; round++) {
        const got = Array.from({ length: 4 }, () => p.pick("pro").sport).sort();
        assert.deepEqual(got, ["MLB", "NBA", "NFL", "NHL"]);
    }
});

test("a sport can never go missing for long, and never repeats back to back", () => {
    const p = make();
    const seq = Array.from({ length: 5000 }, () => p.pick("pro").sport);
    seq.forEach((s, i) => { if (i) assert.notEqual(s, seq[i - 1]); });
    for (const [sport] of sports) {
        let drought = 0, worst = 0;
        for (const s of seq) { drought = s === sport ? 0 : drought + 1; worst = Math.max(worst, drought); }
        assert.ok(worst <= 6, `${sport} went ${worst} games without appearing`);
    }
});

test("the sports are dealt evenly", () => {
    const p = make(), count = {};
    for (let i = 0; i < 4000; i++) { const s = p.pick("pro").sport; count[s] = (count[s] || 0) + 1; }
    for (const [s] of sports) assert.equal(count[s], 1000);
});

test("a team is not repeated until half the list has been used", () => {
    const p = make(), seq = Array.from({ length: 3000 }, () => p.pick("pro").name), window = 62;
    seq.forEach((n, i) => { if (i >= 1) assert.ok(!seq.slice(Math.max(0, i - window), i).includes(n), `${n} repeated too soon at game ${i}`); });
});

test("every team still gets picked eventually", () => {
    const p = make(), seen = new Set();
    for (let i = 0; i < 4000; i++) seen.add(p.pick("pro").name);
    assert.equal(seen.size, pro.length);
});

test("a single-sport mode works and avoids immediate repeats; modes are tracked separately", () => {
    const p = make(), seq = Array.from({ length: 500 }, () => p.pick("ucl").name);
    seq.forEach((n, i) => { if (i) assert.notEqual(n, seq[i - 1]); });
    assert.equal(new Set(seq).size, one.length);
    assert.ok(p.pick("pro").sport);                          // the other mode is unaffected
});

test("tiny lists don't break it", () => {
    const p = new TeamPicker({ pro: [{ name: "Only", sport: "NFL" }] });
    for (let i = 0; i < 10; i++) assert.equal(p.pick("pro").name, "Only");
    const q = new TeamPicker({ pro: [{ name: "A", sport: "NFL" }, { name: "B", sport: "NBA" }] });
    const names = Array.from({ length: 8 }, () => q.pick("pro").name);
    assert.deepEqual(names.slice(0, 2).sort(), ["A", "B"]);
});

test("it uses the random source it is given (so tests can be deterministic)", () => {
    const a = new TeamPicker({ pro }, () => 0), b = new TeamPicker({ pro }, () => 0);
    assert.equal(a.pick("pro").name, b.pick("pro").name);
});
