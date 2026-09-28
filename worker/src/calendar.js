// "Förslag på tävlingar": a compact calendar of SPF-sanctioned tournaments starting in the next 8 weeks within
// 200 km of Nynäshamn, built once a night (03:23 local, spread over a few ticks) from RankedIn's SPF organisation
// calendar. The page suggests classes a player may enter from it (SPF rules: the pair's summed points against the
// class cap, 2 x the points of the top player allowed in the class; the caps are read from the ranking list).
// KV "calw": the night's work in progress (a few writes a night); KV "cal": the result, written only when it changed.
import { dayOf, localToDate, offsetAt } from "./tz.js";
import { cleanName, BY_PID } from "./discover.js";

const HOME = { lat: 58.903, lon: 17.947 }, RADIUS = 200, DAYS = 56, SPF = 1917, RI = "https://www.rankedin.com";
// Server-side radius filters (km) for events without coordinates of their own (about half): the smallest one that
// lists the event is its distance band. Asked in order, only until every such event has its band.
const BANDS = [20, 30, 40, 50, 60, 80, 100, 130, 160];
// Boundary rows of the SPF list: the top player allowed in B, C, D (men 61/201/1201, women 51/161/701).
const CAP_ROWS = { M: { B: 61, C: 201, D: 1201 }, F: { B: 51, C: 161, D: 701 } };
const LIST = { M: [3, 82], F: [4, 83] };   // rankingType, ageGroup

export function haversine(a, b) {
  const r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function addDays(day, n) { return new Date(Date.parse(day + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10); }
export const listPath = (from, to, radius) => "/Organization/GetOrganisationEventsAsync?organisationId=1340&Language=sv&skip=0&take=500&IsFinished=false&EventType=4" +
  "&startDate=" + from + "T00:00:00Z&endDate=" + to + "T00:00:00Z" + (radius ? "&lat=" + HOME.lat + "&lng=" + HOME.lon + "&radiusKm=" + radius : "");
export const infoPath = id => "/tournament/GetInfoAsync?id=" + id + "&language=sv";
export const classesPath = id => "/tournament/GetClassesSectionAsync?tournamentId=" + id;
export const capPath = (g, row, day) => "/Ranking/SearchRankingPlayersAsync?rankingId=" + SPF + "&rankingType=" + LIST[g][0] + "&ageGroup=" + LIST[g][1] +
  "&weekFromNow=0&language=en&searchTerm=&skip=" + (row - 1) + "&take=1&rankingDate=" + day;

// Class name -> A/B/C/D or "other" (SPT, youth, veterans, motionsklass). The letter is in the name ("Herr B", "C - Klass",
// "B-Klass herr", "Dam C-klass"); LevelName is not ("Tillfällig ranking" for every A and B class).
const YOUTH_VET = /\b(pojk|flick|junior|veteran|spt|motion)|\b[PF]\s?\d{1,2}\b|\d\d\s?\+/i;
export function classLevel(name) {
  const n = String(name || "").toUpperCase();
  if (YOUTH_VET.test(name || "")) return "other";
  const m = /(?:^|[^A-ZÅÄÖ])([ABCD])(?![A-ZÅÄÖ])/.exec(n);
  return m ? m[1] : "other";
}
// Class -> F, M, mixed or other (youth, veterans, singles). The name decides; ClassDescription ("Women-Doubles /
// Women-Main") when the name says nothing. Age groups (Under/Over) and singles are "other".
export function classGender(name, desc) {
  const n = String(name || ""), d = String(desc || "");
  if (YOUTH_VET.test(n) || /under|over \d|singles/i.test(d)) return "other";
  if (/mix/i.test(n)) return "mixed";
  if (/\bdam/i.test(n)) return "F";
  if (/\bherr/i.test(n)) return "M";
  if (/^mixed/i.test(d)) return "mixed";
  if (/^women/i.test(d)) return "F";
  if (/^men/i.test(d)) return "M";
  return "other";
}
// GetClassesSectionAsync -> [{id, name, level, gender, maxPoints, players, limit}]: SPF-ranked classes only (the race
// rankings repeat the same classes; "osanktionerad" classes are not sanctioned).
export function parseClasses(x) {
  return ((x && x.Classes) || []).filter(c => c && c.OrganizationName === "SPF Padel Ranking" && !/osanktion/i.test(c.ClassName || ""))
    .map(c => ({ id: c.ClassId, name: String(c.ClassName || "").replace(/\s+/g, " ").trim(), level: classLevel(c.ClassName), gender: classGender(c.ClassName, c.ClassDescription),
      maxPoints: Number(c.MaxPoints) || 0, players: Number(c.PlayersCount) || 0, limit: Number(c.ParticipantsLimit) || 0 }));
}
const titleCase = s => s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) : s;
// GetInfoAsync -> what the calendar needs (coordinates 0.0 = unknown).
export function parseInfo(x) {
  const i = (x && x.TournamentSidebarModel) || null;
  if (!i) return null;
  const lat = Number(i.Latitude) || 0, lon = Number(i.Longtitude) || 0, admin = i.AdminCarouselVm && (i.AdminCarouselVm.AdminsList || [])[0];
  const a = String(i.Address || "").split(",").map(s => s.trim()).filter(Boolean);
  while (a.length > 1 && /^(sverige|sweden)$/i.test(a[a.length - 1])) a.pop();
  const zip = /\d{3}\s?\d{2}\s+(\D+)$/.exec(a[a.length - 1] || ""), city = a.length > 1 ? a[a.length - 1].replace(/^\d{3}\s?\d{2}\s*/, "") : zip ? zip[1] : "";
  return { name: i.TournamentName || "", start: i.StartDate || null, end: i.EndDate || null, closes: i.ClosingDate || null, state: i.EventState ?? null,
    url: i.Url || null, club: i.ClubName || null, venue: String(i.LocationName || "").split(",")[0].trim() || (admin && admin.Name) || null,
    city: city ? titleCase(city.trim()) : null,
    lat: lat && lon ? +lat.toFixed(4) : 0, lon: lat && lon ? +lon.toFixed(4) : 0,
    spf: Array.isArray(i.Rankings) ? i.Rankings.some(r => r && r.Id === SPF) : true };
}
// Sign-up open: state 1 (Upcoming) and before the closing time (local, no offset).
export function signupOpen(e, t) { const c = localToDate(e.closes); return e.state === 1 && (!c || +t < +c); }

// Roster players entered in a calendar event: from the discovery record (no RankedIn call). {pid, classId}
export function registrations(disc, ids) {
  const want = new Set(ids.map(Number)), out = new Map();
  for (const e of (disc && disc.events) || []) {
    if (!e || e.kind !== "tournament" || !want.has(Number(e.tournamentId))) continue;
    for (const pid of [e.pid, e.partnerId].map(Number).filter(p => BY_PID.has(p))) out.set(e.tournamentId + ":" + pid + ":" + e.classId, { tid: Number(e.tournamentId), pid, classId: e.classId });
  }
  return [...out.values()];
}

// Every 6 hours (local 03:23, 09:23, 15:23, 21:23, a step per tick until done), so a newly published tournament
// shows the same day. CAL_ANY=1 (local tests): any minute.
const CAL_HOURS = [3, 9, 15, 21];
export function calendarDue(t, env = {}) {
  if (env.CAL_ANY === "1") return true;
  const l = new Date(+t + offsetAt(+t) * 3600e3), m = l.getUTCMinutes();
  return CAL_HOURS.includes(l.getUTCHours()) && m >= 23 && m <= 38 && m % 10 !== 7;   // never on a discovery minute
}
// The run a tick belongs to: the day plus the 6-hour slot (a new run starts at each slot).
export function runOf(t) {
  const h = new Date(+t + offsetAt(+t) * 3600e3).getUTCHours();
  return dayOf(t) + "@" + Math.max(...CAL_HOURS.filter(x => x <= h).concat([-1]));
}

// One step. get(path) -> JSON (throws; err.budget = out of subrequests). w: the work in progress (KV "calw"),
// prev: the last calendar (KV "cal"), disc: the discovery record. Returns {w, cal} (cal only when finished).
export async function calendarStep(get, t, w, prev, disc) {
  const today = dayOf(t), run = runOf(t);
  if (!w || w.day !== today || (w.run || today + "@3") !== run) w = { day: today, run, list: null, info: {}, cls: {}, band: {}, bi: 0, caps: null };
  if (w.done) return { w, cal: null };
  const old = new Map(((prev && prev.events) || []).map(e => [e.id, e]));
  try {
    if (!w.list) {
      const x = await get(listPath(today, addDays(today, DAYS), RADIUS));
      w.list = ((x && x.payload) || []).filter(e => e && e.type === 4 && e.eventId).map(e => ({ id: e.eventId, name: e.eventName || "", url: e.eventUrl || null,
        club: e.club || null, city: e.city || null, start: e.startDate || null, end: e.endDate || null, state: e.eventState ?? null }));
    }
    for (const e of w.list) {
      // A call that fails (not the budget) is recorded as false: the event keeps last night's data, or is left out.
      if (!(e.id in w.info)) { try { w.info[e.id] = parseInfo(await get(infoPath(e.id))) || false; } catch (err) { if (err.budget) throw err; w.info[e.id] = false; } }
      if (!(e.id in w.cls)) { try { w.cls[e.id] = parseClasses(await get(classesPath(e.id))); } catch (err) { if (err.budget) throw err; w.cls[e.id] = false; } }
    }
    const need = () => w.list.filter(e => { const i = w.info[e.id], o = old.get(e.id); return !(i && i.lat) && !(o && o.km != null && !o.lat && o.approx) && !(e.id in w.band); });
    while (need().length && w.bi < BANDS.length) {
      const r = BANDS[w.bi], x = await get(listPath(today, addDays(today, DAYS), r)), ids = new Set(((x && x.payload) || []).map(e => e.eventId));
      need().forEach(e => { if (ids.has(e.id)) w.band[e.id] = r; });
      w.bi++;
    }
    if (!w.caps) w.caps = capsFresh(prev && prev.caps, today) ? prev.caps : await readCaps(get, today);
  } catch (err) {
    if (!err.budget) console.warn("calendar", err.message);
    return { w, cal: null };
  }
  w.done = 1;
  return { w, cal: buildCalendar(w, t, prev, disc) };
}
// The list changes in the night to Monday: caps older than a week are read again (6 calls).
function capsFresh(c, today) { return !!(c && c.d && addDays(c.d, 7) > today && c.M && c.F); }
async function readCaps(get, today) {
  const out = { d: null, M: {}, F: {} };
  for (const g of ["M", "F"]) for (const L of ["B", "C", "D"]) {
    const x = await get(capPath(g, CAP_ROWS[g][L], today)), r = ((x && x.Payload) || [])[0], pp = r && r.ParticipantPoints;
    if (!pp || typeof pp.Points !== "number") return null;
    out[g][L] = +(2 * pp.Points).toFixed(2);
    out.d = String(pp.RankingDate || today).slice(0, 10);
  }
  return out;
}
export function buildCalendar(w, t, prev, disc) {
  const old = new Map(((prev && prev.events) || []).map(e => [e.id, e])), until = addDays(w.day, DAYS);
  const events = w.list.map(e => {
    const i = w.info[e.id], o = old.get(e.id);
    if (!i && !o) return null;
    if (i && !i.spf) return null;
    const lat = i ? i.lat : o.lat || 0, lon = i ? i.lon : o.lon || 0;
    let km, approx = false;
    if (lat) km = Math.round(haversine(HOME, { lat, lon }));
    else if (e.id in w.band) { km = w.band[e.id]; approx = true; }
    else if (o && o.km != null && o.approx) { km = o.km; approx = true; }
    else { km = RADIUS; approx = true; }
    if (km > RADIUS) return null;
    const start = (i && i.start) || e.start, day = String(start || "").slice(0, 10);
    if (!day || day < w.day || day > until) return null;
    const cls = w.cls[e.id] || (o && o.classes) || [];
    return { id: e.id, name: cleanName((i && i.name) || e.name), club: (i && i.club) || e.club || (i && i.venue) || (o && o.club) || null,
      city: e.city ? titleCase(e.city.trim()) : (i && i.city) || (o && o.city) || null, lat, lon, km, ...(approx ? { approx: 1 } : {}),
      start, end: (i && i.end) || e.end, closes: i ? i.closes : o.closes, state: i ? i.state ?? e.state : e.state,
      url: RI + ((i && i.url) || e.url || "/sv/tournament/" + e.id), classes: cls };
  }).filter(Boolean).sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.id - b.id);
  const regs = registrations(disc, events.map(e => e.id));
  events.forEach(e => { e.regs = regs.filter(r => r.tid === e.id).map(r => ({ pid: r.pid, classId: r.classId })); });
  return { v: 1, at: t.toISOString(), day: w.day, caps: w.caps || (prev && prev.caps) || null, events };
}
// Same content (the build time aside)?
export function sameCalendar(a, b) { return !!a && !!b && JSON.stringify([a.caps, a.events]) === JSON.stringify([b.caps, b.events]); }

// ---- SPF eligibility (index.html has a copy for the page; page-e2e checks the two agree) ----
const ORDER = ["D", "C", "B", "A"], POS = { M: { A: 60, B: 200, C: 1200 }, F: { A: 50, B: 160, C: 700 } };
// The lowest class a player belongs to: the pair cap (2 x the boundary player's points) against 2 x own points;
// without caps, the standing (men 1-60 A, -200 B, -1200 C; women 1-50, -160, -700); not ranked: D.
export function baseLevel(caps, g, pts, rank) {
  if (g !== "M" && g !== "F") return null;
  if (caps && caps[g] && typeof pts === "number") return ORDER.find(L => L === "A" || 2 * pts <= caps[g][L]);
  if (typeof rank === "number") { const p = POS[g]; return rank <= p.A ? "A" : rank <= p.B ? "B" : rank <= p.C ? "C" : "D"; }
  return "D";
}
// Own class and one above (a pair may always play higher, never lower); lower: the class below with the most a
// partner may have (cap - own points), when there is room.
export function eligibility(caps, g, pts, rank) {
  const base = baseLevel(caps, g, pts, rank);
  if (!base) return null;
  const i = ORDER.indexOf(base), levels = ORDER.slice(i, i + 2), low = i > 0 ? ORDER[i - 1] : null;
  const room = low && caps && caps[g] && typeof pts === "number" ? +(caps[g][low] - pts).toFixed(2) : null;
  return { base, levels, cap: caps && caps[g] && base !== "A" ? caps[g][base] : null, lower: room != null && room > 0 ? { level: low, partnerMax: room } : null };
}
// Up to n suggestions for a roster player {pid, gender, pts, rank}: sign-up open, not entered (the calendar's regs,
// plus taken: tournament ids the page knows the player is in), a class of the player's gender at the own level or one up.
export function suggestFor(cal, p, t, taken = [], n = 6) {
  const el = eligibility(cal && cal.caps, p.gender, p.pts, p.rank);
  if (!el || !cal) return [];
  const out = [];
  for (const e of cal.events || []) {
    if (!signupOpen(e, t) || taken.map(Number).includes(e.id) || (e.regs || []).some(r => r.pid === p.pid)) continue;
    const cls = (e.classes || []).filter(c => c.gender === p.gender && el.levels.includes(c.level)).sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));
    if (cls.length) out.push({ id: e.id, classes: cls.map(c => c.id), mates: [...new Set((e.regs || []).map(r => r.pid))] });
    if (out.length >= n) break;
  }
  return out;
}
