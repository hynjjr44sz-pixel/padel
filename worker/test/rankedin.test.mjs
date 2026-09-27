import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, snapshot, notes } from "../src/rankedin.js";

const F = n => JSON.parse(readFileSync(new URL("./fixtures/" + n, import.meta.url)));
const DC = { who: "thea", me: "Thea Holmberg Löving", cls: "Damer C", classId: 164681 };
const step = (ev, from, to) => notes(ev, parse([F(to)]), snapshot(parse([F(from)])));

test("parse: knockout draws, winner-side scores, match tie-break 1-0 + LoserTiebreak", () => {
  const m = parse([F("dc_1031.json")]);
  assert.equal(m.length, 22);
  const r1 = m.find(x => x.id === "6872147");
  assert.deepEqual([r1.di, r1.r, r1.label, r1.w, r1.s, r1.t, r1.c], [0, 0, "Omgång 1", "a", "7-6 3-6 10-8", "09:00", "Bana 1"]);
  assert.equal(m.find(x => x.id === "6872166").note, "W.O.");
  const plate = m.find(x => x.id === "6872168");
  assert.deepEqual([plate.di, plate.label, plate.dlabel], [1, "Plate-final", "Plate"]);
});

test("no change -> no notiser", () => {
  assert.deepEqual(step(DC, "dc_1112.json", "dc_1112.json"), []);
});

test("opponent known: deciding match folded into one notis", () => {
  const n = step(DC, "dc_1031.json", "dc_1112.json");
  // Only Thea's own news is pushed; other results in the class are not.
  assert.deepEqual(n.map(x => x.title), ["Thea och Cassandra möter Pettersson Österberg / Ekeland"]);
  assert.equal(n[0].body, "Vann omgång 1 7-6 7-6 mot Lundström / Callero. Kvartsfinal 12:45 · Bana 1");
  assert.equal(n[0].tag, "padel-164681:opp:m6872156:6440356");
  assert.equal(n[0].url, "./#thea/m6872156", "deep link: tab + the next match");
});

test("Thea wins, loses, wins the class", () => {
  const w = step(DC, "dc_1112.json", "dc_wins_qf.json").at(-1);
  assert.equal(w.title, "Thea och Cassandra vann kvartsfinalen 6-2 7-5");
  assert.equal(w.body, "Mot Pettersson Österberg / Ekeland. Nästa: semifinal 15:30, Bana 4 mot Wallerman / Lundberg Aguilera.");
  const l = step(DC, "dc_1112.json", "dc_mtb.json");
  assert.equal(l.at(-1).title, "Thea och Cassandra förlorade kvartsfinalen 3-6 6-4 MTB");
  assert.match(l.at(-1).body, /Kvartsfinalen blev slutstation/);
  const c = step(DC, "dc_in_final.json", "dc_champ.json");
  assert.deepEqual(c.map(x => x.title), ["Thea och Cassandra vann Damer C!"]);
});

test("other results in the class are never pushed", () => {
  const n = step(DC, "dc_1031.json", "dc_wins_qf.json");
  assert.ok(n.length > 0 && n.every(x => /^Thea och Cassandra /.test(x.title)), JSON.stringify(n, null, 1));
});

test("round robin pool: row-side scores, one entry per match", () => {
  const m = parse([F("rr_uno.json")]);
  assert.equal(m.length, 6);
  assert.ok(m.every(x => x.kind === "rr" && x.w));
  const kian = { who: "kian", me: "Kian Borgström", cls: "Herr C", classId: 166357 };
  const before = snapshot(m);
  delete before["6773468"];   // pretend Oscar P A - Kian was not played yet
  const n = notes(kian, m, before);
  // The last group match also finishes the group: final placing as its own notis.
  assert.deepEqual(n.map(x => x.title), ["Kian och Andreas förlorade gruppmatchen 3-6 2-6", "Kian och Andreas slutade fyra i gruppen"]);
  assert.equal(n[0].body, "Mot P A / Lindgren.");
  assert.equal(n[1].tag, "padel-166357:grupp:gruppspel");
  assert.match(n[1].body, /^1\. .+ 3–0\n2\. /);
});
