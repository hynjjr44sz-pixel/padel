// Team league (SPL) tie -> rubbers -> notiser. The rubbers endpoint is camelCase; challenger = home team,
// scores are from the challenger's side. Tags: "padel-tm<tieId>:..." (index.html uses the same ids).
import { short, linkTo } from "./rankedin.js";

const firstNames = p => p.n.map(n => n.split(" ")[0]).join(" och ");
const TYPE = { 3: "Herr", 4: "Dam", 5: "Mixed" };

function side(x) {
  if (!x || !x.player1Id) return null;
  const ids = [x.player1Id, x.player2Id].filter(Boolean), n = [x.name, x.player2Name].map(s => String(s || "").trim()).filter(Boolean);
  if (!n.length || /^pending$/i.test(n[0])) return null;
  return { id: ids.join("-"), ids, n };
}
// Challenger-side sets ("6-3 4-6 10-8"); a match tie-break is 1-0 + loserTiebreak.
function sets(sc) {
  const ds = sc && sc.detailedScoring;
  if (!Array.isArray(ds) || !ds.length) return null;
  const out = ds.map(x => {
    const f = Number(x && x.firstParticipantScore), s = Number(x && x.secondParticipantScore), lt = x && x.loserTiebreak;
    if (isNaN(f) || isNaN(s)) return null;
    if (f + s === 1 && lt != null && !isNaN(Number(lt))) { const w = Math.max(10, Number(lt) + 2); return f ? w + "-" + lt : lt + "-" + w; }
    return f + "-" + s;
  });
  return out.some(x => x === null) ? null : out.join(" ");
}
export const flipScore = s => s ? s.split(" ").map(x => /^\d+-\d+$/.test(x) ? x.split("-").reverse().join("-") : x).join(" ") : s;

// -> [{id, kind, k, a, b, w, s, note, date}] in RankedIn order
export function parseTie(data) {
  const out = [];
  (Array.isArray(data) ? data : []).forEach(g => {
    const type = g && g.settings && g.settings.matchType, list = (g && g.matches && g.matches.matches) || [];
    list.forEach(m => {
      if (!m || !m.id) return;
      const r = m.matchResult || {}, a = side(m.challenger), b = side(m.challenged);
      const x = { id: String(m.id), type, kind: TYPE[type] || "", k: out.length + 1, a, b, w: null, s: null, note: null, date: m.date || "" };
      const cancel = m.cancellation || r.cancellationStatus || (r.hasCancellation ? "W.O." : null);
      if (a && b && (r.isPlayed || m.state === 6 || cancel) && typeof r.isFirstParticipantWinner === "boolean") {
        x.w = r.isFirstParticipantWinner ? "a" : "b";
        x.s = sets(r.score);
        if (cancel) x.note = /ret|upp/i.test(String(cancel)) ? "Uppgivet" : "W.O.";
      }
      out.push(x);
    });
  });
  return out;
}
export function snapshotTie(rubbers) {
  const s = {};
  rubbers.forEach(r => { if (r.a || r.b || r.w) s[r.id] = [r.a ? r.a.id : "", r.b ? r.b.id : "", r.w || ""].join(","); });
  if (rubbers.length && rubbers.every(r => r.w)) s._done = 1;
  return s;
}
const unpack = v => { const p = String(v || "").split(","); return { a: p[0] || "", b: p[1] || "", w: p[2] || "" }; };

// Home team = challenger. If one of our players is in a rubber, that settles it.
export function ourSide(tie, rubbers, pid) {
  const want = (Array.isArray(pid) ? pid : [pid]).map(String);
  for (const r of rubbers) for (const sd of ["a", "b"]) if (r[sd] && r[sd].ids.map(String).some(x => want.includes(x))) return sd;
  return tie.home === false ? "b" : "a";
}
// Challenger-side score -> the given side's view
const sideScore = (r, sd) => { const s = r.s ? (sd === "a" ? r.s : flipScore(r.s)) : ""; return s || r.note || ""; };
const rosterOf = ev => (ev.roster && ev.roster.length ? ev.roster : [{ who: ev.who, pid: ev.pid }]).map(p => ({ who: p.who, pid: Number(p.pid) }));

// ev: team league play day ({who, pid, team, name, round, roster?}); tie: {id, home, opp, time, venue}.
// roster: the club's players in the team ([{who, pid}], default: ev.who/ev.pid alone). Each notis carries
// pids: the players it is about. A rubber goes to its own pair's players only; the tie result goes to
// every team player (one variant per pair that played, same tag; the worker merges them per device).
export function tieNotes(ev, tie, rubbers, before) {
  const roster = rosterOf(ev), all = roster.map(p => String(p.pid));
  const pidsOf = x => x ? roster.filter(p => x.ids.map(String).includes(String(p.pid))).map(p => p.pid) : [];
  const isMe = x => pidsOf(x).length > 0, whoOf = pids => (roster.find(p => p.pid === pids[0]) || roster[0]).who;
  const us = ourSide(tie, rubbers, all), them = us === "a" ? "b" : "a", cid = "tm" + tie.id;
  let W = 0, L = 0;
  rubbers.forEach(r => { if (r.w) { if (r.w === us) W++; else L++; } });
  const tieScore = ev.team + " " + W + "–" + L + " " + tie.opp;
  const mine = [];
  rubbers.forEach(r => {
    const was = unpack(before[r.id]);
    if (!r.w || was.w || !isMe(r[us])) return;   // teammates outside the roster: page only
    const ours = r[us], theirs = r[them], won = r.w === us;
    mine.push({ id: cid + ":r" + r.id, mid: r.id, pids: pidsOf(ours), title: firstNames(ours) + (won ? " vann sin match " : " förlorade sin match ") + sideScore(r, us),
      body: ("Mot " + short(theirs) + ". Ställning: " + tieScore + ".").trim() });
  });
  // A pair's opponents just became known (lineups published)
  rubbers.forEach(r => {
    if (r.w || !isMe(r[us]) || !r[them]) return;
    if (unpack(before[r.id])[them]) return;
    mine.push({ id: cid + ":opp:r" + r.id + ":" + r[them].id, mid: r.id, pids: pidsOf(r[us]), title: firstNames(r[us]) + " möter " + short(r[them]),
      body: [ev.name, ev.team + " mot " + tie.opp, tie.time, tie.venue].filter(Boolean).join(" · ") });
  });
  const out = mine.map(o => ({ title: o.title, body: o.body, tag: "padel-" + o.id, url: linkTo(whoOf(o.pids), o.mid), pids: o.pids }));
  const done = rubbers.length && rubbers.every(r => r.w), wasDone = before._done || (rubbers.length && rubbers.every(r => unpack(before[r.id]).w));
  if (done && !wasDone) {
    const t = W > L ? ev.team + " vann mot " + tie.opp + " " + W + "–" + L : W < L ? ev.team + " förlorade mot " + tie.opp + " " + W + "–" + L : ev.team + " och " + tie.opp + " delade " + W + "–" + L;
    const head = ev.name + (ev.round ? " omgång " + ev.round : ""), tag = "padel-" + cid + ":klar", played = [];
    rubbers.filter(r => isMe(r[us])).forEach(r => {
      const pids = pidsOf(r[us]);
      played.push(...pids);
      out.push({ title: t, body: head + ". " + firstNames(r[us]) + (r.w === us ? " vann sin match " : " förlorade sin match ") + sideScore(r, us) + ".", tag, url: linkTo(whoOf(pids), r.id), pids });
    });
    const rest = roster.map(p => p.pid).filter(p => !played.includes(p));
    if (rest.length) out.push({ title: t, body: head + ".", tag, url: linkTo(whoOf(rest)), pids: rest });
  }
  return out;
}

// Compact state of a tie for the page's home view ({res, nx, sc}); see summary() in rankedin.js.
export function tieSummary(ev, tie, rubbers) {
  const roster = rosterOf(ev), all = roster.map(p => String(p.pid));
  const pidsOf = x => x ? roster.filter(p => x.ids.map(String).includes(String(p.pid))).map(p => p.pid) : [];
  const us = ourSide(tie, rubbers, all), them = us === "a" ? "b" : "a", res = [], nx = {};
  let W = 0, L = 0;
  rubbers.forEach(r => {
    const pids = pidsOf(r[us]);
    if (r.w) { if (r.w === us) W++; else L++; }
    if (!pids.length) return;
    const who = (roster.find(p => p.pid === pids[0]) || roster[0]).who, lab = "Match " + r.k + (r.kind ? " · " + r.kind : "");
    if (r.w) {
      const lose = r.w === "a" ? "b" : "a";
      res.push({ mid: r.id, lab, d: r.date || "", win: short(r[r.w]), lose: r[lose] ? short(r[lose]) : "", s: sideScore(r, r.w), pids, won: r.w === us ? pids : [], who });
    } else pids.forEach(pid => { nx[pid] = { st: "next", mid: r.id, lab, t: tie.time || "", opp: r[them] ? short(r[them]) : null, vs: tie.opp, who }; });
  });
  return { res: res.reverse().slice(0, 4), nx, sc: W + "–" + L, opp: tie.opp };
}
