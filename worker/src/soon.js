// Snart match: about a quarter of an hour before a club pair's next tournament match (its time from the draw, the live
// view's "next"), one notis per match to those who follow them: when, which round, against whom, on which court.
import { localToDate } from "./tz.js";
export function soonNotes(live, t, sent = [], players = []) {
  const done = new Set(sent.map(String)), by = new Map(), P = new Map(players.map(p => [Number(p.pid), p]));
  Object.keys(live || {}).forEach(pid => {
    const x = live[pid];
    if (!x || x.st !== "next" || !x.mid || !x.d || !x.t || done.has(String(x.mid))) return;
    const at = localToDate(String(x.d).slice(0, 19)), left = at ? +at - +t : -1;
    if (left <= 5 * 60e3 || left > 25 * 60e3) return;
    const m = by.get(x.mid) || { x, pids: [] };
    m.pids.push(Number(pid)); by.set(x.mid, m);
  });
  return [...by.values()].map(({ x, pids }) => {
    const who = pids.map(p => P.get(p)).filter(Boolean), names = who.map(p => p.name).join(" & ") || "Klubben";
    const court = x.c ? " · " + x.c : "", url = "./#" + (who[0] ? who[0].who : "") + "/m" + x.mid;
    return { k: String(x.mid), pids, m: {
      title: names + " spelar " + x.t + ": " + (x.lab || "match"), body: (x.opp ? "Mot " + x.opp : "Motståndare klara senare") + court + (x.cls ? " · " + x.cls : ""), tag: "padel-snart-" + x.mid, url,
      es: { title: names + " juega a las " + x.t + ": " + (x.lab || "partido"), body: (x.opp ? "Contra " + x.opp : "Rivales por decidir") + court + (x.cls ? " · " + x.cls : "") } } };
  });
}
