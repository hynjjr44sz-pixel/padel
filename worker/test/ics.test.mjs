import test from "node:test";
import assert from "node:assert/strict";
import { buildIcs } from "../src/ics.js";
test("calendar feed: a tournament over its days, its next match timed, a series match, only the chosen players", () => {
  const events = [
    { kind: "tournament", classId: 5, pid: 1, me: "Thea Holmberg Löving", partner: "Cassandra Ersson", name: "Fall Open", cls: "Dam B", start: "2026-10-17T09:00:00", end: "2026-10-18T18:00:00", venue: "Padelverket", url: "https://x" },
    { kind: "tournament", classId: 6, pid: 2, me: "Kian Borgström", name: "Other Open", cls: "Herr C", start: "2026-10-17T09:00:00", end: "2026-10-17T18:00:00" },
    { kind: "tournament", classId: 7, pid: 1, me: "Thea Holmberg Löving", name: "Old Open", cls: "Dam C", start: "2026-09-01T09:00:00", end: "2026-09-02T18:00:00" }];
  const bhs = { groups: [{ id: 9, series: "Seriespel", name: "Division 3", url: "https://b", next: [{ d: "2026-10-20 18:30", min: 90, a: "Christer Erbe / Thea Löving", b: "X / Y", c: 2, pids: [1] }] }] };
  const live = { 1: { st: "next", key: "t5-thea", d: "2026-10-17T10:15:00", t: "10:15", lab: "Kvartsfinal", opp: "Pihl / Bovin", c: "Bana 3" } };
  const ics = buildIcs({ events, bhs, live }, [1], new Date("2026-10-14T08:00:00Z"));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261017\r\nDTEND;VALUE=DATE:20261019/);
  assert.match(ics, /SUMMARY:Fall Open · Dam B \(Thea & Cassandra\)/);
  assert.match(ics, /DTSTART;TZID=Europe\/Stockholm:20261017T101500\r\nDTEND;TZID=Europe\/Stockholm:20261017T114500/);
  assert.match(ics, /SUMMARY:Thea: Kvartsfinal mot Pihl \/ Bovin/);
  assert.match(ics, /DTSTART;TZID=Europe\/Stockholm:20261020T183000/);
  assert.doesNotMatch(ics, /Other Open|Old Open/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
  ics.split("\r\n").forEach(l => assert.ok(l.length <= 75, l));
});
test("a pair on a class's reserve list is dropped from the class itself", async () => {
  const { merge } = await import("../src/events.js");
  const l = merge([
    { kind: "tournament", tournamentId: 1, classId: 10, cls: "Herr C", me: "Kian Borgström", partner: "Andreas Mickos", who: "kian", windowFrom: "a" },
    { kind: "tournament", tournamentId: 1, classId: 11, cls: "Reservlista Herr C", me: "Andreas Mickos", partner: "Kian Borgström", who: "andreas", windowFrom: "a" },
    { kind: "tournament", tournamentId: 1, classId: 10, cls: "Herr C", me: "Magnus Olsson", partner: "Viktor Daneli", who: "magnus", windowFrom: "a" }], []);
  assert.deepEqual(l.map(e => e.who + ":" + e.cls), ["andreas:Reservlista Herr C", "magnus:Herr C"]);
});
