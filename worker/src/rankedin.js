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
export const flip = s => s ? s.split(" ").map(x => /^\d+-\d+$/.test(x) ? x.split("-").reverse().join("-") : x).join(" ") : s;

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
// "2026-10-09T18:00:00" (RankedIn local time) -> "fre" (days: the names in another language)
export const dowOf = (d, days = DOW) => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || ""); return m && +m[1] > 2000 ? days[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] : ""; };
export const courtName = c => { c = String(c || "").trim(); return /^\d+$/.test(c) ? "Bana " + c : c; };
// Time and court of a match as kept in the snapshot ("2026-09-27T12:45@Bana 1")
export const tcOf = m => String(m.date || "").slice(0, 16) + "@" + String(m.c || "").replace(/,/g, " ").trim();
// Deep link the page understands: "./#thea/m6872156" (tab + RankedIn match id)
export const linkTo = (who, mid) => "./#" + who + (mid ? "/m" + mid : "");

// Wording of the notiser: Swedish (the default) and Spanish (devices that chose "es"). The match list keeps its
// Swedish labels (the page and the summaries read them); lab() words a label, def() a round with its article.
// Spanish verbs agree with the pair (two first names: plural).
const ORD = ["etta", "tvåa", "trea", "fyra", "femma", "sexa", "sjua", "åtta"];
const ES_LAB = { "Kvartsfinal": "Cuartos de final", "Åttondelsfinal": "Octavos de final", "Plate-final": "Final de Plate", "Gruppspel": "Fase de grupos", "Lottning": "Cuadro" };
const esLab = l => ES_LAB[l] || String(l).replace(/^Omgång /, "Ronda ").replace(/^Grupp /, "Grupo ");
const esCourt = c => { c = String(c || "").trim(); return /^\d+$/.test(c) ? "Pista " + c : c.replace(/^Bana (\d+)$/i, "Pista $1"); };
const esNames = p => p.n.map(n => n.split(" ")[0]).join(" y ");
const pl = (p, one, two) => p.n.length > 1 ? two : one;
// "la semifinal", "los cuartos de final", "la ronda 2"
const esArt = l => { const x = esLab(l); return (/^(Cuartos|Octavos)/.test(x) ? "los " : "la ") + x.charAt(0).toLowerCase() + x.slice(1); };
export const LANG = {
  sv: {
    names: firstNames, vs: " mot ", Vs: "Mot ", dow: d => dowOf(d), court: courtName, at: c => c, lab: l => l, note: n => n,
    // "semifinalen", "plate omgång 2", "gruppmatchen"
    def: m => {
      if (m.kind === "rr") return "gruppmatchen";
      let l = m.label.toLowerCase();
      if (/final$/.test(l)) l += "en";
      return m.di > 0 && !/^plate/.test(l) ? "plate " + l : l;
    },
    starts: (p, l) => { let rd = l.toLowerCase(); if (/final$/.test(rd)) rd += "en"; return " börjar i " + rd; },
    won: p => firstNames(p) + " vann", lost: p => firstNames(p) + " förlorade", Won: () => "Vann", cheer: s => s + "!",
    meets: (p, op) => firstNames(p) + " möter " + short(op), plays: p => firstNames(p) + " spelar",
    placed: (p, place) => firstNames(p) + " slutade " + (ORD[place - 1] || place + ":a"), in: " i ", group: l => l === "Gruppspel" ? "gruppen" : l,
    next: " Nästa: ", newTime: "Ny tid: ", newCourt: "Ny bana: ", before: "Förut ", drawn: "Lottningen klar: ", drawnIn: "Lottningen klar i ",
    with: "Med ", first: "Första match ", congrats: "Grattis!", over: "Dagen är slut.", fought: n => "Dagen är slut. Bra kämpat, " + n + ".",
    silver: cls => "Tvåa i " + cls + ". Silver efter en stark dag.", semi: "Semifinalen blev slutstation. Topp fyra, starkt jobbat.",
    quarter: "Kvartsfinalen blev slutstation. Topp åtta, bra kämpat.",
    // team league
    own: " sin match ", standing: "Ställning", round: " omgång ",
    tie: (team, opp, W, L) => W > L ? team + " vann mot " + opp + " " + W + "–" + L : W < L ? team + " förlorade mot " + opp + " " + W + "–" + L : team + " och " + opp + " delade " + W + "–" + L,
    lineup: (team, opp) => team + ": laguppställningen mot " + opp + " är klar", match: "Match "
  },
  es: {
    names: esNames, vs: " contra ", Vs: "Contra ", dow: d => dowOf(d, ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"]), court: esCourt, at: esCourt,
    lab: esLab, note: n => n === "Uppgivet" ? "Abandono" : n,
    def: m => m.kind === "rr" ? "el partido de grupo" : esArt(m.label) + (m.di > 0 && !/^Plate/.test(m.label) ? " de Plate" : ""),
    starts: (p, l) => " " + pl(p, "empieza", "empiezan") + " en " + esArt(l),
    won: p => esNames(p) + " " + pl(p, "ganó", "ganaron"), lost: p => esNames(p) + " " + pl(p, "perdió", "perdieron"), Won: p => pl(p, "Ganó", "Ganaron"),
    cheer: s => "¡" + s + "!", meets: (p, op) => esNames(p) + " contra " + short(op), plays: p => esNames(p) + " " + pl(p, "juega", "juegan"),
    placed: (p, place) => esNames(p) + " " + pl(p, "terminó", "terminaron") + " " + place + ".º", in: " en ",
    group: l => l === "Gruppspel" ? "el grupo" : /^Grupp /.test(l) ? "el grupo " + l.slice(6) : l,
    next: " Siguiente: ", newTime: "Nueva hora: ", newCourt: "Nueva pista: ", before: "Antes: ", drawn: "Cuadro publicado: ", drawnIn: "Cuadro publicado: ",
    with: "Con ", first: "Primer partido: ", congrats: "¡Enhorabuena!", over: "Fin del día.", fought: n => "Fin del día. Bien jugado, " + n + ".",
    silver: cls => "Segundo puesto en " + cls + ". Plata tras un gran día.", semi: "Fuera en semifinales. Top 4, muy buen trabajo.",
    quarter: "Fuera en cuartos. Top 8, bien jugado.",
    own: " su partido ", standing: "Marcador", round: " jornada ",
    tie: (team, opp, W, L) => (W > L ? team + " ganó a " + opp : W < L ? team + " perdió contra " + opp : team + " y " + opp + " empataron") + " " + W + "–" + L,
    lineup: (team, opp) => team + ": alineación contra " + opp + " publicada", match: "Partido "
  }
};
// A notis per language -> the Swedish one with the Spanish wording alongside ({..., es: {title, body}}).
export const withEs = (sv, es) => ({ ...sv, es: { title: es.title, body: es.body } });

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

// before/after: snapshots. Returns [{title, body, tag, url, es: {title, body}}] in the order the page shows them.
export function notes(ev, matches, before) {
  const es = notesIn(ev, matches, before, LANG.es);
  return notesIn(ev, matches, before, LANG.sv).map((m, i) => withEs(m, es[i]));
}
function notesIn(ev, matches, before, L) {
  const cid = ev.classId, cls = ev.cls, me = slug(ev.me);
  const isMe = p => !!p && p.n.some(n => slug(n) === me);
  matches.forEach(m => { m.hasMe = isMe(m.a) || isMe(m.b); m.ms = isMe(m.a) ? "a" : "b"; m.meWon = !!(m.w && m.hasMe && m.w === m.ms); });
  const main = matches.filter(m => m.di === 0), R = main.length ? Math.max(...main.map(m => m.R)) : 0;
  const cmp = (x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0) || x.di - y.di || x.r - y.r;
  const played = matches.filter(m => m.hasMe && m.w).sort(cmp), pending = matches.filter(m => m.hasMe && !m.w).sort(cmp);
  const next = pending[0] || null, last = played[played.length - 1] || null;
  const lostMain = played.find(m => m.di === 0 && !m.meWon) || null;
  const champ = !!(last && last.kind === "ko" && last.di === 0 && last.r === last.R - 1 && last.meWon);

  const roundName = m => m.kind === "rr" || m.di === 0 ? L.lab(m.label) : L.lab(m.dlabel) + " · " + L.lab(m.label);
  const when = m => [m.t, L.at(m.c)].filter(Boolean);
  const nextText = () => {
    if (!next) return "";
    const op = next[next.ms === "a" ? "b" : "a"];
    return L.next + [roundName(next).toLowerCase(), when(next).join(", ")].filter(Boolean).join(" ") + (op ? L.vs + short(op) : "") + ".";
  };
  const outCopy = mp => {
    const names = L.names(mp);
    if (champ) return L.won(mp) + " " + cls + ". " + L.congrats;
    if (last && last.di !== 0) return L.fought(names);
    if (!lostMain) return L.over;
    if (lostMain.kind === "ko" && lostMain.r === R - 1) return L.silver(cls);
    if (lostMain.kind === "ko" && lostMain.r === R - 2) return L.semi;
    if (lostMain.kind === "ko" && lostMain.r === R - 3) return L.quarter;
    return L.fought(names);
  };

  const mine = [], covered = {};
  let others = [];
  matches.forEach(m => {
    const was = unpack(before[m.id]);
    if (!m.w || was.w) return;
    const wp = m[m.w], lp = m[m.w === "a" ? "b" : "a"], fin = m.kind === "ko" && m.r === m.R - 1, id = cid + ":m" + m.id;
    if (m.hasMe) {
      const mp = m[m.ms], op = m[m.ms === "a" ? "b" : "a"];
      const sc = (m.s ? (m.meWon ? m.s : flip(m.s)) : "") || L.note(m.note) || "";
      const title = m.di === 0 && fin && m.meWon ? L.cheer(L.won(mp) + " " + cls) :
        (m.meWon ? L.won(mp) : L.lost(mp)) + " " + L.def(m) + (sc ? " " + sc : "");
      let body = op ? L.Vs + short(op) + "." : "";
      if (m.meWon) body += nextText();
      else if (!next && m.kind === "ko") body += " " + outCopy(mp);
      if (m.meWon && next) covered[next.id] = true;
      mine.push({ id, title, body: body.trim(), mid: m.id });
    } else if (wp) {
      // Other results in the class are not pushed; how the next opponent got there goes into that notis.
      const res = m.s || L.note(m.note) || "";
      others.push({ id, wk: wp.id, how: lp ? (L.Won(wp) + " " + L.def(m) + " " + res + L.vs + short(lp)).replace(/\s+/g, " ").trim() : "" });
    }
  });
  // Next opponent just became known: one result, one notis (the deciding match is folded in).
  if (next) {
    const os = next.ms === "a" ? "b" : "a", op = next[os], was = unpack(before[next.id]);
    if (op && !was[os] && !covered[next.id]) {
      let how = "";
      others = others.filter(o => { if (o.wk !== op.id) return true; how = o.how; return false; });
      mine.push({ id: cid + ":opp:m" + next.id + ":" + op.id, title: L.meets(next[next.ms], op),
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
        title: (moved ? L.newTime : L.newCourt) + L.plays(next[next.ms]) + " " + L.def(next) + " " +
          [(otherDay ? L.dow(next.date) + " " : "") + next.t, L.court(next.c)].filter(Boolean).join(", "),
        body: (L.before + [(otherDay ? L.dow(od) + " " : "") + oldT, L.court(oc)].filter(x => x.trim()).join(", ") + "." + (op2 ? " " + L.Vs + short(op2) + "." : "")).trim() });
    }
  }
  // My group just finished: final placing (from RankedIn's standings, else wins and game difference).
  (matches.pools || []).forEach(pool => {
    const ms = matches.filter(m => m.kind === "rr" && m.di === pool.di);
    if (!ms.length || !ms.some(m => m.hasMe) || ms.some(m => !m.w) || ms.every(m => unpack(before[m.id]).w)) return;
    let rows = pool.rows.slice().sort((x, y) => (x.standing || 99) - (y.standing || 99));
    if (!rows.length || rows.reduce((a, r) => a + r.wins + r.losses, 0) !== 2 * ms.length) {   // standings missing or not updated yet
      const t = {};
      ms.forEach(m => ["a", "b"].forEach(sd => { if (!m[sd]) return; const r = t[m[sd].id] = t[m[sd].id] || { n: m[sd].n, wins: 0, losses: 0 }; if (m.w === sd) r.wins++; else r.losses++; }));
      rows = Object.values(t).sort((x, y) => y.wins - x.wins);
    }
    const mi = rows.findIndex(r => r.n.some(n => slug(n) === me));
    if (mi < 0) return;
    const place = rows[mi].standing || mi + 1;
    const lastMine = ms.filter(m => m.hasMe).sort(cmp).pop();
    mine.push({ id: cid + ":grupp:" + slug(pool.label), title: L.placed(rows[mi], place) + L.in + L.group(pool.label),
      body: rows.slice(0, 5).map((r, i) => (r.standing || i + 1) + ". " + short(r) + " " + r.wins + "–" + r.losses).join("\n"), mid: lastMine && lastMine.id });
  });
  // Only the player's own matches (and the next opponent) are pushed; other results in the class stay on the page.
  const out = [];
  mine.forEach(o => out.push({ title: o.title, body: o.body, tag: "padel-" + (o.tag || o.id), url: linkTo(ev.who, o.mid) }));
  return out;
}

// The draw of a class a club player plays was just published: one notis with the first match (or the group).
// ev: {who, me, classId, cls, name}. Same wording, tag and url as drawNote() in index.html; es: the Spanish wording.
export const drawNote = (ev, matches) => withEs(drawNoteIn(ev, matches, LANG.sv), drawNoteIn(ev, matches, LANG.es));
function drawNoteIn(ev, matches, L) {
  const me = slug(ev.me), isMe = p => !!p && p.n.some(n => slug(n) === me);
  const cmp = (x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0) || x.di - y.di || x.r - y.r;
  const mine = matches.filter(m => isMe(m.a) || isMe(m.b)).sort(cmp), open = mine.filter(m => !m.w), first = (open.length ? open : mine)[0];
  const tag = "padel-" + ev.classId + ":lottning", where = [ev.name, ev.cls].filter(Boolean).join(", ");
  if (!first) return { title: L.drawnIn + ev.cls, body: where ? where + "." : "", tag, url: linkTo(ev.who) };
  const ms = isMe(first.a) ? "a" : "b", mp = first[ms], op = first[ms === "a" ? "b" : "a"];
  const when = [[L.dow(first.date), first.t].filter(Boolean).join(" "), L.court(first.c)].filter(Boolean).join(", ");
  let title, body;
  if (first.kind === "rr") {
    const seen = {}, others = [];
    matches.filter(m => m.kind === "rr" && m.di === first.di).forEach(m => ["a", "b"].forEach(sd => {
      const p = m[sd];
      if (p && !isMe(p) && !seen[p.id]) { seen[p.id] = 1; others.push(short(p)); }
    }));
    title = L.drawn + L.names(mp) + L.in + L.group(first.label);
    body = (others.length ? L.with + others.join(", ") + ". " : "") + (when ? L.first + when + ". " : "") + where + (where ? "." : "");
  } else {
    title = L.drawn + (op ? L.meets(mp, op) : L.names(mp) + L.starts(mp, first.label));
    body = (when ? when.charAt(0).toUpperCase() + when.slice(1) + ". " : "") + where + (where ? "." : "");
  }
  return { title, body: body.trim(), tag, url: linkTo(ev.who, first.id) };
}

// Compact state of a class for the page's home view, kept in the class's KV record (so it costs no extra
// write): res = the latest finished matches with a club player, nx = each club player's next match (or that
// the day is over). roster: Map(slug(name) -> {pid, who}).
export function summary(matches, roster) {
  const pidsOf = p => p ? p.n.map(n => roster.get(slug(n))).filter(Boolean) : [];
  const cmp = (x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0) || x.di - y.di || x.r - y.r;
  const lab = m => m.kind === "rr" || m.di === 0 ? m.label : m.dlabel + " · " + m.label;
  const res = [], nx = {};
  matches.slice().sort(cmp).forEach(m => {
    const pa = pidsOf(m.a), pb = pidsOf(m.b);
    if (!pa.length && !pb.length) return;
    if (m.w) {
      const wp = m[m.w], lp = m[m.w === "a" ? "b" : "a"], won = m.w === "a" ? pa : pb;
      res.push({ mid: m.id, lab: lab(m), d: m.date || "", win: short(wp), lose: lp ? short(lp) : "", s: m.s || m.note || "",
        pids: pa.concat(pb).map(x => x.pid), won: won.map(x => x.pid), who: pa.concat(pb)[0].who });
      pa.concat(pb).forEach(x => { if (!nx[x.pid] || nx[x.pid].st === "done") nx[x.pid] = { st: "done", won: won.includes(x), lab: lab(m), who: x.who,
        champ: won.includes(x) && m.kind === "ko" && m.di === 0 && m.r === m.R - 1 }; });
    }
  });
  matches.filter(m => !m.w).sort(cmp).forEach(m => ["a", "b"].forEach(sd => pidsOf(m[sd]).forEach(x => {
    if (nx[x.pid] && nx[x.pid].st === "next") return;
    const op = m[sd === "a" ? "b" : "a"];
    nx[x.pid] = { st: "next", mid: m.id, lab: lab(m), d: m.date || "", t: m.t || "", c: courtName(m.c), opp: op ? short(op) : null, who: x.who };
  })));
  return { res: res.reverse().slice(0, 4), nx };
}

// Winner (and finalist) of a class once it is decided: the main draw's final, or for a groups-only class
// (fmt "groups", one group, every match played) the group winner. roster: Map(slug(name) -> {pid, who}).
// -> {d: "2026-09-27T17:45", s: winner-side score (group: wins–losses), win/lose: [names], w/l: [pids], opp/wopp: short names
//     of the losing/winning pair, rr: 1 for a group}
// w/l: roster players in the winning/losing pair. null while undecided.
export function classResult(matches, roster, fmt) {
  const pidsOf = n => (n || []).map(x => roster.get(slug(x))).filter(Boolean).map(x => x.pid);
  const last = matches.reduce((d, m) => (m.date || "") > d ? m.date : d, "").slice(0, 16);
  const fin = matches.find(m => m.kind === "ko" && m.di === 0 && m.r === m.R - 1);
  if (fin) {
    if (!fin.w || !fin.a || !fin.b) return null;
    const wp = fin[fin.w], lp = fin[fin.w === "a" ? "b" : "a"];
    return { d: String(fin.date || "").slice(0, 16) || last, s: fin.s || fin.note || "", win: wp.n, lose: lp.n, w: pidsOf(wp.n), l: pidsOf(lp.n), opp: short(lp), wopp: short(wp) };
  }
  const pools = matches.pools || [];
  if (fmt !== "groups" || pools.length !== 1 || !matches.length || matches.some(m => m.kind !== "rr" || !m.w)) return null;
  let rows = pools[0].rows.slice().sort((x, y) => (x.standing || 99) - (y.standing || 99));
  if (!rows.length || !rows[0].standing || rows.reduce((a, r) => a + r.wins + r.losses, 0) !== 2 * matches.length) {   // standings missing or stale
    const t = {};
    matches.forEach(m => ["a", "b"].forEach(sd => { if (!m[sd]) return; const r = t[m[sd].id] = t[m[sd].id] || { n: m[sd].n, wins: 0, losses: 0 }; if (m.w === sd) r.wins++; else r.losses++; }));
    rows = Object.values(t).sort((x, y) => y.wins - x.wins);
    if (rows.length > 1 && rows[0].wins === rows[1].wins) return null;   // tie on wins: leave it to RankedIn's standings
  }
  const top = rows[0];
  return top ? { d: last, s: top.wins + "–" + top.losses, win: top.n, lose: [], w: pidsOf(top.n), l: [], opp: "", wopp: short(top), rr: 1 } : null;
}
