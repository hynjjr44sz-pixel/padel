// RankedIn draw -> flat match list -> notiser. Wording mirrors diffNotify() in index.html,
// and ids/tags are identical ("padel-<classId>:m<MatchId>") so the OS never shows both.

export function drawUrl(classId, stage) {
  return "https://api.rankedin.com/v1/tournament/GetDrawsForStageAndStrengthAsync?tournamentClassId=" +
    encodeURIComponent(classId) + "&drawStrength=0&drawStage=" + stage + "&isReadonly=true&language=en";
}

const slug = n => String(n).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const SHORT = { "Suarez Jessica": "Suarez" };
const surname = n => SHORT[n] || (n.split(" ").length > 1 ? n.split(" ").slice(1).join(" ") : n);
export const short = p => p.n.map(surname).join(" / ");
const firstNames = p => p.n.map(n => n.split(" ")[0]).join(" och ");
const flip = s => s ? s.split(" ").map(x => /^\d+-\d+$/.test(x) ? x.split("-").reverse().join("-") : x).join(" ") : s;

function cancelNote(mv) {
  const cs = String(mv.CancellationStatus || "").trim();
  if (!cs && !mv.HasCancellation) return null;
  if (/w\.?\s*o/i.test(cs)) return "W.O.";
  if (/ret|upp/i.test(cs)) return "Uppgivet";
  return cs || "W.O.";
}
// Winner's side, as on the page. A match tie-break arrives as 1-0 + LoserTiebreak -> "10-x".
function score(mv, cancelled) {
  const ds = mv.Score && mv.Score.DetailedScoring;
  if (!Array.isArray(ds) || !ds.length) return null;
  let out = ds.map(x => {
    const f = Number(x && x.FirstParticipantScore), s = Number(x && x.SecondParticipantScore), lt = x && x.LoserTiebreak;
    if (isNaN(f) || isNaN(s)) return null;
    if (f + s === 1) {
      if (lt != null && !isNaN(Number(lt))) { const w = Math.max(10, Number(lt) + 2); return f ? [w, Number(lt)] : [Number(lt), w]; }
      return "MTB";
    }
    return [f, s];
  });
  if (out.some(x => x === null)) return null;
  let won = 0, lost = 0;
  out.forEach(x => { if (x === "MTB" || x[0] > x[1]) won++; else if (x[1] > x[0]) lost++; });
  if (!cancelled && lost > won) out = out.map(x => x === "MTB" ? x : [x[1], x[0]]);
  return out.map(x => x === "MTB" ? x : x.join("-")).join(" ");
}
const hhmm = d => { const m = /^(\d{4})-\d\d-\d\dT(\d\d):(\d\d)/.exec(d || ""); return m && +m[1] > 2000 ? m[2] + ":" + m[3] : ""; };

function koPair(p) {
  const f = p && p.FirstPlayer;
  if (!p || !p.EventParticipantId || !f || !f.Name || f.Name === "Pending") return null;
  return { id: String(p.EventParticipantId), n: [f.Name, p.SecondPlayer && p.SecondPlayer.Name].filter(Boolean) };
}
function rrPair(c) {
  const pl = c && c.ParticipantCell && c.ParticipantCell.Players;
  if (!Array.isArray(pl) || !pl.length) return null;
  return { id: "p" + pl.map(x => x.Id).join("-"), n: pl.map(x => x.Name).filter(Boolean) };
}
function koLabel(r, R, plate) {
  if (plate) return r === R - 1 ? "Plate-final" : "Omgång " + (r + 1);
  return r === R - 1 ? "Final" : r === R - 2 ? "Semifinal" : r === R - 3 ? "Kvartsfinal" : "Omgång " + (r + 1);
}

// All draws of all stages -> [{id, di, r, R, kind, label, dlabel, a, b, w, s, note, t, c, date}]
export function parse(stages) {
  const ko = [], rr = [];
  stages.forEach(data => (Array.isArray(data) ? data : []).forEach(dr => {
    if (dr && dr.Elimination && Array.isArray(dr.Elimination.DrawData)) ko.push(dr.Elimination);
    else if (dr && dr.RoundRobin && Array.isArray(dr.RoundRobin.Pool)) rr.push(dr.RoundRobin);
  }));
  ko.sort((x, y) => (x.PlacesStartPos || 0) - (y.PlacesStartPos || 0));
  const out = [];
  ko.forEach((el, di) => el.DrawData.forEach(col => (Array.isArray(col) ? col : []).forEach(c => {
    if (!c || !c.Round || !c.MatchId) return;
    const R = c.MaxRound || c.Round, r = c.Round - 1, mv = c.MatchViewModel || {};
    const a = koPair(c.ChallengerParticipant), b = koPair(c.ChallengedParticipant);
    const m = { id: String(c.MatchId), di, r, R, kind: "ko", label: koLabel(r, R, di > 0), dlabel: di > 0 ? "Plate" : "Lottning",
      a, b, w: null, s: null, note: null, t: hhmm(c.Date), c: String(c.CourtName || "").trim(), date: c.Date || "" };
    const wid = c.WinnerParticipantId && String(c.WinnerParticipantId);
    if (wid && (a && a.id === wid || b && b.id === wid)) {
      m.w = a && a.id === wid ? "a" : "b"; m.note = cancelNote(mv); m.s = score(mv, !!m.note);
    }
    out.push(m);
  })));
  rr.forEach((pool, k) => {
    const g = pool.Pool, name = String(pool.Name || "");
    const dlabel = /^round ?robin$/i.test(name) || !name ? "Gruppspel" : name.replace(/^(pool|group)\s*/i, "Grupp ");
    // Grid: row i vs column j, scores from the row's side. Each match appears twice; take j > i.
    for (let i = 1; i < g.length; i++) for (let j = i + 1; j < (g[i] || []).length; j++) {
      const cell = g[i][j], mc = cell && cell.MatchCell;
      if (!mc || !mc.MatchId) continue;
      const a = rrPair(g[i][0]), b = rrPair(g[0] && g[0][j]), res = mc.MatchResults || {};
      const m = { id: String(mc.MatchId), di: ko.length + k, r: 0, R: 1, kind: "rr", label: dlabel, dlabel,
        a, b, w: null, s: null, note: null, t: hhmm(mc.Date), c: String(mc.Court || "").trim(), date: mc.Date || "" };
      if (a && b && (res.HasScore || res.HasCancellation) && typeof res.IsFirstParticipantWinner === "boolean") {
        m.w = res.IsFirstParticipantWinner ? "a" : "b"; m.note = cancelNote(res); m.s = score(res, !!m.note);
      }
      out.push(m);
    }
  });
  return out;
}

// Compact state kept in KV: MatchId -> "a,b,w" (participant ids, winner id). Only matches with something known.
export function snapshot(matches) {
  const s = {};
  matches.forEach(m => {
    const w = m.w ? m[m.w].id : "";
    if (m.a || m.b || w) s[m.id] = [m.a ? m.a.id : "", m.b ? m.b.id : "", w].join(",");
  });
  return s;
}
const unpack = v => { const p = String(v || "").split(","); return { a: p[0] || "", b: p[1] || "", w: p[2] || "" }; };

// before/after: snapshots. Returns [{title, body, tag, url}] in the order the page shows them.
export function notes(ev, matches, before) {
  const cid = ev.classId, cls = ev.cls, me = slug(ev.me), url = "./#" + ev.who;
  const isMe = p => !!p && p.n.some(n => slug(n) === me);
  matches.forEach(m => { m.hasMe = isMe(m.a) || isMe(m.b); m.ms = isMe(m.a) ? "a" : "b"; m.meWon = !!(m.w && m.hasMe && m.w === m.ms); });
  const main = matches.filter(m => m.di === 0), R = main.length ? Math.max(...main.map(m => m.R)) : 0;
  const cmp = (x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0) || x.di - y.di || x.r - y.r;
  const played = matches.filter(m => m.hasMe && m.w).sort(cmp), pending = matches.filter(m => m.hasMe && !m.w).sort(cmp);
  const next = pending[0] || null, last = played[played.length - 1] || null;
  const lostMain = played.find(m => m.di === 0 && !m.meWon) || null;
  const champ = !!(last && last.kind === "ko" && last.di === 0 && last.r === last.R - 1 && last.meWon);

  const roundName = m => m.kind === "rr" || m.di === 0 ? m.label : m.dlabel + " · " + m.label;
  const roundDef = m => {
    if (m.kind === "rr") return "gruppmatchen";
    let l = m.label.toLowerCase();
    if (/final$/.test(l)) l += "en";
    return m.di > 0 && !/^plate/.test(l) ? "plate " + l : l;
  };
  const when = m => [m.t, m.c].filter(Boolean);
  const nextText = () => {
    if (!next) return "";
    const op = next[next.ms === "a" ? "b" : "a"];
    return " Nästa: " + [roundName(next).toLowerCase(), when(next).join(", ")].filter(Boolean).join(" ") + (op ? " mot " + short(op) : "") + ".";
  };
  const outCopy = mp => {
    const names = firstNames(mp);
    if (champ) return names + " vann " + cls + ". Grattis!";
    if (last && last.di !== 0) return "Dagen är slut. Bra kämpat, " + names + ".";
    if (!lostMain) return "Dagen är slut.";
    if (lostMain.kind === "ko" && lostMain.r === R - 1) return "Tvåa i " + cls + ". Silver efter en stark dag.";
    if (lostMain.kind === "ko" && lostMain.r === R - 2) return "Semifinalen blev slutstation. Topp fyra, starkt jobbat.";
    if (lostMain.kind === "ko" && lostMain.r === R - 3) return "Kvartsfinalen blev slutstation. Topp åtta, bra kämpat.";
    return "Dagen är slut. Bra kämpat, " + names + ".";
  };

  const mine = [], covered = {};
  let others = [];
  matches.forEach(m => {
    const was = unpack(before[m.id]);
    if (!m.w || was.w) return;
    const wp = m[m.w], lp = m[m.w === "a" ? "b" : "a"], fin = m.kind === "ko" && m.r === m.R - 1, id = cid + ":m" + m.id;
    if (m.hasMe) {
      const mp = m[m.ms], op = m[m.ms === "a" ? "b" : "a"];
      const sc = (m.s ? (m.meWon ? m.s : flip(m.s)) : "") || m.note || "";
      const title = m.di === 0 && fin && m.meWon ? firstNames(mp) + " vann " + cls + "!" :
        firstNames(mp) + (m.meWon ? " vann " : " förlorade ") + roundDef(m) + (sc ? " " + sc : "");
      let body = op ? "Mot " + short(op) + "." : "";
      if (m.meWon) body += nextText();
      else if (!next && m.kind === "ko") body += " " + outCopy(mp);
      if (m.meWon && next) covered[next.id] = true;
      mine.push({ id, title, body: body.trim() });
    } else if (wp) {
      const res = m.s || m.note || "";
      const title = roundName(m) + ": " + short(wp) + (m.kind === "rr" ? " vann" : fin ? (m.di === 0 ? " vann " + cls : " vann plate") : " vidare");
      others.push({ id, wk: wp.id, title, body: (res + (lp ? " mot " + short(lp) : "")).trim() + " · " + cls,
        how: lp ? ("Vann " + roundDef(m) + " " + res + " mot " + short(lp)).replace(/\s+/g, " ").trim() : "" });
    }
  });
  // Next opponent just became known: one result, one notis (the deciding match is folded in).
  if (next) {
    const os = next.ms === "a" ? "b" : "a", op = next[os], was = unpack(before[next.id]);
    if (op && !was[os] && !covered[next.id]) {
      let how = "";
      others = others.filter(o => { if (o.wk !== op.id) return true; how = o.how; return false; });
      mine.push({ id: cid + ":opp:m" + next.id + ":" + op.id, title: firstNames(next[next.ms]) + " möter " + short(op),
        body: (how ? how + ". " : "") + [roundName(next), when(next).join(" · ")].filter(Boolean).join(" ") });
    }
  }
  // Only Thea's/Kian's own matches (and their next opponent) are pushed; other results in the class stay on the page.
  const out = [];
  mine.forEach(o => out.push({ title: o.title, body: o.body, tag: "padel-" + o.id, url }));
  return out;
}
