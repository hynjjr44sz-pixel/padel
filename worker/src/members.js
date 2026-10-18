// Nynäs Padel Club's members on RankedIn (GetMembersAsync), beside the hand-made roster (players.json). Kept in KV
// "members" {at, list: [{pid, rin, name, age, gender, vis, ck}]}: refreshed once a day, each member looked up once a
// month (profile: age; the SPF ranking lists: gender, which gives the ranking list and the skill rating).
// Who is shown (opt-in / opt-out): 18 and over unless they said no (vis "out"); under 18 only after a yes (vis "in":
// the admin, or an approved "Begär konto"). A member not shown is not looked at at all (no discovery, no pushes).
import { PLAYERS, BY_PID } from "./discover.js";
export const CLUB_ID = 9136;
const DAY = 864e5, CHECK_DAYS = 30, PER_RUN = 6;
const SPF = 1917, LISTS = { F: { rt: 4, ag: 83, rid: 65 }, M: { rt: 3, ag: 82, rid: 64 } };
const slug = n => String(n).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const cap = s => String(s || "").trim().replace(/\s+/g, " ").replace(/(^|[\s-])(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());

export const visible = m => m.vis === "in" || (m.vis !== "out" && typeof m.age === "number" && m.age >= 18);

let MEM = { at: 0, rec: null };
export async function loadMembers(env, fresh) {
  if (!fresh && MEM.rec && Date.now() - MEM.at < 5 * 60e3) return MEM.rec;
  let rec = null;
  try { rec = JSON.parse((await env.PUSH.get("members")) || "null"); } catch (e) { rec = null; }
  MEM = { at: Date.now(), rec: rec || { at: null, list: [] } };
  applyMembers(MEM.rec);
  return MEM.rec;
}
export function _resetMembers() { MEM = { at: 0, rec: null }; }
async function save(env, rec) {
  await env.PUSH.put("members", JSON.stringify(rec));
  MEM = { at: Date.now(), rec };
  applyMembers(rec);
}

// The members shown join the players everything else works on (PLAYERS, BY_PID): the roster's own entries stay as
// they are; a member who is no longer shown (said no, left the club) is taken out again.
const ADDED = new Set();
export function applyMembers(rec) {
  const want = new Map();
  const keys = new Set(PLAYERS.filter(p => !ADDED.has(p.pid)).map(p => p.who));
  for (const m of (rec && rec.list) || []) {
    if (!visible(m) || (BY_PID.has(m.pid) && !ADDED.has(m.pid))) continue;
    let who = slug(m.name) || "p" + m.pid;
    while (keys.has(who)) who += "-" + String(m.pid).slice(-3);
    keys.add(who);
    const L = LISTS[m.gender] || {};
    want.set(m.pid, { who, pid: m.pid, me: m.name, name: m.name.split(" ")[0], gender: m.gender || null, rt: L.rt, ag: L.ag, rid: L.rid || null,
      team: null, teamId: null, league: null, division: null, rin: m.rin || null, member: true, age: m.age });
  }
  for (const pid of [...ADDED]) if (!want.has(pid)) {
    ADDED.delete(pid); BY_PID.delete(pid);
    const i = PLAYERS.findIndex(p => p.pid === pid);
    if (i >= 0) PLAYERS.splice(i, 1);
  }
  for (const [pid, p] of want) {
    if (ADDED.has(pid)) { Object.assign(BY_PID.get(pid), p); continue; }
    ADDED.add(pid); PLAYERS.push(p); BY_PID.set(pid, p);
  }
}
// For the page (GET /events "members"): the members shown, as roster rows
export function membersOut() {
  return PLAYERS.filter(p => ADDED.has(p.pid)).map(p => ({ key: p.who, pid: p.pid, name: p.me, short: p.name, gender: p.gender, rankedinId: p.rin, member: 1, age: p.age }));
}

// Once a day the list; then up to PER_RUN members looked up (profile, then the women's and men's lists by full name)
export function membersDue(rec, t) {
  if (!rec || !rec.at || +t - Date.parse(rec.at) > DAY) return true;
  return rec.list.some(m => !m.ck || +t - m.ck > CHECK_DAYS * DAY);
}
export async function membersRun(env, get, t, budget) {
  const rec = await loadMembers(env, true);
  let changed = false;
  if (!rec.at || +t - Date.parse(rec.at) > DAY) {
    const d = await get("/Organization/GetMembersAsync?id=" + CLUB_ID + "&language=en");
    const rows = (Array.isArray(d) ? d : []).flatMap(g => (g && g.participants) || []);
    if (rows.length) {
      const old = new Map(rec.list.map(m => [m.pid, m]));
      rec.list = rows.map(r => {
        const pid = Number(r.playerId), o = old.get(pid) || {};
        return { ...o, pid, rin: r.playerRankedinId || o.rin || null, name: cap((r.playerFirstName || "") + " " + (r.playerLastName || "")) };
      }).filter(m => m.pid && m.name);
      rec.at = t.toISOString();
      changed = true;
    }
  }
  const todo = rec.list.filter(m => !m.ck || +t - m.ck > CHECK_DAYS * DAY).slice(0, PER_RUN);
  for (const m of todo) {
    if (BY_PID.has(m.pid) && !ADDED.has(m.pid)) { m.ck = +t; changed = true; continue; }   // in players.json: nothing to look up
    if (budget.left < 4) break;
    try {
      if (m.rin) {
        const pr = await get("/player/playerprofileinfoasync?rankedinId=" + encodeURIComponent(m.rin) + "&language=en");
        const a = Number(pr && pr.Header && pr.Header.Age);
        m.age = a > 0 && a < 110 ? a : null;
      }
      let g = null;
      for (const k of ["F", "M"]) {
        const L = LISTS[k], day = t.toISOString().slice(0, 10);
        const r = await get("/Ranking/SearchRankingPlayersAsync?rankingId=" + SPF + "&rankingType=" + L.rt + "&ageGroup=" + L.ag + "&weekFromNow=0&language=en&searchTerm=" +
          encodeURIComponent(m.name) + "&skip=0&take=50&rankingDate=" + day);
        if (((r && r.Payload) || []).some(x => x && x.Participant && Number(x.Participant.NewParticipantId) === m.pid)) { g = k; break; }
      }
      m.gender = g || m.gender || null;
      m.ck = +t;
      changed = true;
    } catch (e) { if (e.budget) break; }
  }
  if (changed) await save(env, rec);
  return { members: rec.list.length, shown: rec.list.filter(visible).length, checked: todo.length };
}
// Admin, "Begär konto", a member's own choice: vis "in" | "out" | null (by age again)
export async function setVisibility(env, pid, vis) {
  const rec = await loadMembers(env, true), m = rec.list.find(x => x.pid === Number(pid));
  if (!m) return false;
  if (vis === "in" || vis === "out") m.vis = vis; else delete m.vis;
  await save(env, rec);
  return true;
}
export const isMember = pid => ADDED.has(Number(pid));
