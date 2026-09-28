// A fake api.rankedin.com for tests: real responses saved on 2026-09-27 (fixtures/auto) plus a few
// synthesized ones (Järfälla info/players, team league headers) in the same shape.
import { readFileSync } from "node:fs";

const A = n => JSON.parse(readFileSync(new URL("./fixtures/auto/" + n + ".json", import.meta.url)));
const F = n => JSON.parse(readFileSync(new URL("./fixtures/" + n, import.meta.url)));
const player = (id, name) => ({ Id: id, Name: name, RatingBegin: 12 });
const pair = (a, b) => ({ Participant: { EventParticipantId: null, FirstPlayer: a, SecondPlayer: b, Seed: "" } });

export const JARFALLA_INFO = { TournamentSidebarModel: {
  EventState: 3, TournamentName: "Järfälla Padel Open no 11 - Sanktionerad B,C,D", StartDate: "2026-09-25T17:00:00", EndDate: "2026-09-27T23:00:00",
  ClosingDate: "2026-09-22T23:59:00", Url: "/en/tournament/66374/jarfalla-padel-open-no-11-sanktionerad-b-c-d",
  LocationName: "Järfälla Padel, Järfälla", Address: "Skarprättarvägen 1, 176 77 Järfälla, Sverige",
  Classes: [{ Id: 164677, Name: "Herrar C" }, { Id: 164681, Name: "Damer C" }] } };
const tlHeader = (id, name, end) => ({ ...A("tl829_header"), Id: id, Name: name, EventState: 7, EndDate: end, EventUrl: "/en/teamleague/" + id + "/x" });

// Profile photos (playerprofileinfoasync, by rankedinId): Sanna and Kian have one of their own, Oliver's points at a
// file that is gone (the page falls back to initials), Lisa has RankedIn's default logo; the others: 404.
export const CDN = "https://rankedin-prod-cdn-adavg8d3dwfegkbd.z01.azurefd.net/images/upload/player/";
export const PROFILE_PHOTOS = {
  R000214688: [1055851, 900001, CDN + "900001.png", CDN + "900001thumb.png"],
  R000266815: [1680004, 121978, CDN + "121978.png", CDN + "121978thumb.png"],
  R000267043: [1683035, 900002, "https://cdn.rankedin.com/images/upload/player/900002.png", "https://cdn.rankedin.com/images/upload/player/900002thumb.png"],
  R000267664: [1702723, 0, "https://cdn.rankedin.com/images/rin_logo_sm.png", "https://cdn.rankedin.com/images/rin_logo_sm.png"]
};
// This year's doubles record (leaderboard "Årets vinster"): every roster player's profile has one; players without a
// photo entry answer with the statistics only (no header, so no photo is recorded for them).
const ROSTER = JSON.parse(readFileSync(new URL("../../players.json", import.meta.url), "utf8"));
export const WL = { 1675246: "32-4", 1849853: "30-6", 1680004: "14-11", 2073852: "12-10", 1702723: "9-9" };
export const wlFor = pid => WL[pid] || ((pid % 13) + 2) + "-" + ((pid % 5) + 3);
export function profile(rin) {
  const x = PROFILE_PHOTOS[rin], r = ROSTER.find(p => p.rankedinId === rin);
  const st = r ? { WinLossDoublesCurrentYear: wlFor(r.pid), EventsParticipatedDoublesCurrentYear: "6" } : {};
  if (x) return { Header: { PlayerId: x[0], ImageId: x[1], ImageOriginalUrl: x[2], ImageThumbnailUrl: x[3], RankedinId: rin, Form: ["W", "L"] }, Statistics: st };
  return r ? { Statistics: st } : null;
}
// SPF list of 2026-09-21 from players.json; StandingDiff (places gained on that list) made up per player.
export const climbOf = pid => ({ 1675246: 18, 1680004: 41, 1849853: -3 })[pid] ?? ((pid % 9) - 4);
function ranking(name) {
  const r = ROSTER.find(p => p.name === name);
  return { Payload: r && r.rank ? [{ Participant: { NewParticipantId: r.pid }, StandingDiff: climbOf(r.pid), Name: r.name,
    ParticipantPoints: { RankingDate: r.rankDate + "T00:00:00", Standing: r.rank, Points: r.points } }] : [] };
}

// "Förslag på tävlingar" (fixtures/cal, saved 2026-09-28): the SPF calendar (45 events), each event's info and classes,
// and the ranking list's boundary rows. Radius filters: the event's own coordinates, else its town's (made up here,
// as RankedIn's server has them).
const C = n => JSON.parse(readFileSync(new URL("./fixtures/cal/" + n + ".json", import.meta.url)));
export const TOWN = { 73353: [59.40, 18.03], 69142: [55.72, 13.02], 73575: [55.79, 13.11], 74476: [57.71, 11.97], 73208: [58.59, 16.19],
  73832: [58.41, 15.62], 73468: [59.14, 18.13], 73211: [57.71, 11.97], 73406: [57.77, 12.27], 73585: [56.67, 12.86], 74299: [55.64, 13.07],
  71858: [59.27, 15.21], 73041: [59.38, 13.50], 73214: [57.16, 13.41], 74469: [57.78, 14.16], 74584: [63.83, 20.26], 73334: [57.66, 12.12],
  73802: [59.36, 18.00], 74668: [65.58, 22.15], 73212: [59.14, 18.13], 74167: [59.27, 15.21], 73742: [59.40, 18.08], 74337: [59.37, 16.51],
  74394: [56.05, 12.69], 74479: [57.30, 13.54], 73829: [59.20, 17.63] };
export function kmFromHome(id) {
  const i = C("info_" + id).TournamentSidebarModel, [la, lo] = i.Latitude ? [i.Latitude, i.Longtitude] : TOWN[id], r = x => x * Math.PI / 180;
  const h = Math.sin(r(la - 58.903) / 2) ** 2 + Math.cos(r(58.903)) * Math.cos(r(la)) * Math.sin(r(lo - 17.947) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
const CAP_ROW = { "3:61": ["rank_m61", 2], "3:201": ["rank_m201", 2], "3:1201": ["rank_m1201", 2], "4:51": ["rank_w51", 0], "4:161": ["rank_w161", 0], "4:701": ["rank_w701", 2] };
function calRoute(p, q) {
  if (p.endsWith("/organization/getorganisationeventsasync")) {
    if (!q("take")) return null;
    const all = C("org_window"), r = Number(q("radiusKm"));
    return r ? { payload: all.payload.filter(e => kmFromHome(e.eventId) <= r), totalCount: 0 } : all;
  }
  if (p.endsWith("/tournament/getclassessectionasync")) { try { return C("classes_" + q("tournamentId")); } catch (e) { return null; } }
  if (p.endsWith("/tournament/getinfoasync") && q("language") === "sv") { try { return C("info_" + q("id")); } catch (e) { return null; } }
  if (p.endsWith("/ranking/searchrankingplayersasync") && q("searchTerm") === "") {
    const x = CAP_ROW[q("rankingType") + ":" + (Number(q("skip")) + 1)];
    return x ? { Payload: [C(x[0]).Payload[x[1]]] } : { Payload: [] };
  }
  return undefined;
}

// Routes a RankedIn API path (with query) to a response body. Unknown paths -> 404.
export function route(path, over = {}) {
  const u = new URL("https://x" + path), q = k => u.searchParams.get(k), p = u.pathname.toLowerCase();
  if (over[path] !== undefined) return over[path];
  for (const k of Object.keys(over)) if (k.endsWith("*") && path.startsWith(k.slice(0, -1))) return over[k];
  const cal = calRoute(p, q);
  if (cal !== undefined) return cal;
  // Thea and Cassandra (same pair in Damer C, same SPL team), Kian and Andreas (Herrar C, SPL team); others: nothing.
  if (p.endsWith("/player/participatedeventsasync")) {
    const pid = q("playerId");
    return pid === "1675246" || pid === "1849853" ? A("pe_thea") : pid === "1680004" || pid === "2073852" ? A("pe_kian") : { Payload: [], TotalCount: 0 };
  }
  if (p.endsWith("/tournament/getinfoasync")) return q("id") === "73554" ? A("t73554_info") : q("id") === "66374" ? JARFALLA_INFO : null;
  if (p.endsWith("/tournament/getplayersforclassasync")) {
    const c = q("tournamentClassId");
    if (c === "173729") return A("t73554_players_173729");
    if (c === "164681") return { Participants: [pair(player(1675246, "Thea Holmberg Löving"), player(1849853, "Cassandra Ersson")), pair(player(1, "A B"), player(2, "C D"))] };
    if (c === "164677") return { Participants: [pair(player(1680004, "Kian Borgström"), player(2073852, "Andreas Mickos"))] };
    return { Participants: [] };
  }
  if (p.endsWith("/tournament/getclassesanddrawnamesasync/")) return q("tournamentId") === "73554" ? A("t73554_classnames_draws") : A("t66374_classnames_draws");
  if (p.endsWith("/tournament/getdrawsforstageandstrengthasync")) {
    if (q("tournamentClassId") === "164681") return F("dc_1112.json");
    if (q("tournamentClassId") === "164677") return F("dc_1112.json");
    return [];
  }
  if (p.endsWith("/teamleague/getheaderasync")) {
    const id = q("id");
    return id === "947" ? tlHeader(947, "SPL Swedish Padel League Damer 2026-27 ", "2027-03-31T23:55:00") :
      id === "946" ? tlHeader(946, "SPL Swedish Padel League Herrar 2026-27 ", "2027-03-31T23:55:00") :
      tlHeader(+id, "Klubbligan", "2026-05-31T23:55:00");
  }
  if (p.endsWith("/teamleague/getteamleagueteamdetailsasync")) return q("participantId") === "1675246" ? A("tl_thea") : A("tl_kian");
  if (p.endsWith("/teamleague/getteammatchesasync")) return q("teamid") === "3355655" ? A("tl_teammatches_3355655") : A("tl_teammatches_3383536");
  if (p.endsWith("/teamleague/getteamleagueteamhomepageasync")) return q("teamId") === "3355655" ? A("tl_homepage_3355655") : { team: { players: [] } };
  if (p.endsWith("/teamleague/getteamleagueteamsmatchesasync")) return A("tm_166800_matches");
  if (p.endsWith("/player/playerprofileinfoasync")) return profile(q("rankedinId"));
  if (p.endsWith("/rating/getplayerratingasync")) {
    const r = ROSTER.find(x => String(x.pid) === q("id"));
    return r && r.skill != null ? [{ RatingId: r.rid, RatingValue: r.skill }, { RatingId: 66, RatingValue: 11.11 }] : [];
  }
  if (p.endsWith("/ranking/searchrankingplayersasync")) return ranking(q("searchTerm"));
  return null;
}
// globalThis.fetch replacement: RankedIn -> route(), everything else -> push(url, init) (201 by default)
export function install(state = {}) {
  state.calls = state.calls || [];
  state.pushes = state.pushes || [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith("https://api.rankedin.com/v1")) {
      const path = url.slice("https://api.rankedin.com/v1".length);
      state.calls.push(path);
      const body = route(path, state.over || {});
      return body == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body));
    }
    state.pushes.push({ url, init });
    return new Response(null, { status: (state.status || {})[url] || 201 });
  };
  return state;
}
export { A, F };
