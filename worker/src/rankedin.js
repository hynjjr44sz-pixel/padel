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
const DOW = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"];
// "2026-10-09T18:00:00" (RankedIn local time) -> "fre"
export const dowOf = d => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || ""); return m && +m[1] > 2000 ? DOW[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] : ""; };
export const courtName = c => { c = String(c || "").trim(); return /^\d+$/.test(c) ? "Bana " + c : c; };
// Time and court of a match as kept in the snapshot ("2026-09-27T12:45@Bana 1")
export const tcOf = m => String(m.date || "").slice(0, 16) + "@" + String(m.c || "").replace(/,/g, " ").trim();
// Deep link the page understands: "./#thea/m6872156" (tab + RankedIn match id)
export const linkTo = (who, mid) => "./#" + who + (mid ? "/m" + mid : "");

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
  out.pools = [];
  rr.forEach((pool, k) => {
    const g = pool.Pool, name = String(pool.Name || "");
    const dlabel = /^round ?robin$/i.test(name) || !name ? "Gruppspel" : name.replace(/^(pool|group)\s*/i, "Grupp ");
    out.pools.push({ di: ko.length + k, label: dlabel, rows: (Array.isArray(pool.Standings) ? pool.Standings : []).map(r => ({
      n: [r.DoublesPlayer1Model && r.DoublesPlayer1Model.Name, r.DoublesPlayer2Model && r.DoublesPlayer2Model.Name].filter(Boolean),
      standing: r.Standing, wins: r.Wins || 0, losses: r.Losses || 0 })).filter(r => r.n.length) });
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

// Compact state kept in KV: MatchId -> "a,b,w,time@court" (participant ids, winner id, schedule).
// Only matches with something known. Old records have no schedule part (tc null: never a "Ny tid" notis).
export function snapshot(matches) {
  const s = {};
  matches.forEach(m => {
    const w = m.w ? m[m.w].id : "";
    if (m.a || m.b || w) s[m.id] = [m.a ? m.a.id : "", m.b ? m.b.id : "", w, tcOf(m)].join(",");
  });
  return s;
}
export const unpack = v => { const p = String(v || "").split(","); return { a: p[0] || "", b: p[1] || "", w: p[2] || "", tc: p.length > 3 ? p.slice(3).join(",") : null }; };

// before/after: snapshots. Returns [{title, body, tag, url}] in the order the page shows them.
export function notes(ev, matches, before) {
  const cid = ev.classId, cls = ev.cls, me = slug(ev.me);
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
      mine.push({ id, title, body: body.trim(), mid: m.id });
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
        body: (how ? how + ". " : "") + [roundName(next), when(next).join(" · ")].filter(Boolean).join(" "), mid: next.id });
      covered[next.id] = true;
    }
    // Time or court of the next match changed (the notiser above already carry the new time).
    const tc = tcOf(next);
    const at = was.tc != null ? was.tc.indexOf("@") : -1, od = at < 0 ? "" : was.tc.slice(0, at), oc = at < 0 ? "" : was.tc.slice(at + 1);
    const oldT = hhmm(od + ":00"), moved = od !== String(next.date || "").slice(0, 16);
    // A real change only: the old time was known (a first schedule is not "Ny tid"), and for a court move the old court too.
    if (!covered[next.id] && was.tc != null && was.tc !== tc && next.t && oldT && (moved || oc)) {
      const op2 = next[os], otherDay = od.slice(0, 10) !== String(next.date || "").slice(0, 10);
      mine.push({ id: cid + ":tid:m" + next.id + ":" + slug(tc), tag: cid + ":tid:m" + next.id, mid: next.id,
        title: (moved ? "Ny tid: " : "Ny bana: ") + firstNames(next[next.ms]) + " spelar " + roundDef(next) + " " +
          [(otherDay ? dowOf(next.date) + " " : "") + next.t, courtName(next.c)].filter(Boolean).join(", "),
        body: ("Förut " + [(otherDay ? dowOf(od) + " " : "") + oldT, courtName(oc)].filter(x => x.trim()).join(", ") + "." + (op2 ? " Mot " + short(op2) + "." : "")).trim() });
    }
  }
  // My group just finished: final placing (from RankedIn's standings, else wins and game difference).
  const ORD = ["etta", "tvåa", "trea", "fyra", "femma", "sexa", "sjua", "åtta"];
  (matches.pools || []).forEach(pl => {
    const ms = matches.filter(m => m.kind === "rr" && m.di === pl.di);
    if (!ms.length || !ms.some(m => m.hasMe) || ms.some(m => !m.w) || ms.every(m => unpack(before[m.id]).w)) return;
    let rows = pl.rows.slice().sort((x, y) => (x.standing || 99) - (y.standing || 99));
    if (!rows.length || rows.reduce((a, r) => a + r.wins + r.losses, 0) !== 2 * ms.length) {   // standings missing or not updated yet
      const t = {};
      ms.forEach(m => ["a", "b"].forEach(sd => { if (!m[sd]) return; const r = t[m[sd].id] = t[m[sd].id] || { n: m[sd].n, wins: 0, losses: 0 }; if (m.w === sd) r.wins++; else r.losses++; }));
      rows = Object.values(t).sort((x, y) => y.wins - x.wins);
    }
    const mi = rows.findIndex(r => r.n.some(n => slug(n) === me));
    if (mi < 0) return;
    const place = rows[mi].standing || mi + 1, where = pl.label === "Gruppspel" ? "gruppen" : pl.label;
    const lastMine = ms.filter(m => m.hasMe).sort(cmp).pop();
    mine.push({ id: cid + ":grupp:" + slug(pl.label), title: firstNames(rows[mi]) + " slutade " + (ORD[place - 1] || place + ":a") + " i " + where,
      body: rows.slice(0, 5).map((r, i) => (r.standing || i + 1) + ". " + short(r) + " " + r.wins + "–" + r.losses).join("\n"), mid: lastMine && lastMine.id });
  });
  // Only Thea's/Kian's own matches (and their next opponent) are pushed; other results in the class stay on the page.
  const out = [];
  mine.forEach(o => out.push({ title: o.title, body: o.body, tag: "padel-" + (o.tag || o.id), url: linkTo(ev.who, o.mid) }));
  return out;
}

// The draw of a class Thea/Kian plays was just published: one notis with the first match (or the group).
// ev: {who, me, classId, cls, name}. Same wording, tag and url as drawNote() in index.html.
export function drawNote(ev, matches) {
  const me = slug(ev.me), isMe = p => !!p && p.n.some(n => slug(n) === me);
  const cmp = (x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0) || x.di - y.di || x.r - y.r;
  const mine = matches.filter(m => isMe(m.a) || isMe(m.b)).sort(cmp), open = mine.filter(m => !m.w), first = (open.length ? open : mine)[0];
  const tag = "padel-" + ev.classId + ":lottning", where = [ev.name, ev.cls].filter(Boolean).join(", ");
  if (!first) return { title: "Lottningen klar i " + ev.cls, body: where ? where + "." : "", tag, url: linkTo(ev.who) };
  const ms = isMe(first.a) ? "a" : "b", mp = first[ms], op = first[ms === "a" ? "b" : "a"];
  const when = [[dowOf(first.date), first.t].filter(Boolean).join(" "), courtName(first.c)].filter(Boolean).join(", ");
  let title, body;
  if (first.kind === "rr") {
    const seen = {}, others = [];
    matches.filter(m => m.kind === "rr" && m.di === first.di).forEach(m => ["a", "b"].forEach(sd => {
      const p = m[sd];
      if (p && !isMe(p) && !seen[p.id]) { seen[p.id] = 1; others.push(short(p)); }
    }));
    title = "Lottningen klar: " + firstNames(mp) + " i " + (first.label === "Gruppspel" ? "gruppen" : first.label);
    body = (others.length ? "Med " + others.join(", ") + ". " : "") + (when ? "Första match " + when + ". " : "") + where + (where ? "." : "");
  } else {
    let rd = first.label.toLowerCase();
    if (/final$/.test(rd)) rd += "en";
    title = "Lottningen klar: " + firstNames(mp) + (op ? " möter " + short(op) : " börjar i " + rd);
    body = (when ? when.charAt(0).toUpperCase() + when.slice(1) + ". " : "") + where + (where ? "." : "");
  }
  return { title, body: body.trim(), tag, url: linkTo(ev.who, first.id) };
}
