// Fallback list, merged with what discover.js finds on RankedIn (discovered entries win, same classId + who).
// activeFrom/activeTo: svensk tid med offset (+02:00 sommartid, +01:00 vintertid).
// Utanför fönstret gör workern ingenting (inga anrop, inga KV-läsningar).
export const EVENTS = [
  {
    who: "thea", me: "Thea Holmberg Löving", cls: "Damer C",
    tournamentId: 66374, classId: 164681,
    activeFrom: "2026-09-27T08:00:00+02:00", activeTo: "2026-09-27T22:00:00+02:00"
  },
  {
    who: "thea", me: "Thea Holmberg Löving", cls: "Dam B",
    tournamentId: 73554, classId: 173729, stages: [0, 1],   // 5 par: troligen gruppspel (0) + slutspel (1)
    activeFrom: "2026-10-09T16:00:00+02:00", activeTo: "2026-10-11T23:00:00+02:00"
  }
];
const PID = { thea: 1675246, kian: 1680004 };

// Static/legacy entry -> the event shape discover.js produces.
export function normalize(e) {
  if (e.kind && e.windowFrom) return e;
  return {
    key: "t" + e.classId + "-" + e.who, kind: "tournament", who: e.who, me: e.me, pid: e.pid || PID[e.who] || null,
    id: e.tournamentId || null, tournamentId: e.tournamentId || null, classId: e.classId, cls: e.cls, name: e.name || null,
    url: e.tournamentId ? "https://www.rankedin.com/en/tournament/" + e.tournamentId : null,
    draws: (e.stages || [0]).map(s => [s, 0]), format: e.format || null, static: true,
    windowFrom: e.activeFrom, windowTo: e.activeTo, cover: [String(e.classId)]
  };
}
export function merge(discovered, statics = EVENTS) {
  const out = (discovered || []).slice();
  statics.map(normalize).forEach(s => {
    const i = out.findIndex(x => x.kind === "tournament" && x.classId === s.classId && x.who === s.who);
    if (i < 0) out.push(s);
    else if (!out[i].draws && s.draws) out[i] = { ...out[i], draws: s.draws };   // stages known before RankedIn publishes the draw
  });
  return out.sort((a, b) => String(a.windowFrom).localeCompare(String(b.windowFrom)));
}
export function activeEvents(now, list = EVENTS) {
  return list.filter(e => now >= new Date(e.windowFrom || e.activeFrom) && now <= new Date(e.windowTo || e.activeTo));
}
