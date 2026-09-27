// Team league (SPL) tie -> rubbers -> notiser. The rubbers endpoint is camelCase; challenger = home team,
// scores are from the challenger's side. Tags: "padel-tm<tieId>:..." (index.html uses the same ids).
import { short } from "./rankedin.js";

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

// Home team = challenger. If the player is in a rubber, that settles it.
export function ourSide(tie, rubbers, pid) {
  for (const r of rubbers) for (const sd of ["a", "b"]) if (r[sd] && r[sd].ids.map(String).includes(String(pid))) return sd;
  return tie.home === false ? "b" : "a";
}
// ev: team league play day ({who, pid, team, name, round}); tie: {id, home, opp, time, venue}.
export function tieNotes(ev, tie, rubbers, before) {
  const pid = String(ev.pid), isMe = p => !!p && p.ids.map(String).includes(pid);
  const us = ourSide(tie, rubbers, pid), them = us === "a" ? "b" : "a", url = "./#" + ev.who, cid = "tm" + tie.id;
  const score = r => { const s = r.s ? (us === "a" ? r.s : flipScore(r.s)) : ""; return s || r.note || ""; };
  let W = 0, L = 0;
  rubbers.forEach(r => { if (r.w) { if (r.w === us) W++; else L++; } });
  const tieScore = ev.team + " " + W + "–" + L + " " + tie.opp;
  const mine = [], others = [];
  rubbers.forEach(r => {
    const was = unpack(before[r.id]);
    if (!r.w || was.w) return;
    const ours = r[us], theirs = r[them], won = r.w === us, sc = score(r), id = cid + ":r" + r.id;
    if (isMe(ours)) {
      mine.push({ id, title: firstNames(ours) + (won ? " vann sin match " : " förlorade sin match ") + sc,
        body: ("Mot " + short(theirs) + ". Ställning: " + tieScore + ".").trim() });
    } else {
      others.push({ id, title: ev.team + ": " + short(ours) + (won ? " vann " : " förlorade ") + sc,
        body: "Mot " + short(theirs) + " · " + tieScore });
    }
  });
  // My pair's opponents just became known (lineups published)
  rubbers.forEach(r => {
    if (r.w || !isMe(r[us]) || !r[them]) return;
    if (unpack(before[r.id])[them]) return;
    mine.push({ id: cid + ":opp:r" + r.id + ":" + r[them].id, title: firstNames(r[us]) + " möter " + short(r[them]),
      body: [ev.name, ev.team + " mot " + tie.opp, tie.time, tie.venue].filter(Boolean).join(" · ") });
  });
  const out = [];
  if (others.length > 3) out.push({ title: ev.team + ": " + others.length + " nya resultat", body: others.slice(0, 4).map(o => o.title).join("\n"), tag: "padel-" + cid + "-lag", url });
  else others.forEach(o => out.push({ title: o.title, body: o.body, tag: "padel-" + o.id, url }));
  mine.forEach(o => out.push({ title: o.title, body: o.body, tag: "padel-" + o.id, url }));
  const done = rubbers.length && rubbers.every(r => r.w), wasDone = before._done || (rubbers.length && rubbers.every(r => unpack(before[r.id]).w));
  if (done && !wasDone) {
    const t = W > L ? ev.team + " vann mot " + tie.opp + " " + W + "–" + L : W < L ? ev.team + " förlorade mot " + tie.opp + " " + W + "–" + L : ev.team + " och " + tie.opp + " delade " + W + "–" + L;
    const myR = rubbers.find(r => isMe(r[us]));
    const body = [ev.name + (ev.round ? " omgång " + ev.round : ""), myR ? firstNames(myR[us]) + (myR.w === us ? " vann sin match " : " förlorade sin match ") + score(myR) : ""].filter(Boolean).join(". ") + ".";
    out.push({ title: t, body, tag: "padel-" + cid + ":klar", url });
  }
  return out;
}
