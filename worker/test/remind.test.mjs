import test from "node:test";
import assert from "node:assert/strict";
import { remindNotes } from "../src/remind.js";
const cal = { caps: { d: "2026-10-12", M: { B: 404.79, C: 126.5, D: 13 }, F: { B: 434.3, C: 132.2, D: 20 } }, events: [
  { id: 1, name: "Oktober Open", club: "Lillån", city: "Örebro", closes: "2026-10-16T23:55:00", state: 1, classes: [{ id: 11, name: "Damer B", level: "B", gender: "F", players: 3 }], regs: [] },
  { id: 2, name: "Later Open", club: "X", city: "Y", closes: "2026-10-25T23:55:00", state: 1, classes: [{ id: 21, name: "Damer B", level: "B", gender: "F", players: 3 }], regs: [] },
  { id: 3, name: "Entered Open", club: "X", city: "Y", closes: "2026-10-16T20:00:00", state: 1, classes: [{ id: 31, name: "Damer B", level: "B", gender: "F", players: 3 }], regs: [{ pid: 1, classId: 31 }] }] };
const players = [{ who: "thea", pid: 1, gender: "F", name: "Thea" }];
test("sista anmälan: a class the player may enter, closing within two days, once", () => {
  const t = new Date("2026-10-14T16:22:00Z"), board = { 1: { rp: 71.3, rk: 148 } };
  const n = remindNotes(cal, players, board, {}, t);
  assert.equal(n.length, 1);
  assert.equal(n[0].m.title, "Sista anmälan fre 16 okt: Oktober Open");
  assert.match(n[0].m.body, /^Thea kan spela Damer B \(3 par\)\. Lillån, Örebro/);
  assert.deepEqual(n[0].pids, [1]);
  assert.equal(remindNotes(cal, players, board, {}, t, ["1:1"]).length, 0);
  assert.equal(remindNotes(cal, players, board, { 1: [1] }, t).length, 0);   // already in the tournament
});
