// GET /ics?p=<pid>,<pid>: the players' coming tournaments, team league days and club series matches as an iCalendar
// feed (a phone subscribes to it and keeps it up to date). Times are local (Europe/Stockholm); a tournament with no
// match time yet is an all-day event over its days, its next match (from the live view) a timed one.
const esc = s => String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
const fold = l => { const out = []; let s = l; while (s.length > 74) { out.push(s.slice(0, 74)); s = " " + s.slice(74); } out.push(s); return out.join("\r\n"); };
const ymd = s => String(s || "").slice(0, 10).replace(/-/g, "");
const hms = s => { const m = /T?(\d\d):(\d\d)/.exec(String(s || "").slice(10)); return m ? m[1] + m[2] + "00" : null; };
const nextDay = d => { const x = new Date(String(d).slice(0, 10) + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const addMin = (d, t, min) => { const x = new Date(String(d).slice(0, 10) + "T" + t.slice(0, 2) + ":" + t.slice(2, 4) + ":00Z"); x.setUTCMinutes(x.getUTCMinutes() + min); return [x.toISOString().slice(0, 10).replace(/-/g, ""), x.toISOString().slice(11, 16).replace(":", "") + "00"]; };
const TZ = ["BEGIN:VTIMEZONE", "TZID:Europe/Stockholm", "BEGIN:STANDARD", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "END:STANDARD",
  "BEGIN:DAYLIGHT", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "END:DAYLIGHT", "END:VTIMEZONE"];

export function buildIcs({ events = [], bhs = null, live = {} } = {}, pids = [], t = new Date(), stamp = "") {
  const want = new Set(pids.map(Number)), out = [], seen = new Set(), today = t.toISOString().slice(0, 10);
  const ev = (uid, o) => {
    if (seen.has(uid)) return; seen.add(uid);
    const l = ["BEGIN:VEVENT", "UID:" + uid + "@padel.holmberg.st", "DTSTAMP:" + (stamp || t.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z")];
    if (o.time) { l.push("DTSTART;TZID=Europe/Stockholm:" + ymd(o.day) + "T" + o.time); const e = addMin(o.day, o.time, o.min || 90); l.push("DTEND;TZID=Europe/Stockholm:" + e[0] + "T" + e[1]); }
    else { l.push("DTSTART;VALUE=DATE:" + ymd(o.day)); l.push("DTEND;VALUE=DATE:" + ymd(nextDay(o.end || o.day))); }
    l.push("SUMMARY:" + esc(o.title));
    if (o.where) l.push("LOCATION:" + esc(o.where));
    if (o.text) l.push("DESCRIPTION:" + esc(o.text));
    if (o.url) l.push("URL:" + o.url);
    l.push("END:VEVENT");
    out.push(...l.map(fold));
  };
  const who = new Map();   // event -> the followed players in it (one entry per class/day)
  for (const e of events) {
    const ps = [e.pid].concat(e.pids || []).map(Number).filter(p => want.has(p));
    if (!ps.length) continue;
    const end = String(e.end || e.date || e.start || "").slice(0, 10) || String(e.windowTo || "").slice(0, 10);
    if (end && end < today) continue;
    const k = e.kind === "tournament" ? "t" + e.classId : e.kind === "teamleague" ? "l" + e.teamId + "-" + e.date : e.key;
    const w = who.get(k) || { e, names: new Set() };
    if (e.me) w.names.add(e.me.split(" ")[0]);
    if (e.partner && e.kind === "tournament") w.names.add(e.partner.split(" ")[0]);
    who.set(k, w);
  }
  for (const [k, { e, names }] of who) {
    const nm = [...names].join(" & ");
    if (e.kind === "tournament") {
      ev(k + "-" + ymd(e.start), { day: e.start, end: e.end || e.start, title: e.name + " · " + e.cls + (nm ? " (" + nm + ")" : ""), where: [e.venue, e.address].filter(Boolean).join(", "), url: e.url, text: e.cls + (e.partner ? " med " + e.partner : "") });
      const x = live && live[e.pid];   // the next match of the class, when its time is known
      if (x && x.st === "next" && x.d && x.t && String(x.key).indexOf("t" + e.classId + "-") === 0) {
        ev(k + "-m-" + ymd(x.d) + (hms(x.d) || ""), { day: x.d, time: hms(x.d), min: 90, title: (e.me || "").split(" ")[0] + ": " + (x.lab || "match") + (x.opp ? " mot " + x.opp : ""), where: x.c || e.venue || "", url: e.url, text: e.name + " · " + e.cls });
      }
    } else if (e.kind === "teamleague") {
      const tie = (e.ties || [])[0] || {}, tm = /^\d\d:\d\d/.test(tie.time || "") ? tie.time.replace(":", "") + "00" : null;
      ev(k, { day: e.date, time: tm, min: 240, title: e.name + " · " + e.team + ((e.ties || []).length ? " mot " + e.ties.map(x => x.opp).join(" och ") : ""), where: tie.venue || "", url: e.url, text: [e.division, e.round ? "Omgång " + e.round : ""].filter(Boolean).join(" · ") });
    }
  }
  for (const g of (bhs && bhs.groups) || []) for (const x of g.next || []) {
    if (!(x.pids || []).some(p => want.has(Number(p)))) continue;
    const d = String(x.d || ""), tm = hms(d.replace(" ", "T"));
    if (d.slice(0, 10) < today || !tm) continue;
    ev("s" + g.id + "-" + ymd(d) + tm + "-" + (x.a + x.b).replace(/[^A-Za-z]/g, "").slice(0, 24), { day: d.slice(0, 10), time: tm, min: x.min || 90, title: g.series + " · " + x.a + " – " + x.b, where: x.c ? "Bana " + x.c : "", url: g.url, text: g.name });
  }
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//padel.holmberg.st//Nynas Padel//SV", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Nynäs Padel", "X-WR-TIMEZONE:Europe/Stockholm", "REFRESH-INTERVAL;VALUE=DURATION:PT2H", "X-PUBLISHED-TTL:PT2H"]
    .concat(TZ, out, ["END:VCALENDAR"]).join("\r\n") + "\r\n";
}
