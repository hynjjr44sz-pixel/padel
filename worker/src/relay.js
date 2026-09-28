// Live relay: the cron tick already fetches every live class draw and SPL tie from RankedIn. It keeps the data the
// page reads (the same pruned draw JSON index.html builds its model from, and the raw rubbers of a tie) in ONE KV key,
// "live", written at most once per tick and only when something changed. GET /live?ids=164681,tm167486 serves it:
// the open apps poll the worker instead of RankedIn (few KV reads: one per isolate every LIVE_MEM_MS).
//
// KV "live" = {v, at, items: {id: {v, at, dr?, p?, d}}, sk: {pid: {t, r: {64: x, 65: y, 66: z}}}}
//   id: "<classId>" or "tm<tieId>"; d: the data as JSON text (tournament: [stage response, ...] pruned; tie: the
//   rubbers response); dr: the draws [[stage, strength], ...]; p: player ids in the draw (for sk).
//   sk: SPF skills of players in live draws (GetPlayerRatingAsync, refreshed every SK_AGE by the tick).

// The fields the page's draw model reads (index.html KEEP, checked by a test): everything else is dropped.
export const KEEP = new Set(("Elimination RoundRobin BaseType RatingId PlacesStartPos PlacesEndPos Width Height DrawData Round MatchOrder MaxRound MatchId Date CourtName " +
  "WinnerParticipantId ChallengerParticipant ChallengedParticipant EventParticipantId Seed FirstPlayer SecondPlayer Id Name RatingBegin " +
  "MatchViewModel CancellationStatus HasCancellation Score DetailedScoring FirstParticipantScore SecondParticipantScore LoserTiebreak " +
  "TournamentClassId Pool ParticipantCell Players MatchCell Court MatchResults HasScore IsFirstParticipantWinner Standings " +
  "DoublesPlayer1Model DoublesPlayer2Model Standing Wins Losses Played GamesDifference").split(" "));
export function prune(x) {
  if (Array.isArray(x)) return x.map(prune);
  if (!x || typeof x !== "object") return x;
  const o = {};
  for (const k in x) if (KEEP.has(k)) o[k] = prune(x[k]);
  return o;
}
// Short content hash (FNV-1a, 2 x 32 bit): cheap on CPU, only used to see changes.
export function hash(s) {
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
// Player ids in a pruned draw (the pairs' players, as the page's pairOf reads them).
export function playersOf(data) {
  const out = new Set();
  const add = x => { if (x && typeof x.Id === "number" && x.Id > 0 && x.Name && !/^(pending|bye)$/i.test(String(x.Name).trim())) out.add(x.Id); };
  (function walk(x, key) {
    if (Array.isArray(x)) { x.forEach(y => walk(y, key)); return; }
    if (!x || typeof x !== "object") return;
    if (key === "FirstPlayer" || key === "SecondPlayer" || key === "Players") add(x);
    for (const k in x) walk(x[k], k);
  })(data, "");
  return [...out].sort((a, b) => a - b);
}

export const LIVE_KEEP_MS = 36 * 3600e3;   // an item not refreshed for 36 h (event over) leaves the record
export const SK_AGE = 3 * 3600e3;          // skills: refetched after 3 h
export const LIVE_MEM_MS = 25e3;           // GET /live: one KV read per isolate per 25 s
export const LIVE_CALM_MS = 3 * 60e3;      // a change that is no result / time / court (e.g. a live score): written after 3 min
export const LIVE_MAX_WRITES = 400;        // KV writes of "live" per day (Stockholm); at the cap the relay empties (the page asks RankedIn)

export function parseLive(raw) {
  let x = null;
  try { x = JSON.parse(raw || "null"); } catch (e) { x = null; }
  return x && x.items && typeof x.items === "object" ? { v: x.v || "", at: x.at || null, items: x.items, sk: x.sk || {}, wd: x.wd || null, wn: x.wn || 0 } : { v: "", at: null, items: {}, sk: {}, wd: null, wn: 0 };
}
// The tick's changes -> the next record, or null when nothing changed (no KV write).
// updates: {id: {data, dr?}}; skills: {pid: {64: x, ...}} fetched this tick; keep: ids still in the event list.
export function nextLive(prev, updates, skills, t, keep) {
  const at = t.toISOString(), items = { ...prev.items }, sk = { ...prev.sk };
  let changed = false;
  for (const id of Object.keys(updates)) {
    const u = updates[id], d = JSON.stringify(u.data), was = items[id];
    if (was && was.d === d && (was.h || 0) === (u.h || 0) && JSON.stringify(was.dr || null) === JSON.stringify(u.dr || null)) continue;   // string compare: no hash per poll
    const it = { v: hash(d + (u.h ? "|h" : "")), at, d };
    if (u.h) it.h = 1;
    if (u.dr) it.dr = u.dr;
    if (u.p && u.p.length) it.p = u.p;
    items[id] = it; changed = true;
  }
  // Skills are only fetched when due (skillsDue), so the new time is always kept (else the next tick fetches them again).
  for (const pid of Object.keys(skills)) { sk[pid] = { t: +t, r: skills[pid] }; changed = true; }
  for (const id of Object.keys(items)) {
    if ((keep && !keep.has(id) && +t - Date.parse(items[id].at) > 2 * 3600e3) || +t - Date.parse(items[id].at) > LIVE_KEEP_MS) { delete items[id]; changed = true; }
  }
  const wanted = new Set();
  Object.values(items).forEach(it => (it.p || []).forEach(p => wanted.add(String(p))));
  for (const pid of Object.keys(sk)) if (!wanted.has(pid)) { delete sk[pid]; changed = true; }
  if (!changed) return null;
  const v = hash(Object.keys(items).sort().map(k => k + ":" + items[k].v).join(",") + "|" + JSON.stringify(sk));
  return { v, at, items, sk };
}
// Players of the live draws whose skill is missing or older than SK_AGE, oldest first.
export function skillsDue(rec, t, n) {
  const all = new Set();
  Object.values(rec.items).forEach(it => (it.p || []).forEach(p => all.add(p)));
  return [...all].filter(p => !rec.sk[p] || +t - rec.sk[p].t >= SK_AGE)
    .sort((a, b) => ((rec.sk[a] && rec.sk[a].t) || 0) - ((rec.sk[b] && rec.sk[b].t) || 0) || a - b).slice(0, n);
}
// GetPlayerRatingAsync -> {64: x, 65: y, 66: z} (doubles ratings only)
export function ratingsOf(list) {
  const r = {};
  (Array.isArray(list) ? list : []).forEach(x => { if (x && [64, 65, 66].includes(x.RatingId) && typeof x.RatingValue === "number") r[x.RatingId] = x.RatingValue; });
  return r;
}

// GET /live body for some ids: {v, at, every, items: {id: {v, at, dr?, data}}, sk: {pid: {rid: value}}}. every: seconds
// until the page's next poll (60 while a match of these is on or soon, else 300). Built as a string:
// the stored data is spliced in as it is (no parse / stringify of the draws per request).
export const ID_RE = /^(tm)?\d{1,10}$/;
export function liveBody(rec, ids) {
  const parts = [], sk = {}, vs = [];
  let every = 300;
  for (const id of ids) {
    const it = rec.items[id];
    vs.push(id + ":" + (it ? it.v : "-"));
    if (!it || it.h) every = 60;
    if (!it) continue;
    parts.push(JSON.stringify(id) + ":{\"v\":" + JSON.stringify(it.v) + ",\"at\":" + JSON.stringify(it.at) + (it.dr ? ",\"dr\":" + JSON.stringify(it.dr) : "") + ",\"data\":" + it.d + "}");
    (it.p || []).forEach(p => { if (rec.sk[p]) sk[p] = rec.sk[p].r; });
  }
  const sks = JSON.stringify(sk), v = hash(vs.join(",") + "|" + sks);
  return { v, body: "{\"v\":" + JSON.stringify(v) + ",\"at\":" + JSON.stringify(rec.at) + ",\"every\":" + every + ",\"items\":{" + parts.join(",") + "},\"sk\":" + sks + "}" };
}
