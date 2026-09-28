// Finds every upcoming or ongoing event the club's players (players.json) are entered in, straight from
// RankedIn: tournaments (one entry per player and class: partner, draw stages) and team leagues (one entry
// per team and play day, shared by the roster players of that team). Runs for a few players at a time
// (index.js rotates through the roster); what it did not look at is kept from the previous record.
// index.html has a copy of the same rules for the opened player when the worker cannot be reached.
import { localToDate, isoLocal, dayOf, isoDay } from "./tz.js";
import ROSTER from "./players.js";

// who = route key on the page ("#thea"), me = full name as RankedIn writes it
export const PLAYERS = ROSTER.map(p => ({ who: p.key, pid: p.pid, me: p.name, name: p.short, gender: p.gender, rt: p.rt, ag: p.ag, rid: p.rid || null,
  team: p.team, teamId: p.teamId, league: p.league, division: p.division, rin: p.rankedinId || null }));
export const BY_PID = new Map(PLAYERS.map(p => [p.pid, p]));
// Thea and Kian were the first two players: old push subscriptions ({thea, kian}) and links refer to them.
export const LEGACY = { thea: 1675246, kian: 1680004 };
const legacyFirst = pids => pids.slice().sort((a, b) => (Object.values(LEGACY).includes(b) ? 1 : 0) - (Object.values(LEGACY).includes(a) ? 1 : 0));
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
// GetClassesAndDrawNamesAsync -> the class's published draws as [[stage, strength], ...], or null (not published)
export function drawsOf(names, classId) {
  const row = (Array.isArray(names) ? names : []).find(x => x && String(x.Id) === String(classId));
  return row && Array.isArray(row.TournamentDraws) && row.TournamentDraws.length
    ? [...new Set(row.TournamentDraws.map(d => (d.Stage || 0) + ":" + (d.Strength || 0)))].map(s => s.split(":").map(Number)).sort((x, y) => x[0] - y[0] || x[1] - y[1])
    : null;
}
export const namesPath = tournamentId => "/tournament/GetClassesAndDrawNamesAsync/?tournamentId=" + tournamentId;
export const profilePath = rin => "/player/playerprofileinfoasync?rankedinId=" + encodeURIComponent(rin) + "&language=en";
// Profile header -> {url, thumb, placeholder} (placeholder: RankedIn's default rin_logo, no photo of their own).
export function photoOf(x, pid) {
  const h = x && x.Header, ok = u => typeof u === "string" && /^https:\/\/[a-z0-9.-]+\//i.test(u) && u.length < 500 ? u : null;
  if (!h || (pid && h.PlayerId && Number(h.PlayerId) !== Number(pid))) return null;
  const url = ok(h.ImageOriginalUrl) || ok(h.ImageThumbnailUrl), thumb = ok(h.ImageThumbnailUrl) || url;
  if (!url) return null;
  return { url, thumb, placeholder: h.ImageId === 0 || /\/rin_logo/i.test(url) };
}
export const ratingPath = pid => "/rating/GetPlayerRatingAsync?id=" + pid;
// Profile statistics -> this year's doubles record {w, l} ("32-4"), or null.
export function wlOf(x) {
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String((x && x.Statistics && x.Statistics.WinLossDoublesCurrentYear) || ""));
  return m ? { w: +m[1], l: +m[2] } : null;
}
// GetPlayerRatingAsync -> the SPF skill of the player's own list (WD 65, MD 64), or null.
export function skillOf(list, rid) {
  const r = (Array.isArray(list) ? list : []).find(x => x && x.RatingId === rid && typeof x.RatingValue === "number");
  return r ? r.RatingValue : null;
}
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
  const noneKey = e.Id + ":" + p.who + ":" + ctx.today;
  if (!found.length && ctx.none.has(noneKey)) return [];   // looked today, not in any class (withdrawn, reserve)
  if (!found.length || ctx.now - new Date(old[0].scanned || 0) > DAY) {
    // Ongoing or starting within 48 h (the classes are settled): only the known classes are checked, one call
    // each, instead of every class of the tournament (which would not fit the live-time discovery budget).
    const near = found.length && localToDate(info.StartDate || e.StartDate) - ctx.now < 2 * DAY;
    const classes = near ? found.map(f => ({ Id: f.classId, Name: f.cls })) : info.Classes || [];
    found = [];
    for (const c of classes) {
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
  if (!found.length) { ctx.none.add(noneKey); return []; }
  const names = await get(namesPath(e.Id));
  const where = venueOf(info), out = [];
  for (const f of found) {
    const draws = drawsOf(names, f.classId);
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
  // The roster knows the team of its own league: no lookup needed.
  let t = p.league === e.Id && p.teamId ? { teamId: p.teamId, teamName: p.team, divisionName: p.division } : null;
  // A roster team is refreshed when its first roster player is looked up (every 40-50 min, like a player), not for
  // every team mate in a batch; the others keep its entries. Unknown so far: whoever comes first.
  if (t && ctx.prev.some(x => x.kind === "teamleague" && x.leagueId === e.Id && x.teamId === t.teamId) &&
    (PLAYERS.find(x => x.league === e.Id && x.teamId === t.teamId) || p).pid !== p.pid) return [];
  if (!t) {
    const teams = await get("/teamleague/GetTeamLeagueTeamDetailsAsync?language=en&teamLeagueId=" + e.Id + "&participantId=" + p.pid);
    t = Array.isArray(teams) && teams[0];
  }
  if (!t) return [];
  ctx.teams.add(e.Id + ":" + t.teamId);
  const tm = await get("/teamleague/GetTeamMatchesAsync?teamid=" + t.teamId + "&language=en");
  const mates = PLAYERS.filter(x => x.teamId === t.teamId);
  const old = ctx.prev.find(x => x.kind === "teamleague" && x.teamId === t.teamId && x.players);
  let players = mates.length ? mates.map(x => x.me) : old ? old.players : null;
  if (!players) {
    try {
      const hp = await get("/TeamLeague/GetTeamLeagueTeamHomepageAsync?teamId=" + t.teamId + "&language=en");
      players = ((hp && hp.team && hp.team.players) || []).slice().sort((a, b) => (a.playerOrder || 0) - (b.playerOrder || 0)).map(x => String(x.firstName || "").trim()).filter(Boolean);
    } catch (err) {
      if (err && err.budget) throw err;
      players = null;
    }
  }
  const pids = legacyFirst([...new Set(mates.map(x => x.pid).concat(p.pid))]), first = BY_PID.get(pids[0]) || p;
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
  // who/pid/me: the team's first player (Thea/Kian first), for links; pids: every roster player in the team.
  return Object.keys(days).sort().map(day => ({
    key: "l" + e.Id + "-" + t.teamId + "-" + day, kind: "teamleague", who: first.who, me: first.me, pid: first.pid, pids,
    id: e.Id, leagueId: e.Id, name: cleanName(h.Name || e.Name), url: RI + (h.EventUrl || e.Link),
    teamId: t.teamId, team: t.teamName, division: t.divisionName || "", teamUrl: t.teamUrl ? RI + t.teamUrl : null, players,
    date: day, round: days[day].round, ties: days[day].ties.sort((a, b) => (a.time || "99").localeCompare(b.time || "99")),
    windowFrom: isoLocal(day, "07:00"), windowTo: isoLocal(day, "23:00"), cover: days[day].ties.map(x => "tm" + x.id)
  }));
}

// get(path) -> parsed JSON (throws on HTTP errors; err.budget = out of subrequests).
// prev: the last discovery record ({events, ended}). players: whom to look up now (default: everyone).
// Returns {events, ended, none, photos: {pid: {url, thumb, placeholder}}, board: {pid: {sk, w, l, y, rk, rp, rd, up}}, refreshed: [who], partial}: events of the players (and teams) looked up are
// replaced, everything else is kept from prev. partial = someone in `players` could not be finished.
export async function discover(get, now, prev, players = PLAYERS) {
  // Several players in the same tournament or team: fetch its info, class lists and team matches once per run.
  const seen = new Map(), raw = get;
  get = path => { if (!seen.has(path)) seen.set(path, raw(path)); return seen.get(path); };
  const ctx = { now, today: dayOf(now), prev: (prev && prev.events) || [], ended: new Set((prev && prev.ended) || []), teams: new Set(),
    none: new Set(((prev && prev.none) || []).filter(k => k.endsWith(":" + dayOf(now)))) };
  const fresh = [], refreshed = new Set(), teams = new Set();
  let partial = false;
  for (const p of players) {
    const mine = [];
    ctx.teams = new Set();
    try {
      const pe = await get("/player/ParticipatedEventsAsync?playerId=" + p.pid + "&language=en&skip=0&take=100");
      for (const e of (pe && pe.Payload) || []) {
        if (![3, 4].includes(e.Type) || [2, 4].includes(e.State)) continue;
        if (ctx.ended.has((e.Type === 4 ? "t" : "l") + e.Id)) continue;
        const start = localToDate(e.StartDate);
        if (start && now - start > (e.Type === 4 ? 30 : 330) * DAY) continue;   // old league still "Active"
        mine.push(...await (e.Type === 4 ? tournament : teamleague)(p, e, get, ctx));
      }
    } catch (err) {
      partial = true;   // this player keeps the previous entries; out of budget: the next ones may still fit (memoized calls)
      continue;
    }
    refreshed.add(p.who);
    ctx.teams.forEach(k => teams.add(k));
    fresh.push(...mine);
  }
  // Profile photos (the page shows them for players without a photo in players.json): one call per player of the
  // batch, after everyone's events so they never take their budget; the others keep the previous record's.
  // The same profile carries this year's W–L for the club leaderboard ("board", home view: Topplistan): no extra
  // call. Skill and ranking (sk, rk, rp, rd, up) come from index.js (the hourly ranking check) and are kept as they are.
  const was = (prev && prev.photos) || {}, got = {}, wasB = (prev && prev.board) || {}, gotB = {};
  const year = +dayOf(now).slice(0, 4);
  for (const p of players) {
    if (!p.rin) continue;
    let x = null;
    try { x = await raw(profilePath(p.rin)); }
    catch (err) { if (err && err.budget) break; }
    const ph = photoOf(x, p.pid), wl = x && !(x.Header && x.Header.PlayerId && Number(x.Header.PlayerId) !== p.pid) ? wlOf(x) : null;
    if (ph) got[p.pid] = ph;
    if (wl) gotB[p.pid] = { w: wl.w, l: wl.l, y: year };
  }
  const photos = {}, board = {};
  PLAYERS.forEach(p => {
    const ph = got[p.pid] || was[p.pid];
    if (ph) photos[p.pid] = ph;
    const b = { ...(wasB[p.pid] || {}), ...(gotB[p.pid] || {}) };
    if (Object.keys(b).length) board[p.pid] = b;
  });
  const known = new Set(PLAYERS.map(p => p.who));
  const out = ctx.prev.filter(x => x.kind === "teamleague" ? !teams.has(x.leagueId + ":" + x.teamId) : !refreshed.has(x.who) && known.has(x.who));
  const byKey = new Map();
  for (const x of fresh) {
    const was = byKey.get(x.key);
    if (was) { was.pids = legacyFirst([...new Set(was.pids.concat(x.pids))]); continue; }
    byKey.set(x.key, x);
  }
  out.push(...byKey.values());
  out.sort((a, b) => a.windowFrom.localeCompare(b.windowFrom) || a.key.localeCompare(b.key));
  return { events: out, ended: [...ctx.ended].slice(-300), none: [...ctx.none].slice(-100), photos, board, refreshed: [...refreshed], partial };
}
