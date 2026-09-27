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

// Routes a RankedIn API path (with query) to a response body. Unknown paths -> 404.
export function route(path, over = {}) {
  const u = new URL("https://x" + path), q = k => u.searchParams.get(k), p = u.pathname.toLowerCase();
  if (over[path] !== undefined) return over[path];
  for (const k of Object.keys(over)) if (k.endsWith("*") && path.startsWith(k.slice(0, -1))) return over[k];
  if (p.endsWith("/player/participatedeventsasync")) return q("playerId") === "1675246" ? A("pe_thea") : A("pe_kian");
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
