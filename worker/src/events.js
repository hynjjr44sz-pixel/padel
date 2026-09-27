// Tävlingar som bevakas. Lägg till en rad per klass (se README.md).
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

export function activeEvents(now, list = EVENTS) {
  return list.filter(e => now >= new Date(e.activeFrom) && now <= new Date(e.activeTo));
}
