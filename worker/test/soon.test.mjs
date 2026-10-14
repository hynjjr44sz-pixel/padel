import test from "node:test";
import assert from "node:assert/strict";
import { soonNotes } from "../src/soon.js";
test("snart match: a quarter of an hour before, once per match, both club players", () => {
  const live = { 1: { st: "next", mid: 77, d: "2026-10-17T12:45:00", t: "12:45", lab: "Kvartsfinal", opp: "Pihl / Bovin", c: "Bana 3", cls: "Dam B" },
    2: { st: "next", mid: 77, d: "2026-10-17T12:45:00", t: "12:45", lab: "Kvartsfinal", opp: "Pihl / Bovin", c: "Bana 3", cls: "Dam B" },
    3: { st: "next", mid: 88, d: "2026-10-17T15:00:00", t: "15:00", lab: "Semifinal" }, 4: { st: "done" } };
  const players = [{ pid: 1, who: "thea", name: "Thea" }, { pid: 2, who: "nathalie", name: "Nathalie" }, { pid: 3, who: "kian", name: "Kian" }];
  const t = new Date("2026-10-17T10:30:00Z");   // 12:30 local, 15 min before
  const n = soonNotes(live, t, [], players);
  assert.equal(n.length, 1);
  assert.deepEqual(n[0].pids, [1, 2]);
  assert.equal(n[0].m.title, "Thea & Nathalie spelar 12:45: Kvartsfinal");
  assert.equal(n[0].m.body, "Mot Pihl / Bovin · Bana 3 · Dam B");
  assert.equal(n[0].m.url, "./#thea/m77");
  assert.equal(soonNotes(live, t, ["77"], players).length, 0);
  assert.equal(soonNotes(live, new Date("2026-10-17T10:00:00Z"), [], players).length, 0);   // 45 min before: not yet
});
