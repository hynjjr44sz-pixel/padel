// MATCHi TV (PadelGo): which hall of a club player's event has cameras, and that hall's streams (live and recorded)
// around the play days. Halls: tvclubs.js (generated). Streams: POST streams.padelgo.tv/Media/channel {clubId}, public.
// Watched at https://matchi.tv/watch?s=<externalId>.
import CLUBS from "./tvclubs.js";
import { PLAYERS } from "./discover.js";
import { localToDate } from "./tz.js";
import { LANG } from "./rankedin.js";

const STOP = new Set(["padel", "club", "klubb", "sportklubb", "sports", "sport", "ab", "och", "and", "the", "at", "pa", "i", "of", "center", "centre", "padelcenter", "hall", "hallen", "arena"]);
const words = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(w => w && !STOP.has(w));
const flat = s => " " + String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
const build = list => list.map(([id, n]) => ({ id, n, w: words(n), f: flat(n) })).filter(c => c.w.length);
let NAMES = build(CLUBS);
// The weekly list (tvclubs.json on the branch "tvdata", built by .github/workflows/tvclubs.yml) replaces the bundled one
export const TV_LIST_URL = "https://raw.githubusercontent.com/hynjjr44sz-pixel/padel/tvdata/tvclubs.json";
// When matches actually began in their recordings ({mid: {x, o seconds | null}}, .github/workflows/tvstarts.yml)
export const TV_STARTS_URL = "https://raw.githubusercontent.com/hynjjr44sz-pixel/padel/tvdata/tvstarts.json";
export function validClubs(list) {
  return Array.isArray(list) && list.length >= 100 && list.every(c => Array.isArray(c) && Number.isInteger(c[0]) && typeof c[1] === "string" && Array.isArray(c[2]));
}
export function useClubs(list) { if (validClubs(list)) NAMES = build(list); return NAMES.length; }

// A place ("Padelverket Haninge Sportklubb", or an away team "Golden Padel A") -> the camera hall whose distinctive
// words are all in it (the most words wins), else null. A hall with one distinctive word ("Golden Padel") only when its
// whole name is in the place ("Golden Padel A") or the place has that word alone ("Järfälla Padel" for "Järfälla Padel
// Club"): "Padel Nord" must not match every place with "nord" in it.
export function matchClub(place) {
  const w = new Set(words(place)), f = flat(place);
  if (!w.size) return null;
  let best = null;
  for (const c of NAMES) if (c.w.every(x => w.has(x)) && (c.w.length > 1 || f.includes(c.f) || w.size === 1) && (!best || c.w.length > best.w.length)) best = c;
  return best ? { id: best.id, n: best.n } : null;
}
// An event (tournament: its venue; team league day: the tie's venue, or the home team's name for an away tie) -> hall
export function eventClub(e) {
  if (!e) return null;
  if (e.kind === "teamleague") {
    for (const t of e.ties || []) { const c = matchClub(t.venue) || (t.home === false ? matchClub(t.opp) : null); if (c) return c; }
    return null;
  }
  return matchClub(e.venue);   // not the address: a city in it ("… Norrköping") is not the hall
}
// Media/channel items -> streams [{x, c court, a start, b end, e ended?, t title}]. PadelGo's times are UTC without a zone
// (its own player reads them with moment.utc): kept as ISO with Z.
const utc = s => s ? String(s).slice(0, 19) + "Z" : "";
export function parseMedia(list) {
  return (Array.isArray(list) ? list : []).filter(m => m && m.externalId && m.startDateTime).map(m => ({
    x: m.externalId, c: String(m.courtDescription || "").replace(/\s+(?:at|på)\s+.*$/i, "").trim(), a: utc(m.startDateTime),
    b: utc(m.endDateTime), e: m.actualEndDateTime ? 1 : 0, g: m.bunnyVideoStreamGuid || "", t: String(m.description || "").replace(/\s+-\s+.*$/, "").trim().slice(0, 80)
  }));
}
export async function fetchClubMedia(budget, clubId) {
  if (budget.left < 1) throw new Error("subrequest budget");
  budget.left--;
  const r = await fetch("https://streams.padelgo.tv/Media/channel", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "padel.holmberg.st" },
    body: JSON.stringify({ stream: true, liveStream: true, highlight: false, sortOrder: 0, club: clubId, clubId, page: 1, take: 40 }), signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error("PadelGo HTTP " + r.status);
  return parseMedia(await r.json());
}

// A stream on now: started, not ended, at most 30 min past its planned end
export const tvLive = (x, t) => !x.e && Date.parse(x.a) <= +t && (!x.b || +t < Date.parse(x.b) + 30 * 60e3);
export const courtNo = c => { const m = /(\d+)/.exec(String(c || "")); return m ? m[1] : null; };

// "The stream is on": a club pair's next match (live view nx: court, time) in a hall with cameras, its court's stream
// live and the match about to start (15 min before to 45 min after its time). -> [{k, pids, m}], k = stream:match (sent
// once). Team league days: no courts in RankedIn, so none.
const and = (xs, w) => xs.length > 1 ? xs.slice(0, -1).join(", ") + " " + w + " " + xs[xs.length - 1] : xs[0] || "";
export function tvNotes(clubs, live, events, t, sent = [], players = PLAYERS) {
  const byKey = new Map((events || []).map(e => [e.key, e])), by = new Map(players.map(p => [+p.pid, p])), groups = new Map();
  for (const pid of Object.keys(live || {})) {
    const x = live[pid];
    if (!x || x.st !== "next" || !x.c || !x.mid || !x.d || !x.t) continue;   // a match with its court and time
    const e = byKey.get(x.key);
    if (!e || e.kind === "teamleague") continue;
    const c = eventClub(e), club = c && clubs && clubs[c.id], at = localToDate(x.d);
    if (!club || !at || +t < +at - 15 * 60e3 || +t > +at + 45 * 60e3) continue;
    const s = (club.s || []).find(y => courtNo(y.c) === courtNo(x.c) && tvLive(y, t));
    if (!s) continue;
    const k = s.x + ":" + x.mid;
    if (sent.includes(k)) continue;
    const g = groups.get(k) || { k, s, x, n: club.n, pids: [] };
    if (!g.pids.includes(+pid)) g.pids.push(+pid);
    groups.set(k, g);
  }
  return [...groups.values()].map(g => {
    const names = g.pids.map(p => by.get(p)).filter(Boolean).map(p => p.name), url = "https://matchi.tv/watch?s=" + encodeURIComponent(g.s.x);
    const body = [g.x.lab, g.x.c, g.n].filter(Boolean).join(" · ") + (g.x.opp ? " · mot " + g.x.opp : "");
    const esBody = [LANG.es.lab(g.x.lab), String(g.x.c).replace(/^Bana /, "Pista "), g.n].filter(Boolean).join(" · ") + (g.x.opp ? " · contra " + g.x.opp : "");
    return { k: g.k, pids: g.pids, m: { title: and(names, "och") + " sänds live på MATCHi TV", body, tag: "padel-tv-" + g.x.mid, url,
      es: { title: and(names, "y") + " en directo en MATCHi TV", body: esBody } } };
  });
}
