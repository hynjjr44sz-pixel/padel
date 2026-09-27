// Finds every upcoming or ongoing event Thea and Kian are entered in, straight from RankedIn:
// tournaments (with the class they play, partner and draw stages) and team leagues (one entry per
// play day with the team's ties). Used by the worker (tick + GET /events); index.html has a copy
// of the same rules for when the worker cannot be reached.
import { localToDate, isoLocal, dayOf, isoDay } from "./tz.js";

export const PLAYERS = [
  { who: "thea", pid: 1675246, me: "Thea Holmberg Löving" },
  { who: "kian", pid: 1680004, me: "Kian Borgström" }
];
export const API = "https://api.rankedin.com/v1";
const DAY = 864e5, RI = "https://www.rankedin.com";

export function cleanName(n) {
  n = String(n || "").replace(/\s+/g, " ").trim();
  const spl = /^SPL Swedish Padel League (\S+)/i.exec(n);
  if (spl) return "SPL " + spl[1];
  return n.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+[-–]\s+(sanktion|powered|pwr|by\b|endags).*$/i, "")
    .replace(/\s+(powered|pwr) by.*$/i, "").replace(/\s+/g, " ").trim() || n;
}
// SPF skill rating per class: MD 64, WD 65, XD 66
export function ratingFor(cls) {
  cls = String(cls || "");
  if (/mix|xd/i.test(cls)) return 66;
  if (/dam|women|flick|girl|\bwd\b/i.test(cls)) return 65;
  if (/herr|men|pojk|boy|\bmd\b/i.test(cls)) return 64;
  return null;
}
export const drawPath = (classId, stage, strength) =>
  "/tournament/GetDrawsForStageAndStrengthAsync?tournamentClassId=" + classId + "&drawStrength=" + (strength || 0) + "&drawStage=" + stage + "&isReadonly=true&language=en";
export const rubbersPath = tieId => "/teamleague/GetTeamLeagueTeamsMatchesAsync?teamMatchId=" + tieId + "&language=en";

function venueOf(info) {
  const loc = String(info.LocationName || "").split(",")[0].trim();
  const a = String(info.Address || "").split(",").map(s => s.trim()).filter(Boolean);
  const street = a[0] || "", city = (a[1] || "").replace(/^\d{3}\s?\d{2}\s*/, "");
  return { venue: loc, address: [street, city].filter(Boolean).join(", ") };
}
const hhmmOf = s => { const m = /(\d\d):(\d\d)(?::\d\d)?$/.exec(String(s || "").trim()); return m && m[1] + m[2] !== "0000" ? m[1] + ":" + m[2] : ""; };

async function tournament(p, e, get, ctx) {
  const info = ((await get("/tournament/GetInfoAsync?id=" + e.Id + "&language=en")) || {}).TournamentSidebarModel || {};
  const startDay = String(info.StartDate || e.StartDate).slice(0, 10), endDay = String(info.EndDate || info.StartDate || e.StartDate).slice(0, 10);
  if (endDay < ctx.today || [2, 4].includes(info.EventState)) { ctx.ended.add("t" + e.Id); return []; }
  // Which class(es) is the player in? Cached from the last run; re-checked once a day.
  const old = ctx.prev.filter(x => x.kind === "tournament" && x.who === p.who && x.tournamentId === e.Id && x.classId);
  let found = old.map(x => ({ classId: x.classId, cls: x.cls, partner: x.partner, partnerId: x.partnerId || null, pairs: x.pairs, seed: x.seed, scanned: x.scanned }));
  if (!found.length || ctx.now - new Date(old[0].scanned || 0) > DAY) {
    found = [];
    for (const c of info.Classes || []) {
      const pl = await get("/tournament/GetPlayersForClassAsync?tournamentId=" + e.Id + "&tournamentClassId=" + c.Id + "&language=en");
      const parts = (pl && pl.Participants) || [];
      for (const x of parts) {
        const pp = x.Participant || {}, a = pp.FirstPlayer || {}, b = pp.SecondPlayer || {};
        if (a.Id !== p.pid && b.Id !== p.pid) continue;
        const o = a.Id === p.pid ? b : a;
        found.push({ classId: c.Id, cls: c.Name, partner: o.Name || "", partnerId: o.Id || null, pairs: parts.length, seed: pp.Seed || "", scanned: ctx.now.toISOString() });
      }
    }
  }
  if (!found.length) return [];
  const names = await get("/tournament/GetClassesAndDrawNamesAsync/?tournamentId=" + e.Id);
  const where = venueOf(info), out = [];
  for (const f of found) {
    const row = (Array.isArray(names) ? names : []).find(x => x.Id === f.classId);
    const draws = row && row.TournamentDraws && row.TournamentDraws.length
      ? [...new Set(row.TournamentDraws.map(d => (d.Stage || 0) + ":" + (d.Strength || 0)))].map(s => s.split(":").map(Number)).sort((x, y) => x[0] - y[0] || x[1] - y[1])
      : null;
    const prevE = old.find(x => x.classId === f.classId);
    let format = prevE && JSON.stringify(prevE.draws) === JSON.stringify(draws) ? prevE.format || null : null;
    if (draws && !format) {   // BaseType decides, never the (free text) draw names
      const kinds = new Set();
      for (const [st, sg] of draws) {
        const d = await get(drawPath(f.classId, st, sg));
        (Array.isArray(d) ? d : []).forEach(x => x && x.BaseType && kinds.add(x.BaseType === "RoundRobin" ? "rr" : "ko"));
      }
      format = kinds.size === 2 ? "mixed" : kinds.has("rr") ? "groups" : kinds.has("ko") ? "knockout" : null;
    }
    out.push({
      key: "t" + f.classId + "-" + p.who, kind: "tournament", who: p.who, me: p.me, pid: p.pid,
      id: e.Id, tournamentId: e.Id, classId: f.classId, cls: f.cls, name: cleanName(info.TournamentName || e.Name),
      url: RI + (info.Url || e.Link || "/en/tournament/" + e.Id), start: info.StartDate || e.StartDate, end: info.EndDate || null,
      closes: info.ClosingDate || null, venue: where.venue, address: where.address, partner: f.partner, partnerId: f.partnerId, pairs: f.pairs, seed: f.seed,
      rating: ratingFor(f.cls), draws, format, published: !!draws, scanned: f.scanned,
      windowFrom: isoLocal(startDay, "07:00"), windowTo: isoLocal(endDay, "23:00"), cover: [String(f.classId)]
    });
  }
  return out;
}

async function teamleague(p, e, get, ctx) {
  const h = (await get("/teamleague/GetHeaderAsync?id=" + e.Id + "&language=en")) || {};
  if ((h.EndDate && String(h.EndDate).slice(0, 10) < ctx.today) || [2, 4].includes(h.EventState)) { ctx.ended.add("l" + e.Id); return []; }
  const teams = await get("/teamleague/GetTeamLeagueTeamDetailsAsync?language=en&teamLeagueId=" + e.Id + "&participantId=" + p.pid);
  const t = Array.isArray(teams) && teams[0];
  if (!t) return [];
  const tm = await get("/teamleague/GetTeamMatchesAsync?teamid=" + t.teamId + "&language=en");
  const old = ctx.prev.find(x => x.kind === "teamleague" && x.teamId === t.teamId && x.players);
  let players = old ? old.players : null;
  if (!players) {
    try {
      const hp = await get("/TeamLeague/GetTeamLeagueTeamHomepageAsync?teamId=" + t.teamId + "&language=en");
      players = ((hp && hp.team && hp.team.players) || []).slice().sort((a, b) => (a.playerOrder || 0) - (b.playerOrder || 0)).map(x => String(x.firstName || "").trim()).filter(Boolean);
    } catch (err) {
      if (err && err.budget) throw err;
      players = null;
    }
  }
  const days = {};
  for (const m of (tm && tm.matches) || []) {
    const d = m.details || {}, day = isoDay(d.date || d.time);
    if (!/^\d{4}-\d\d-\d\d$/.test(day) || day < ctx.today) continue;
    const home = m.team1 && m.team1.id === t.teamId, opp = (home ? m.team2 : m.team1) || {};
    (days[day] = days[day] || { round: d.round || null, ties: [] }).ties.push({
      id: m.matchId, time: hhmmOf(d.time), home, opp: opp.name || "", oppId: opp.id || null,
      venue: String(d.locationName || m.location || "").trim(), address: [d.address, d.city].filter(Boolean).join(", "),
      done: !!m.showResults, canceled: !!m.showCanceledInfoText
    });
  }
  return Object.keys(days).sort().map(day => ({
    key: "l" + e.Id + "-" + t.teamId + "-" + day, kind: "teamleague", who: p.who, me: p.me, pid: p.pid,
    id: e.Id, leagueId: e.Id, name: cleanName(h.Name || e.Name), url: RI + (h.EventUrl || e.Link),
    teamId: t.teamId, team: t.teamName, division: t.divisionName || "", teamUrl: t.teamUrl ? RI + t.teamUrl : null, players,
    date: day, round: days[day].round, ties: days[day].ties.sort((a, b) => (a.time || "99").localeCompare(b.time || "99")),
    windowFrom: isoLocal(day, "07:00"), windowTo: isoLocal(day, "23:00"), cover: days[day].ties.map(x => "tm" + x.id)
  }));
}

// get(path) -> parsed JSON (throws on HTTP errors; err.budget = out of subrequests).
// prev: the last discovery record ({events, ended}). Returns {events, ended, partial}.
export async function discover(get, now, prev) {
  // Both players in the same tournament: fetch its info and class lists once per run.
  const seen = new Map(), raw = get;
  get = path => { if (!seen.has(path)) seen.set(path, raw(path)); return seen.get(path); };
  const ctx = { now, today: dayOf(now), prev: (prev && prev.events) || [], ended: new Set((prev && prev.ended) || []) };
  const out = [];
  let partial = false;
  const keepPrev = (who, id, kind) => ctx.prev.filter(x => x.who === who && x.id === id && (!kind || x.kind === kind)).forEach(x => out.push(x));
  for (const p of PLAYERS) {
    let pe;
    try { pe = await get("/player/ParticipatedEventsAsync?playerId=" + p.pid + "&language=en&skip=0&take=100"); }
    catch (err) { partial = true; ctx.prev.filter(x => x.who === p.who).forEach(x => out.push(x)); continue; }
    for (const e of (pe && pe.Payload) || []) {
      if (![3, 4].includes(e.Type) || [2, 4].includes(e.State)) continue;
      if (ctx.ended.has((e.Type === 4 ? "t" : "l") + e.Id)) continue;
      const start = localToDate(e.StartDate);
      if (start && now - start > (e.Type === 4 ? 30 : 330) * DAY) continue;   // old league still "Active"
      const kind = e.Type === 4 ? "tournament" : "teamleague";
      if (partial) { keepPrev(p.who, e.Id, kind); continue; }
      try { out.push(...await (e.Type === 4 ? tournament : teamleague)(p, e, get, ctx)); }
      catch (err) { partial = true; keepPrev(p.who, e.Id, kind); }
    }
  }
  out.sort((a, b) => a.windowFrom.localeCompare(b.windowFrom) || a.key.localeCompare(b.key));
  return { events: out, ended: [...ctx.ended].slice(-300), partial };
}
