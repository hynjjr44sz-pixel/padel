// Backhandsmash (MATCHi's club leagues): Nynäshamn Padelcenter's series. The tables and results are public fragments
// (/public/tables/group/<id>, /results/bygroup) even though the pages around them ask for a login, so no account is used.
// Once a night: the league pages give the groups, each group's table, and the results of the groups a club player is in.
// Kept: only the groups with a club player (matched on first + last name), so a player page shows just their own series.

import { PLAYERS } from "./discover.js";

export const BHS = "https://backhandsmash.com", BHS_CLUB = "nynashamnpc";
export const BHS_LEAGUES = { open: "Seriespel", mix: "Mixedserie", noteam: "Americanoserie" };

const ent = s => String(s).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
const text = s => ent(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const fold = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/);

// Club players by first + last name ("Thea Löving" is Thea Holmberg Löving)
function matcher(players) {
  const by = {};
  players.forEach(p => { const f = fold(p.me); by[f[0] + " " + f[f.length - 1]] = p.pid; });
  return name => String(name).split("/").map(n => { const f = fold(n); return f.length > 1 ? by[f[0] + " " + f[f.length - 1]] : null; }).filter(Boolean);
}

// League page -> {site (schedule id), groups: [[id, name]]}
export function parseLeague(html) {
  const lt = /loadLeagueTables\('([\d,]+)',\s*(\d+)/.exec(html) || [], ids = lt[1];
  const names = {};
  for (const m of html.matchAll(/loadGroupTable\((\d+),\s*'([^']+)'/g)) names[m[1]] = ent(m[2]);
  return { site: lt[2] ? +lt[2] : null, groups: (ids ? ids.split(",") : Object.keys(names)).map(id => [id, names[id] || ""]) };
}

// Table fragment -> rows [{pos, n, m, w, t, l, g, d, p}] (the first table: plain points, not "by average")
export function parseTable(html) {
  const tb = (/<table[\s\S]*?<\/table>/i.exec(html) || [""])[0];
  const raw = [...tb.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => c[1]));
  const rows = raw.map(r => r.map(text));
  if (!rows.length) return [];
  const hd = rows[0], col = k => hd.indexOf(k), name = col("Name"), last = hd.length - 1;
  const played = col("M") >= 0 ? col("M") : col("P");   // pairs: M (P = points, last); singles: P, then "Points"
  const num = v => { const x = parseFloat(String(v).replace(",", ".")); return isNaN(x) ? 0 : x; };
  return rows.slice(1).map((r, i) => [r, raw[i + 1]]).filter(x => x[0].length === hd.length && x[0][name]).map(([r, h]) => ({
    id: +((/loadPlayer\((\d+)/.exec(h[name]) || [])[1] || 0), pos: parseInt(r[0], 10) || 0, n: r[name].replace(/\s*\/\s*/g, " / "), m: num(r[played]), w: num(r[col("W")]), t: num(r[col("T")]), l: num(r[col("L")]),
    g: r[col("Game") >= 0 ? col("Game") : col("G")] || "", d: num(r[col("+/-")]), p: num(r[last])
  }));
}

// Results fragment -> [{a, b, s, d}] newest first (score from a's side)
export function parseResults(html) {
  const out = [];
  for (const m of html.matchAll(/vertical-timeline-content">([\s\S]*?)<\/small>/gi)) {
    const h2 = text((/<h2>([\s\S]*?)<\/h2>/i.exec(m[1]) || [])[1] || ""), s = text((/<p>([\s\S]*?)<\/p>/i.exec(m[1]) || [])[1] || "");
    const d = (/(\d{4}-\d\d-\d\d)\s*$/.exec(text(m[1])) || [])[1] || "", i = h2.indexOf(" - ");
    if (i > 0 && /\d-\d/.test(s)) out.push({ a: h2.slice(0, i).replace(/\s*\/\s*/g, " / "), b: h2.slice(i + 3).replace(/\s*\/\s*/g, " / "), s, d });
  }
  return out;
}

// Schedule page (logged in) -> coming matches [{d "2026-09-30 20:00", min, c court, g group, a, b}]
export function parseSchedule(html) {
  const out = [];
  for (const m of html.matchAll(/<tr data-passed="False"([\s\S]*?)<\/tr>/gi)) {
    const g = ent((/data-group="([^"]*)"/.exec(m[1]) || [])[1] || ""), who = ent((/data-match="([^"]*)"/.exec(m[1]) || [])[1] || "");
    const td = [...m[1].matchAll(/<td>([\s\S]*?)<\/td>/gi)].map(c => text(c[1]));
    const when = /(\d{4}-\d\d-\d\d) (\d\d:\d\d)(?: \((\d+) m\))?/.exec(td[1] || ""), i = who.indexOf(",");
    if (!g || !when || i < 0) continue;   // bookings without a match ("MATCHi bokningssystem")
    const court = /^(\d+)/.exec(td[3] || "");
    out.push({ d: when[1] + " " + when[2], min: +(when[3] || 90), c: court ? court[1] : (td[3] || ""), g, a: who.slice(0, i).replace(/\s+/g, " ").replace(/\s*\/\s*/g, " / ").trim(), b: who.slice(i + 1).replace(/\s+/g, " ").replace(/\s*\/\s*/g, " / ").trim() });
  }
  return out;
}

async function page(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (padel.holmberg.st nightly)", "Accept": "text/html" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("Backhandsmash HTTP " + res.status);
  return res.text();
}

// -> {groups: [...]} with only the groups a club player is in; with the captain's login (env.BHS_USER) also each group's
// coming matches of club players (next). budget: the invocation's subrequests (the login takes up to 10).
export async function fetchBhs(budget, players = PLAYERS, env = {}) {
  const who = matcher(players), groups = [], sites = {};
  const take = n => { if (budget.left < (n || 1)) throw new Error("subrequest budget"); budget.left -= n || 1; };
  for (const lg of Object.keys(BHS_LEAGUES)) {
    take();
    const L = parseLeague(await page(BHS + "/clubs/" + BHS_CLUB + "/" + lg + "/tables"));
    sites[lg] = L.site;
    for (const [id, name] of L.groups) {
      take();
      const rows = parseTable(await page(BHS + "/public/tables/group/" + id + "?groupId=" + id + "&mobile=false&lang=sv&isList=true"));
      rows.forEach(r => { r.pids = who(r.n); });
      const pids = [...new Set(rows.flatMap(r => r.pids))];
      if (!pids.length) continue;
      take();
      const res = parseResults(await page(BHS + "/results/bygroup?id=" + id + "&name=" + encodeURIComponent(name) + "&mobile=false&lang=sv"))
        .map(r => ({ ...r, pids: who(r.a).concat(who(r.b)) })).filter(r => r.pids.length).slice(0, 40);
      groups.push({ id: +id, lg, site: L.site, series: BHS_LEAGUES[lg], name, url: BHS + "/clubs/" + BHS_CLUB + "/" + lg + "/tables/" + encodeURIComponent(name), single: !rows.some(r => / \/ /.test(r.n)), rows, res, pids, next: [] });
    }
  }
  let err = null;
  if (env.BHS_USER && env.BHS_PASS && groups.length) try {
    take(10);
    const s2 = await bhsLogin(env);
    for (const lg of [...new Set(groups.map(g => g.lg))]) {
      if (!sites[lg]) continue;
      take();
      const r = await s2.get("/schedule?siteId=" + sites[lg] + "&mobile=false&lang=sv");
      parseSchedule(r.html).forEach(x => {
        const g = groups.find(y => y.lg === lg && y.name === x.g), pids = g ? who(x.a).concat(who(x.b)) : [];
        if (g && pids.length && g.next.length < 8) g.next.push({ ...x, pids });
      });
    }
  } catch (e) { err = e.message; }   // no schedule (login refused, site changed): the tables and results still count
  return { groups, err };
}

// Round history of a team or player (/public/members/<id>/roundhistorydata, Google chart JSON) -> [[round "2026:4", group, position]]
export function parseHistory(json) {
  let d = null;
  try { d = typeof json === "string" ? JSON.parse(json) : json; } catch (e) { return []; }
  return ((d && d.rows) || []).map(r => { const c = r.c || []; return [String((c[0] || {}).f || ""), +((c[1] || {}).v || 0), +((c[2] || {}).v || 0)]; }).filter(x => x[0] && x[1] && x[2]);
}
// League ranking (/public/stats/leagues/<site>/ranking/0) -> {n, at, rows: [{rank, name, avg, pids}]} for the club's players
export function parseRanking(json, who) {
  let d = null;
  try { d = typeof json === "string" ? JSON.parse(json) : json; } catch (e) { return null; }
  const rows = (d && d.TableData && d.TableData.Rows) || [];
  return { n: rows.length, at: (/(\d{4}-\d\d-\d\d)/.exec(d.Compiled || "") || [])[1] || "",
    rows: rows.map(r => ({ rank: +r.Cells[0].Value, name: String(r.Cells[1].Value).replace(/\s+/g, " ").trim(), avg: +r.Cells[2].Value }))
      .map(r => ({ ...r, pids: who(r.name) })).filter(r => r.pids.length) };
}
// History for the groups fetchBhs found: every club row's rounds, and each league's ranking. A second night run (its
// own subrequests: about 20).
export async function fetchBhsHistory(budget, groups, players = PLAYERS) {
  const who = matcher(players), members = {}, rank = {};
  const take = () => { if (budget.left <= 0) throw new Error("subrequest budget"); budget.left--; };
  const get = async u => { take(); const r = await fetch(BHS + u, { headers: { "User-Agent": "Mozilla/5.0 (padel.holmberg.st nightly)", "Accept": "application/json" }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error("Backhandsmash HTTP " + r.status); return r.text(); };
  for (const g of groups) for (const r of g.rows) {
    if (!r.id || !(r.pids || []).length || members[r.id]) continue;
    members[r.id] = parseHistory(await get("/public/members/" + r.id + "/roundhistorydata"));
  }
  for (const g of groups) {
    if (!g.site || rank[g.lg]) continue;
    rank[g.lg] = parseRanking(await get("/public/stats/leagues/" + g.site + "/ranking/0?mobile=false"), who);
  }
  return { members, rank };
}

// Series winners: a round is over when the league's newest round in the history moves on (a new round has begun). The
// teams/players that were 1st in the round that ended are the winners; names and groups come from the tables seen
// before the change (snap). -> {cur: {lg: round}, snap: {memberId: {lg, series, group, n, pids}}, sw: [...]} (sw kept 60 days)
const roundNo = r => { const m = /(\d{4})\s*:\s*(\d+)/.exec(String(r)); return m ? +m[1] * 100 + +m[2] : 0; };
export function seriesWinners(prev, members, groups, t) {
  const p = prev || {}, cur = {}, snap = {}, sw = ((p.sw || []).filter(w => +t - Date.parse(w.at) < 60 * 864e5));
  for (const g of groups) for (const r of g.rows) {
    if (!r.id || !(r.pids || []).length) continue;
    snap[r.id] = { lg: g.lg, series: g.series, group: g.name, n: r.n, pids: r.pids };
    const last = (members[r.id] || []).map(x => x[0]).sort((a, b) => roundNo(b) - roundNo(a))[0];
    if (last && roundNo(last) > roundNo(cur[g.lg] || "")) cur[g.lg] = last;
  }
  for (const lg of Object.keys(cur)) {
    const was = (p.cur || {})[lg];
    if (!was || roundNo(cur[lg]) <= roundNo(was)) continue;   // first run, or the same round
    for (const id of Object.keys(p.snap || {})) {
      const s0 = p.snap[id], e = s0.lg === lg && (members[id] || []).find(x => roundNo(x[0]) === roundNo(was));
      if (e && e[2] === 1 && !sw.some(w => w.id === +id && w.round === was)) sw.push({ id: +id, lg, series: s0.series, group: s0.group, round: was, n: s0.n, pids: s0.pids, at: t.toISOString() });
    }
  }
  return { cur, snap, sw };
}

/* ---- the schedule (time and court of the coming matches) is behind the login: the captain's MATCHi account, secrets
   BHS_USER / BHS_PASS (off without them). Login: backhandsmash.com -> auth.matchi.com (Keycloak form) -> session. ---- */
// Minimal cookie jar: name=value per host (enough for the login round trip; paths and expiry are not needed here).
function jar() {
  const by = {};
  return {
    take(url, res) {
      const host = new URL(url).host, list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      for (const c of list) {
        const [nv] = c.split(";"), i = nv.indexOf("=");
        if (i > 0) (by[host] = by[host] || {})[nv.slice(0, i).trim()] = nv.slice(i + 1).trim();
      }
    },
    header(url) {
      const c = by[new URL(url).host] || {};
      return Object.keys(c).map(k => k + "=" + c[k]).join("; ");
    }
  };
}

// fetch that follows redirects by hand, so every hop's cookies are kept. -> {res, url, text}
async function go(j, url, init = {}, hops = 10) {
  for (let i = 0; i < hops; i++) {
    const headers = { "User-Agent": "Mozilla/5.0 (padel.holmberg.st nightly)", "Accept": "text/html,application/xhtml+xml", ...(init.headers || {}) };
    const ck = j.header(url);
    if (ck) headers.Cookie = ck;
    const res = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
    j.take(url, res);
    const loc = res.headers.get("Location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).href;
      init = { method: "GET" };   // a POST answered with a redirect continues as GET
      continue;
    }
    return { res, url, text: await res.text() };
  }
  throw new Error("too many redirects");
}

const unesc = s => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// -> a cookie jar with a logged-in Backhandsmash session. Errors never include the credentials.
export async function bhsLogin(env) {
  if (!env.BHS_USER || !env.BHS_PASS) throw new Error("BHS_USER/BHS_PASS not set");
  const j = jar();
  const a = await go(j, BHS + "/sv/Pages/Login");
  // MATCHi's login page is a Keycloakify app: the form's target is in its kcContext ("loginAction"); a plain form as fallback
  const m = /"loginAction"\s*:\s*"([^"]+)"/.exec(a.text) || /<form[^>]*action="([^"]*login-actions\/authenticate[^"]*)"/i.exec(a.text);
  if (!m) throw new Error("login form not found (" + new URL(a.url).host + " " + a.res.status + ")");
  const body = new URLSearchParams({ username: String(env.BHS_USER).trim(), password: String(env.BHS_PASS).replace(/[\r\n]+$/, ""), credentialId: "" });   // pasted values: no stray line breaks
  const b = await go(j, new URL(unesc(m[1].replace(/\\\//g, "/")), a.url).href, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (new URL(b.url).host.indexOf("matchi.com") >= 0) {
    const err = /"message"\s*:\s*\{[^}]*"summary"\s*:\s*"([^"]*)"/.exec(b.text) || /kc-feedback-text[^>]*>([^<]*)/i.exec(b.text);
    const page = /pageId = "([^"]+)"/.exec(b.text);
    throw new Error("login refused" + (err ? ": " + err[1].trim() : "") + " (" + (page ? page[1] : b.res.status) + ")");
  }
  return { get: async path => { const r = await go(j, new URL(path, BHS).href); return { status: r.res.status, url: r.url, html: r.text }; } };
}
