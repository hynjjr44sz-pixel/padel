// Sista anmälan: the evening two days before a suggested tournament's sign-up closes (18:22 local), one notis per
// followed player and tournament: a class the player may enter (calendar.js suggestFor: SPF caps, own gender, not
// entered yet). At most two per player a night; `sent` keeps "tid:pid" so a reminder goes out once.
import { suggestFor } from "./calendar.js";
import { localToDate } from "./tz.js";
const DOW = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"], DOW_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MON = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"], MON_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export function remindNotes(cal, players, board, taken, t, sent = []) {
  if (!cal || !cal.events) return [];
  const done = new Set(sent), out = [], soon = +t + 54 * 3600e3;
  for (const p of players) {
    const b = board[p.pid] || {}, me = { pid: p.pid, gender: p.gender, pts: b.rp != null ? b.rp : null, rank: b.rk != null ? b.rk : null };
    let n = 0;
    for (const s of suggestFor(cal, me, t, taken[p.pid] || [], 12)) {
      const e = cal.events.find(x => x.id === s.id), c = e && localToDate(e.closes);
      if (!c || +c <= +t || +c > soon || done.has(e.id + ":" + p.pid) || n >= 2) continue;
      const cls = e.classes.filter(x => s.classes.includes(x.id)), day = String(e.closes).slice(0, 10), wd = new Date(day + "T12:00:00Z").getUTCDay();
      const dd = +day.slice(8, 10), mm = +day.slice(5, 7) - 1, mates = (s.mates || []).length;
      const what = cls.map(x => x.name + " (" + x.players + " par)").join(", "), whatEs = cls.map(x => x.name + " (" + x.players + " parejas)").join(", ");
      out.push({ k: e.id + ":" + p.pid, pids: [p.pid], m: {
        title: "Sista anmälan " + DOW[wd] + " " + dd + " " + MON[mm] + ": " + e.name,
        body: p.name + " kan spela " + what + ". " + [e.club, e.city].filter(Boolean).join(", ") + (mates ? " · " + mates + " från klubben anmälda" : ""),
        tag: "padel-anmalan-" + e.id, url: "./#" + p.who,
        es: { title: "Inscripción hasta el " + DOW_ES[wd] + " " + dd + " " + MON_ES[mm] + ": " + e.name, body: p.name + " puede jugar " + whatEs + ". " + [e.club, e.city].filter(Boolean).join(", ") } } });
      n++;
    }
  }
  return out;
}
