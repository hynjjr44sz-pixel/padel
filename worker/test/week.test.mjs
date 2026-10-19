import test from "node:test";
import assert from "node:assert/strict";
import { weekDigest, weekNote } from "../src/week.js";
const players = [{ pid: 1, name: "Thea Holmberg Löving", short: "Thea" }, { pid: 2, name: "Cassandra Ersson", short: "Cassandra" }, { pid: 3, name: "Tobias Myhre", short: "Tobias" }];
test("veckan i klubben: last week's wins, finals, climbers, series and the week ahead", () => {
  const t = new Date("2026-10-12T07:00:00Z");   // Monday 09:00
  const w = weekDigest({ players,
    wins: [{ place: 1, date: "2026-10-11", pids: [3], pair: ["Tobias Myhre", "Anders Söderlund"], cls: "Herrar 50+" }, { place: 2, date: "2026-10-04", pids: [1] }, { place: 2, date: "2026-10-10", pids: [1, 2], cls: "Dam B" }],
    board: { 1: { up: 12, rd: "2026-10-12", rk: 148 }, 2: { up: 3, rd: "2026-10-05" } },
    bhs: { groups: [{ res: [{ d: "2026-10-07", a: "Christer Erbe / Thea Löving", b: "X Y / Z W", s: "6-4 6-1" }, { d: "2026-10-08", a: "A B / C D", b: "Tobias Myhre / Q R", s: "6-4 6-1" }, { d: "2026-10-01", a: "Thea Löving / X", b: "Y / Z", s: "6-0 6-0" }] }] },
    events: [{ kind: "tournament", tournamentId: 9, name: "Fall Open", start: "2026-10-17T09:00:00", pid: 1 }, { kind: "tournament", tournamentId: 9, name: "Fall Open", start: "2026-10-17T09:00:00", pid: 2 }, { kind: "tournament", tournamentId: 8, name: "Later", start: "2026-10-24T09:00:00", pid: 3 }] }, t, 2);
  assert.equal(w.from, "2026-10-05"); assert.equal(w.to, "2026-10-11");
  assert.deepEqual(w.won.map(x => x.who), ["Tobias"]);
  assert.deepEqual(w.fin.map(x => x.who), ["Thea & Cassandra"]);
  assert.deepEqual(w.climb, [{ who: "Thea", up: 12, rk: 148 }]);
  assert.deepEqual(w.series, { w: 1, l: 1 });
  assert.deepEqual(w.coming, [{ name: "Fall Open", d: "2026-10-17", n: 2 }]);
  const n = weekNote(w);
  assert.equal(n.title, "Veckan i klubben");
  assert.match(n.body, /Vann: Tobias \(Herrar 50\+\)\nFinal: Thea & Cassandra \(Dam B\)\nKlättrade: Thea \+12\nKlubbserien: 1 vinst, 1 förlust\nDen här veckan: Fall Open \(2\)/);
  assert.equal(weekNote(weekDigest({ players }, t)), null);
});
