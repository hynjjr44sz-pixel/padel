// MATCHi TV match starts, step 1 (GitHub Action tvstarts.yml): the club pairs' finished matches in halls with cameras
// (the worker's GET /events: events with tv, the halls' streams), with court and scheduled time from RankedIn's draws,
// each matched to its court's recording -> jobs.json for tvstarts.py. Matches already in tvstarts.json are skipped.
//   node tv-jobs.mjs <tvstarts.json or -> <jobs.json>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parse } from "./src/rankedin.js";
import { drawPath, API } from "./src/discover.js";
import { localToDate } from "./src/tz.js";
import { courtNo } from "./src/tv.js";

const [, , donePath, outPath] = process.argv;
const done = donePath && donePath !== "-" && existsSync(donePath) ? JSON.parse(readFileSync(donePath, "utf8") || "{}") : {};
const WORKER = process.env.WORKER || "https://padel-push.holmberg-padel.workers.dev";
const get = async u => { const r = await fetch(u, { headers: { "User-Agent": "padel.holmberg.st tvstarts", Origin: "https://padel.holmberg.st" } }); if (!r.ok) throw new Error(u + " HTTP " + r.status); return r.json(); };
const fold = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const ev = await get(WORKER + "/events"), now = Date.now(), jobs = [], seen = new Set();
for (const e of (ev.events || []).concat(ev.past || [])) {
  const club = e.tv && ev.tv && ev.tv[e.tv];
  if (!club || e.kind !== "tournament" || !e.classId || Date.parse(e.windowFrom) > now || now - Date.parse(e.windowTo) > 30 * 864e5) continue;
  let datas = [];
  for (const [st, sg] of e.draws || [[0, 0], [1, 0]]) { try { datas.push(await get(API + drawPath(e.classId, st, sg))); } catch (err) { console.warn(err.message); } }
  for (const m of parse(datas)) {
    if (!m.w || !m.c || !m.t || !m.date || seen.has(m.id) || done[m.id]) continue;
    if (![m.a, m.b].some(p => p && p.n.some(n => fold(n) === fold(e.me)))) continue;
    const T = localToDate(m.date);
    const s = (club.s || []).find(x => x.g && courtNo(x.c) === courtNo(m.c) && Date.parse(x.a) <= +T + 15 * 60e3 && (!x.b || +T < Date.parse(x.b)));
    if (!T || !s) continue;
    seen.add(m.id);
    jobs.push({ mid: m.id, x: s.x, g: s.g, a: s.a, t: T.toISOString(), what: e.me + " · " + m.label + " · " + m.c });
  }
}
writeFileSync(outPath || "jobs.json", JSON.stringify(jobs.slice(0, 12), null, 1));
console.log(jobs.length + " matches to look at" + (jobs.length > 12 ? " (12 this run)" : ""));
