// MATCHi TV (PadelGo): which hall of a club player's event has cameras, and that hall's streams (live and recorded)
// around the play days. Halls: tvclubs.js (generated). Streams: POST streams.padelgo.tv/Media/channel {clubId}, public.
// Watched at https://matchi.tv/watch?s=<externalId>.
import CLUBS from "./tvclubs.js";

const STOP = new Set(["padel", "club", "klubb", "sportklubb", "sports", "sport", "ab", "och", "and", "the", "at", "pa", "i", "of", "center", "centre", "padelcenter", "hall", "hallen", "arena"]);
const words = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(w => w && !STOP.has(w));
const flat = s => " " + String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
const NAMES = CLUBS.map(([id, n]) => ({ id, n, w: words(n), f: flat(n) })).filter(c => c.w.length);

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
// Media/channel items -> streams [{x, c court, a start, b end, e ended?, t title}] (local wall times as given)
export function parseMedia(list) {
  return (Array.isArray(list) ? list : []).filter(m => m && m.externalId && m.startDateTime).map(m => ({
    x: m.externalId, c: String(m.courtDescription || "").replace(/\s+(?:at|på)\s+.*$/i, "").trim(), a: String(m.startDateTime).slice(0, 19),
    b: String(m.endDateTime || "").slice(0, 19), e: m.actualEndDateTime ? 1 : 0, t: String(m.description || "").replace(/\s+-\s+.*$/, "").trim().slice(0, 80)
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
