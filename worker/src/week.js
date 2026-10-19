// "Veckan i klubben": the week that went (Monday to Sunday before `t`) and the week ahead, from what the worker already
// keeps: wins (place 1/2), the club board (places gained on this week's SPF list), the series results and the coming
// tournaments. Served in GET /events ("week") and sent as one notis on Monday morning.
const DAY = 864e5;
const first = n => String(n || "").split(" ")[0];
const sw = n => String(n || "").split(/\s+/).slice(-1)[0];
export function weekDigest({ wins = [], board = {}, bhs = null, events = [], players = [] } = {}, t = new Date(), offsetH = 2) {
  const loc = new Date(+t + offsetH * 3600e3), dow = (loc.getUTCDay() + 6) % 7;   // 0 = Monday
  const mon = new Date(Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate()) - dow * DAY);
  const from = new Date(+mon - 7 * DAY).toISOString().slice(0, 10), to = new Date(+mon - DAY).toISOString().slice(0, 10), next = new Date(+mon + 6 * DAY).toISOString().slice(0, 10);
  const today = mon.toISOString().slice(0, 10), byPid = new Map(players.map(p => [Number(p.pid), p]));
  const nm = pid => { const p = byPid.get(Number(pid)); return p ? p.short || first(p.name) : null; };
  const pairName = w => { const n = (w.pids || []).map(nm).filter(Boolean); return n.length ? n.join(" & ") : (w.pair || []).map(sw).join(" & "); };
  const inWeek = d => d >= from && d <= to;
  const won = wins.filter(w => (w.place || 1) === 1 && inWeek(String(w.date || ""))).map(w => ({ who: pairName(w), cls: w.cls || "", name: w.name || "" }));
  const fin = wins.filter(w => w.place === 2 && inWeek(String(w.date || ""))).map(w => ({ who: pairName(w), cls: w.cls || "", name: w.name || "" }));
  // climbers on the newest list (dated this week's Monday or the Sunday before)
  const climb = Object.keys(board).map(pid => ({ pid, b: board[pid] })).filter(x => x.b && x.b.up > 0 && String(x.b.rd || "") >= to)
    .sort((a, b) => b.b.up - a.b.up).slice(0, 3).map(x => ({ who: nm(x.pid), up: x.b.up, rk: x.b.rk })).filter(x => x.who);
  // the club's series results: wins and losses of the club's side (club against club counts neither)
  const key = n => (first(n) + " " + sw(n)).toLowerCase(), club = new Set(players.map(p => key(p.name)));
  const hasClub = side => String(side || "").split(" / ").some(n => club.has(key(n.trim())));
  let sw_ = 0, sl = 0;
  ((bhs && bhs.groups) || []).forEach(g => (g.res || []).forEach(r => {
    if (!inWeek(String(r.d || "").slice(0, 10))) return;
    const ca = hasClub(r.a), cb = hasClub(r.b);
    if (ca === cb) return;
    const d = String(r.s || "").split(/\s+/).map(x => /^(\d+)-(\d+)$/.exec(x)).filter(Boolean).reduce((s, m) => s + (+m[1] > +m[2] ? 1 : +m[2] > +m[1] ? -1 : 0), 0);
    if (!d) return;
    if ((d > 0) === ca) sw_++; else sl++;
  }));
  // the week ahead: tournaments starting Monday to Sunday with club players
  const ahead = {}, aheadP = new Set();
  events.forEach(e => {
    if (e.kind !== "tournament") return;
    const d = String(e.start || "").slice(0, 10);
    if (d < today || d > next) return;
    const k = e.tournamentId || e.name, x = ahead[k] = ahead[k] || { name: e.name, d, n: new Set() };
    x.n.add(Number(e.pid)); aheadP.add(Number(e.pid));
  });
  const coming = Object.values(ahead).sort((a, b) => a.d.localeCompare(b.d)).map(x => ({ name: x.name, d: x.d, n: x.n.size }));
  return { from, to, won, fin, climb, series: { w: sw_, l: sl }, coming, players: aheadP.size };
}
// The Monday notis: a few short lines, or null when the week had nothing to tell.
export function weekNote(w, lang = "sv") {
  const es = lang === "es", lines = [];
  if (w.won.length) lines.push((es ? "Ganaron: " : "Vann: ") + w.won.map(x => x.who + " (" + x.cls + ")").join(", "));
  if (w.fin.length) lines.push((es ? "Final: " : "Final: ") + w.fin.map(x => x.who + " (" + x.cls + ")").join(", "));
  if (w.climb.length) lines.push((es ? "Subieron: " : "Klättrade: ") + w.climb.map(x => x.who + " +" + x.up).join(", "));
  if (w.series.w + w.series.l) lines.push((es ? "Liga del club: " : "Klubbserien: ") + w.series.w + (es ? (w.series.w === 1 ? " victoria, " : " victorias, ") : (w.series.w === 1 ? " vinst, " : " vinster, ")) + w.series.l + (es ? (w.series.l === 1 ? " derrota" : " derrotas") : (w.series.l === 1 ? " förlust" : " förluster")));
  if (w.coming.length) lines.push((es ? "Esta semana: " : "Den här veckan: ") + w.coming.map(x => x.name + " (" + x.n + ")").join(", "));
  if (!lines.length) return null;
  return { title: es ? "La semana en el club" : "Veckan i klubben", body: lines.join("\n"), tag: "padel-veckan", url: "./#/" };
}
