// Browser test of index.html (Playwright + Chromium): RankedIn and the push worker are mocked with the same
// fake API as the worker tests (test/fake-rankedin.mjs); GET /events is produced by the real worker code.
//   python3 -m http.server 19021 --bind 127.0.0.1   (from the repo root)
//   NODE_PATH=$(npm root -g) PAGE_URL=http://127.0.0.1:19021/ node worker/test/page-e2e.mjs
// Env: CHROMIUM (default /opt/pw-browsers/chromium), SHOTS=<dir> saves screenshots.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import worker, { tick, _resetMemory } from "../src/index.js";
import { install, route } from "./fake-rankedin.mjs";
import { makeVapid } from "./helpers.mjs";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.PAGE_URL || "http://127.0.0.1:19021/";
const T = "2026-09-27T13:52:00+02:00";   // Järfälla no 11, Damer C on (Thea and Cassandra), Kian's SPL next Saturday
const PUSH_API = "https://padel-push.holmberg-padel.workers.dev";
const SHOTS = process.env.SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// ---- GET /events from the worker itself (discovery + one live tick on the fake RankedIn) ----
const realFetch = globalThis.fetch;
const kvm = new Map(), PUSH = { async get(k) { return kvm.has(k) ? kvm.get(k) : null; }, async put(k, v) { kvm.set(k, v); }, async delete(k) { kvm.delete(k); },
  async list({ prefix }) { return { keys: [...kvm.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
install({ over: { "/tournament/GetDrawsForStageAndStrengthAsync?tournamentClassId=164677&drawStrength=0&drawStage=0&isReadonly=true&language=en": [] } });
await tick({ PUSH, NOW: "2026-09-27T11:07:00Z", ORIGIN: "x" });
// Discovery rounds of 4 players (during the live day): each looks at its players' RankedIn profile photos too.
for (const m of ["11:17", "11:27", "11:37", "11:47"]) { _resetMemory(); await tick({ PUSH, NOW: "2026-09-27T" + m + ":00Z", ORIGIN: "x", RANK_OFF: "1" }); }
_resetMemory();
await tick({ PUSH, NOW: "2026-09-27T11:52:00Z", ORIGIN: "x" });   // minute 52: ranking + 6 skills into the leaderboard
const EVENTS = await (await worker.fetch(new Request("https://w/events"), { PUSH, NOW: "2026-09-27T11:52:00Z", ORIGIN: "x" })).json();
// The week after (Veckans vinnare): the real final (Thea and Cassandra 6-1 6-4) seen by the live tick, then a full
// round of discovery on Tuesday (Järfälla moves to "past"), GET /events on Tuesday.
const FINAL = { "/tournament/GetDrawsForStageAndStrengthAsync?tournamentClassId=164681&drawStrength=0&drawStage=0&isReadonly=true&language=en": JSON.parse(readFileSync(new URL("./fixtures/dc_final.json", import.meta.url), "utf8")) };
install({ over: { ...FINAL, "/tournament/GetDrawsForStageAndStrengthAsync?tournamentClassId=164677&drawStrength=0&drawStage=0&isReadonly=true&language=en": [] } });
_resetMemory();
await tick({ PUSH, ...(await makeVapid()), NOW: "2026-09-27T16:10:00Z", ORIGIN: "x", RANK_OFF: "1" });   // notiser: no subscribers here
for (const m of ["08:07", "08:17", "08:27", "08:37", "08:47"]) { _resetMemory(); await tick({ PUSH, NOW: "2026-09-29T" + m + ":00Z", ORIGIN: "x", RANK_OFF: "1" }); }
_resetMemory();
const EVENTS_WEEK = await (await worker.fetch(new Request("https://w/events"), { PUSH, NOW: "2026-09-29T10:00:00Z", ORIGIN: "x" })).json();
globalThis.fetch = realFetch;
assert.deepEqual(EVENTS.wins, [], "no winner during the day");
assert.deepEqual(EVENTS_WEEK.wins.map(w => w.id + " " + w.s), ["164681:1 6-1 6-4"], "worker wins the week after");
assert.ok(EVENTS_WEEK.past.some(e => e.classId === 164681) && !EVENTS_WEEK.events.some(e => e.classId === 164681), "Järfälla in past");
assert.ok(EVENTS.live["1675246"], "worker live view for Thea");
assert.equal(EVENTS.photos["1055851"].placeholder, false, "worker photos: Sanna has a RankedIn photo");
assert.deepEqual([EVENTS.board["1675246"].w, EVENTS.board["1675246"].rk, EVENTS.board["1680004"].up], [32, 150, 41], "worker board: W–L, standing, climb");
assert.ok(EVENTS_WEEK.board["1675246"].rk === 150, "board kept through later discovery rounds");

// What the page reads besides the discovery (ranking, skill, profile, SPL table): made up from players.json.
const ROSTER = JSON.parse(readFileSync(new URL("../../players.json", import.meta.url), "utf8"));
// Thea's earlier tournaments (seed list in index.html, stage 0): three with a draw, the rest none.
const drawOf = cid => "/tournament/GetDrawsForStageAndStrengthAsync?tournamentClassId=" + cid + "&drawStrength=0&drawStage=0&isReadonly=true&language=en";
const FX = n => JSON.parse(readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8"));
const PAST = { [drawOf(164475)]: FX("dc_loses_qf.json"), [drawOf(166356)]: FX("vista_rr_new.json"), [drawOf(164806)]: FX("dc_final.json") };
// Each opponent on their own (POST, real endpoint's shape): made up per id.
const oppStats = ids => ids.map(id => ({ ParticipantId: id, FirstName: "X", LastName: "Y", All: { Total: id % 5, Wins: Math.floor((id % 5) / 2), WinPercentage: 50 } }));
function pageApi(path, over, req) {
  const u = new URL("https://x" + path), q = k => u.searchParams.get(k), p = u.pathname.toLowerCase();
  if (p.endsWith("/rating/getplayerselectedopponentsstatsasync")) return req && req.method() === "POST" ? oppStats(JSON.parse(req.postData() || "{}").participantIds || []) : null;
  const byPid = id => ROSTER.find(x => String(x.pid) === String(id));
  if (p.endsWith("/ranking/searchrankingplayersasync")) {
    const r = ROSTER.find(x => x.name === q("searchTerm"));
    return { Payload: r && r.rank ? [{ Participant: { NewParticipantId: r.pid }, StandingDiff: 12, ParticipantPoints: { Standing: r.rank, Points: r.points, RankingDate: (q("rankingDate") < "2026-09-21" ? "2026-09-14" : "2026-09-21") + "T00:00:00" } }] : [] };
  }
  if (p.endsWith("/rating/getplayerratinghistoryforchartasync")) {
    const r = byPid(q("playerId")), base = (r && r.skill) || 12;
    return r && r.skill ? Array.from({ length: 11 }, (_, i) => ({ Rating: +(base - 0.3 + ((i * 7) % 5) * 0.12).toFixed(2), Date: "2026-0" + (7 + Math.floor(i / 4)) + "-" + String(10 + i).padStart(2, "0") + "T10:00:00", UnixTimestamp: 1780000000000 + i * 864e5 })).concat([{ Rating: base, Date: "2026-09-27T10:00:00", UnixTimestamp: 1790000000000 }]) : [];
  }
  if (p.endsWith("/player/playerprofileinfoasync")) return { Header: { Form: ["W", "L", "W", "W", "L"] }, Statistics: { WinLossDoublesCurrentYear: "12-7", EventsParticipatedDoublesCurrentYear: "6", CareerWinLossDoubles: "30-21", CareerEventsParticipatedDoubles: "14" } };
  if (p.endsWith("/rating/getplayerratingasync")) return [{ RatingId: 65, RatingValue: 13.5 }, { RatingId: 64, RatingValue: 12.5 }];
  if (p.endsWith("/teamleague/getpoolsinfoasync")) return { pools: [{ id: 1, name: "R4 Öst - Div 3 Öst - Södra" }, { id: 2, name: "R4 Öst - Div 4 Öst-mitt" }] };
  if (p.endsWith("/teamleague/getteamstandingsasync")) {
    const mine = q("poolId") === "1" ? ["Nynäs Damlag", 3355655] : ["Nynäs Padel Club 2", 3383536];
    return { scoresViewModels: [[mine[0], mine[1]], ["Team TK x Rejoice", 1], ["CC Academy UNO Nacka 2", 2], ["Padelverket Damlag", 3]].map((x, i) => ({ standing: i + 1, participantName: x[0], participantUrl: "/en/teamleague/team/" + x[1] + "/x", played: 0, wins: 0, draws: 0, losses: 0, gamesDifference: 0, matchPoints: 0 })) };
  }
  if (p.endsWith("/tournament/getresultsasync")) return { Data: [] };
  const body = route(path, over);
  if (body == null && p.endsWith("/tournament/getinfoasync")) return { TournamentSidebarModel: { Classes: [] } };
  return body;
}

const STANDIN = readFileSync(new URL("../../img/beatriz-callero.jpg", import.meta.url));
const CDN_RE = /^https:\/\/(cdn\.rankedin\.com|rankedin-prod-cdn-adavg8d3dwfegkbd\.z01\.azurefd\.net)\//;
const results = [];
const ok = (name, cond, info) => { results.push((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(info))); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    colorScheme: opts.dark ? "dark" : "light", serviceWorkers: "block" });
  await ctx.grantPermissions(["notifications"], { origin: new URL(BASE).origin });
  const page = await ctx.newPage();
  const errors = [], api = { ri: 0, posts: [], img: [], paths: [] };
  // The one expected load error: Oliver's gone RankedIn photo (the page shows initials instead).
  page.on("console", m => { if (m.type() === "error" && !/\/900002/.test((m.location() || {}).url || "")) errors.push(m.text()); });
  page.on("pageerror", e => errors.push(String(e)));
  await page.route("https://api.rankedin.com/**", r => {
    api.ri++;
    const u = r.request().url(), body = pageApi(u.slice("https://api.rankedin.com/v1".length), { ...PAST, ...(opts.over || {}) }, r.request());
    api.paths.push(r.request().method() + " " + u.slice("https://api.rankedin.com/v1".length).split("&language")[0]);
    if (process.env.DEBUG) (globalThis.RI_LOG = globalThis.RI_LOG || []).push((body == null ? "404 " : "200 ") + u.slice(27).split("&language")[0]);
    return r.fulfill({ status: body == null ? 404 : 200, contentType: "application/json", body: JSON.stringify(body ?? {}), headers: { "Access-Control-Allow-Origin": "*" } });
  });
  // RankedIn's image CDN (profile photos): a stand-in portrait; Oliver's file (900002) is gone.
  await page.route(/^https:\/\/(cdn\.rankedin\.com|rankedin-prod-cdn-adavg8d3dwfegkbd\.z01\.azurefd\.net)\//, r => {
    const u = r.request().url();
    api.img.push(u);
    return /\/900002/.test(u) ? r.fulfill({ status: 404, body: "" }) : r.fulfill({ status: 200, contentType: "image/jpeg", body: STANDIN });
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route(PUSH_API + "/**", r => {
    const u = new URL(r.request().url()), h = { "Access-Control-Allow-Origin": "*" };
    if (u.pathname === "/events") return opts.workerDown ? r.fulfill({ status: 503, body: "{}", headers: h }) : r.fulfill({ contentType: "application/json", body: JSON.stringify(opts.events || EVENTS), headers: h });
    if (u.pathname === "/vapid") return r.fulfill({ contentType: "application/json", body: JSON.stringify({ key: "BOr5MaD1vP9w2uH0Pqzv8pH5v2cXf8j8e7Rrx6Qv0yq2mS9d2w8g5k2WnYQx1S0x0gJ5v8wV0z9Q2v5cXf8j8e7R", classes: [164681] }), headers: h });
    if (u.pathname === "/subscribe" || u.pathname === "/unsubscribe") { api.posts.push({ path: u.pathname, body: JSON.parse(r.request().postData() || "{}") }); return r.fulfill({ contentType: "application/json", body: "{\"ok\":true}", headers: h }); }
    return r.fulfill({ status: 404, body: "{}", headers: h });
  });
  // Push without a push service: a fake subscription, so the page's /subscribe calls can be checked.
  await page.addInitScript(() => {
    window.__notes = [];
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
    window.Notification = function (t, o) { window.__notes.push([t, o && o.body]); return { close() {} }; };
    window.Notification.permission = "granted";
    window.Notification.requestPermission = () => Promise.resolve("granted");
    const fakeSub = { endpoint: "https://fcm.googleapis.com/fcm/send/e2e", options: { applicationServerKey: null },
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "x", auth: "y" } }; }, unsubscribe() { return Promise.resolve(true); } };
    const reg = { pushManager: { getSubscription: () => Promise.resolve(window.__sub || null), subscribe: () => Promise.resolve(window.__sub = fakeSub) },
      showNotification(t, o) { window.__notes.push([t, o && o.body]); return Promise.resolve(); } };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve(reg), register: () => Promise.resolve(reg), addEventListener() {} } });
    if (!window.PushManager) window.PushManager = function () {};
  });
  return { page, ctx, errors, api };
}
const url = (h, extra = "", t = T) => BASE + "?t=" + encodeURIComponent(t) + extra + h;
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: SHOTS + "/" + name + ".png", fullPage: true }); };
const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

if (process.env.SNAP) {   // screenshot helper: SNAP="#hash|out.png|width|dark"
  const [h, out, w, dark] = process.env.SNAP.split("|");
  const { page, ctx } = await newPage({ width: +(w || 390), dark: !!dark });
  await page.goto(url(h || ""));
  await page.waitForTimeout(2500);
  if (process.env.SCROLL) { await page.evaluate(y => window.scrollTo(0, +y), process.env.SCROLL); await page.waitForTimeout(400); }
  await page.screenshot({ path: out, fullPage: !!process.env.FULL });
  await ctx.close(); await browser.close();
  process.exit(0);
}
try {
  // ---- home ----
  let { page, ctx, errors, api } = await newPage();
  await page.goto(url(""));
  await page.waitForSelector("#nowList .nowrow");
  const nowNames = await page.$$eval("#nowList .nowrow b", b => b.map(x => x.textContent));
  ok("home: Spelar nu lists Thea and Cassandra (Damer C live)", nowNames.some(n => /^Thea/.test(n)) && nowNames.some(n => /^Cassandra/.test(n)), nowNames);
  const theaRow = await page.$eval('#nowList a[href="#thea"]', a => a.textContent);
  ok("home: Thea's row shows her next match from the worker", /Kvartsfinal/.test(theaRow) && /Pettersson Österberg/.test(theaRow), theaRow);
  ok("home: followed players first (Thea before Cassandra)", nowNames.findIndex(n => /^Thea/.test(n)) < nowNames.findIndex(n => /^Cassandra/.test(n)), nowNames);
  const agenda = await page.$$eval("#agenda .arow", a => a.map(x => x.textContent.replace(/\s+/g, " ")));
  const spl = agenda.filter(x => /SPL Damer/.test(x));
  ok("home: Kommande has SPL per team (no duplicates per player) and Vista", spl.length >= 1 && new Set(spl).size === spl.length && agenda.some(x => /Vista/.test(x)) && agenda.some(x => /SPL Herrar/.test(x)), agenda);
  { const n = (await page.$$eval("#teams .tcard", c => c.map(x => x.querySelectorAll(".troster li").length))).sort().join();
    ok("home: three team cards with roster avatars", n === "4,6,7", n); }
  ok("home: player list with all 17", (await page.$$("#plist li")).length === 17);
  await page.fill("#q", "sved");
  ok("home: search filters (sved -> Anton Svedman, Svante Svedberg)", (await page.$$eval("#plist b", b => b.map(x => x.textContent))).sort().join() === "Anton Svedman,Svante Svedberg");
  await page.fill("#q", "");
  ok("home: no horizontal scroll at 390", await noHScroll(page));
  ok("home: at most a handful of RankedIn calls on load", api.ri <= 2, api.ri);
  ok("home: no Veckans vinnare on the day (worker has no wins yet)", await page.$eval("#secWin", s => s.hidden));
  await shot(page, "home");

  // ---- player with photo (Thea): live view, deep link ----
  await page.goto(url("#thea/m6872156"));
  await page.waitForSelector('#p-thea [data-mid="6872156"]');
  await page.waitForTimeout(600);
  ok("deep link #thea/m6872156: Thea's page, match flashed", await page.$eval('#p-thea [data-mid="6872156"]', e => e.classList.contains("flash") || !!e.closest("#p-thea:not([hidden])")));
  ok("Thea: hero photo", await page.$eval("#p-thea .hero .pmed img", i => i.getAttribute("src")) === "img/thea.jpg");
  ok("Thea: chips show followed first and Thea current", (await page.$$eval("#chips .pchip", a => a.map(x => x.getAttribute("href") + (x.getAttribute("aria-current") ? "*" : "")))).slice(0, 2).join() === "#thea*,#kian");
  ok("Thea: trend numbers", /#\d+/.test(await page.textContent("#tv-thea-rank")));
  // ---- the player card (hero): rating, class, tier, stats from the data ----
  const cardOf = k => page.$eval("#p-" + k + " .hero", h => {
    const st = {}, t = e => e ? e.textContent.replace(/\s+/g, " ").trim() : null;
    h.querySelectorAll(".pstats .st").forEach(x => { st[x.getAttribute("data-st")] = t(x.querySelector("dd")); });
    const ln = h.querySelector(".pname .ln");
    return { cls: h.className, ovr: t(h.querySelector(".prate .ovr")), klass: t(h.querySelector(".prate .cls")), labels: [...h.querySelectorAll(".pstats dt [aria-hidden]")].map(x => x.textContent),
      st, pips: [...h.querySelectorAll(".pstats .pips i")].map(i => i.className).join(""), win: t(h.querySelector(".pwin")), tip: t(h.querySelector(".ptip")), fn: t(h.querySelector(".pname .fn")),
      ln: t(ln), lnFits: ln ? ln.scrollWidth <= ln.clientWidth + 1 : null, tm: t(h.querySelector(".pname .tm")), sr: t(h.querySelector(".pface > .sr")), ini: t(h.querySelector(".ini-big")),
      follow: !!h.querySelector(".pc .pfol [data-follow]"), crest: !!h.querySelector(".prate img.crest[src='img/nynas-logo.png']"), court: !!h.querySelector(".court") };
  });
  const RT = ROSTER.find(x => x.key === "thea"), ptsTxt = v => v.toFixed(v >= 20 ? 1 : 2);
  await page.waitForFunction(() => /150/.test(document.querySelector("#p-thea .pstats [data-st=rnk] dd")?.textContent || "") && document.querySelector("#p-thea .pstats [data-st=form]"), null, { timeout: 8000 }).catch(() => {});
  { const c = await cardOf("thea");
    ok("card Thea: gold tier (skill 15.94), rating 15.9 as 15 + .9, class B (Damer rank 150)", /\bt-gold\b/.test(c.cls) && c.ovr === "15.9" && c.klass === "B" && /Skill 15,94, får spela B-klass, ranking 150/.test(c.sr), c);
    ok("card Thea: stats row RNK/PTS/SKL/VIN%/TIT/FORM from the data (labels above the values)", c.labels.join() === "RNK,PTS,SKL,VIN%,TIT,FORM" &&
      /^#150/.test(c.st.rnk) && c.st.pts.startsWith(ptsTxt(RT.points)) && c.st.skl.startsWith("15.94") && /^89\b/.test(c.st.vin) && /^\d+$/.test(c.st.tit), c);
    ok("card Thea: form pips W L W W L with a text alternative", c.pips === "wlwwl" && /Form: V F V V F \(3 vinster, 2 förluster\)/.test(c.st.form), c);
    ok("card Thea: name bar (first name, surname fits, team · division), crest, follow on the card, no court lines", c.fn === "Thea" && c.ln === "Holmberg Löving" && c.lnFits && c.tm === "Nynäs Damlag · Div 3 Öst - Södra" && c.crest && c.follow && !c.court && !c.win && c.tip === "Nynäs Padel Club", c); }
  await shot(page, "thea");

  // ---- player without photo (Lisa): initials hero, no broken image ----
  await page.goto(url("#lisa"));
  await page.waitForSelector("#p-lisa .hero.noimg .ini-big");
  ok("Lisa: initials hero (LB), no img", (await page.textContent("#p-lisa .ini-big")) === "LB" && (await page.$$("#p-lisa .hero .pmed img")).length === 0);
  ok("Lisa: back to Nynäs idag", await page.isVisible("#pnav .back"));
  await page.waitForFunction(() => document.querySelector("#p-lisa .pstats [data-st=form]"), null, { timeout: 8000 }).catch(() => {});
  { const c = await cardOf("lisa");
    ok("card Lisa: silver tier (13.14), initials fallback, class C (Damer rank 691), no TIT slot without titles (no TÄV)", /\bt-silver\b/.test(c.cls) && /\bnoimg\b/.test(c.cls) && c.ini === "LB" && c.ovr === "13.1" && c.klass === "C" &&
      c.labels.join() === "RNK,PTS,SKL,VIN%,FORM", c); }
  const broken = await page.$$eval("img", im => im.filter(i => i.complete && i.naturalWidth === 0 && i.getAttribute("src")).map(i => i.getAttribute("src")));
  ok("no broken images", broken.length === 0, broken);
  ok("Lisa: no horizontal scroll", await noHScroll(page));
  await shot(page, "lisa");

  // ---- RankedIn profile photos (worker "photos"), only for players without a photo in players.json ----
  await page.goto(url(""));
  await page.waitForSelector('#plist a[href="#sanna"] .av img');
  for (const k of ["sanna", "oliver"]) await page.$eval('#plist a[href="#' + k + '"]', e => e.scrollIntoView({ block: "center" }));   // lazy images
  await page.waitForFunction(() => [...document.querySelectorAll('#plist a[href="#sanna"] img, #plist a[href="#oliver"] img')].every(i => i.complete && i.naturalWidth), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  const av = await page.$$eval("#plist a", a => Object.fromEntries(a.map(x => { const i = x.querySelector(".av img"); return [x.getAttribute("href").slice(1), i ? i.getAttribute("src") + (i.naturalWidth ? "" : " (not loaded)") : "ini:" + x.querySelector(".av").textContent]; })));
  ok("photos: Sanna (no own photo) gets her RankedIn thumbnail in the player list", /^https:\/\/rankedin-prod-cdn-adavg8d3dwfegkbd\.z01\.azurefd\.net\/images\/upload\/player\/900001thumb\.png$/.test(av.sanna), av.sanna);
  ok("photos: Lisa (RankedIn placeholder) keeps initials", av.lisa === "ini:LB", av.lisa);
  ok("photos: Kian's own avatar wins over his RankedIn photo", av.kian === "img/av/kian-avatar.jpg", av.kian);
  ok("photos: Oliver's broken RankedIn photo falls back to initials", av.oliver === "ini:OL" && await page.$eval('#plist a[href="#oliver"] .av', e => e.classList.contains("ini")), av.oliver);
  ok("photos: the rest keep initials", ["svante", "tobias", "anton"].every(k => /^ini:/.test(av[k])), av);
  await shot(page, "photos-home");
  await page.goto(url("#sanna"));
  await page.waitForSelector("#p-sanna .hero.rin .pmed > img");
  await page.waitForFunction(() => document.querySelector("#p-sanna .hero .pmed > img").complete);
  const sh = await page.$eval("#p-sanna .hero .pmed > img", i => ({ src: i.getAttribute("src"), w: i.naturalWidth, pos: getComputedStyle(i).objectPosition, fit: getComputedStyle(i).objectFit }));
  ok("photos: Sanna's hero is her full RankedIn photo, cover, 50% 20%", sh.src.endsWith("/player/900001.png") && sh.w > 0 && sh.fit === "cover" && sh.pos === "50% 20%" && !(await page.$("#p-sanna .ini-big")), sh);
  ok("photos: Sanna no horizontal scroll", await noHScroll(page));
  await shot(page, "photos-sanna");
  await page.goto(url("#oliver"));
  await page.waitForSelector("#p-oliver .hero.noimg .ini-big");
  ok("photos: Oliver's hero falls back to initials (OL), no img", (await page.textContent("#p-oliver .hero .ini-big")) === "OL" && !(await page.$("#p-oliver .hero .pmed > img")));
  await page.goto(url("#kian"));
  await page.waitForSelector("#p-kian:not([hidden]) .hero .pmed > img");
  ok("photos: Kian's hero stays img/kian.jpg", await page.$eval("#p-kian .hero .pmed > img", i => i.getAttribute("src")) === "img/kian.jpg");
  ok("photos: only roster photos are requested from the CDN (no placeholder logo)", api.img.length > 0 && api.img.every(u => CDN_RE.test(u) && !/rin_logo|121978/.test(u)), api.img);
  ok("photos: no CSP violations", (await page.evaluate(() => window.__csp)).length === 0, await page.evaluate(() => window.__csp));

  // ---- Cassandra (photo, no avatar): her own Damer C entry from the worker ----
  await page.goto(url("#cassandra"));
  await page.waitForSelector("#p-cassandra .hero .pmed img");
  await page.waitForFunction(() => /Damer C/.test(document.querySelector("#p-cassandra [data-r=round]")?.textContent || ""));
  ok("Cassandra: live Damer C view with Thea as partner", /Thea|Holmberg/.test(await page.textContent("#p-cassandra .vs")));
  await shot(page, "cassandra");

  // ---- old #kian link ----
  await page.goto(url("#kian"));
  await page.waitForSelector("#p-kian:not([hidden]) .hero .pmed img");
  ok("old #kian link opens Kian", (await page.title()).startsWith("Kian Borgström"));
  { const c = await cardOf("kian");
    ok("card Kian: bronze tier (11.56), rating cut to 11.5 (not rounded), class C (Herrar rank 789)", /\bt-bronze\b/.test(c.cls) && c.ovr === "11.5" && c.klass === "C" && c.ln === "Borgström" && c.lnFits, c); }

  // ---- follow + bell ----
  await page.goto(url("#rebecca"));
  await page.waitForSelector("#p-rebecca .follow");
  await page.click("#p-rebecca .follow");
  ok("follow Rebecca: button pressed, chip moves to the followed group", await page.getAttribute("#p-rebecca .follow", "aria-pressed") === "true" &&
    (await page.$$eval("#chips .pchip", a => a.map(x => x.getAttribute("href")))).slice(0, 3).includes("#rebecca"));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("padel.follow.v1")));
  ok("follows stored", JSON.stringify(stored.slice().sort()) === JSON.stringify([1675246, 1680004, 888094].sort()), stored);
  await page.click("#bell");
  await page.waitForFunction(() => /stängd/.test(document.getElementById("nHint").textContent), null, { timeout: 5000 }).catch(() => {});
  ok("bell on: push for the followed players", await page.getAttribute("#bell", "aria-pressed") === "true" && /Thea, Rebecca och Kian/.test(await page.textContent("#nHint")), await page.textContent("#nHint"));
  const sub1 = api.posts.filter(p => p.path === "/subscribe").at(-1);
  ok("POST /subscribe with prefs {follow}", sub1 && JSON.stringify(sub1.body.prefs.follow.slice().sort()) === JSON.stringify([1675246, 1680004, 888094].sort()), sub1 && sub1.body);
  await page.click("#p-rebecca .follow");
  await page.waitForTimeout(400);
  ok("unfollow Rebecca", await page.getAttribute("#p-rebecca .follow", "aria-pressed") === "false");
  const sub2 = api.posts.filter(p => p.path === "/subscribe").at(-1);
  ok("follow change re-posts /subscribe", sub2 && sub2 !== sub1 && JSON.stringify(sub2.body.prefs.follow.slice().sort()) === JSON.stringify([1675246, 1680004].sort()), api.posts);

  // ---- swipe between followed players (Thea -> Kian) ----
  await page.goto(url("#thea"));
  await page.waitForSelector("#p-thea:not([hidden]) .hero");
  const box = await page.$eval("#p-thea .hero", e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const cdp = await ctx.newCDPSession(page);
  const touch = async (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  await touch("touchStart", box.x + 100, box.y);
  for (let i = 1; i <= 8; i++) await touch("touchMove", box.x + 100 - i * 25, box.y + 2);
  await touch("touchEnd");
  await page.waitForTimeout(500);
  ok("swipe left on Thea's photo -> Kian (next followed)", new URL(page.url()).hash === "#kian" && await page.isVisible("#p-kian"), page.url());
  await touch("touchStart", box.x - 100, box.y);
  for (let i = 1; i <= 8; i++) await touch("touchMove", box.x - 100 + i * 25, box.y + 2);
  await touch("touchEnd");
  await page.waitForTimeout(500);
  ok("swipe right -> back to Thea", new URL(page.url()).hash === "#thea", page.url());

  // ---- statistics: Topplistan (home), inbördes möten (hero + draw), Partners ----
  const SP = "/tmp/claude-0/-home-user-padel/e0bacc1b-df2c-5dc3-aa35-2abf1c7370b5/scratchpad/";
  for (const dark of [false, true]) {
    const tag = dark ? "dark" : "light";
    ({ page, ctx, errors, api } = await newPage({ dark }));
    await page.goto(url(""));
    await page.waitForSelector("#topList .trow");
    const rows = async () => page.$$eval("#topList .trow", a => a.map(x => x.querySelector(".tn b").firstChild.textContent + "=" + x.querySelector(".tv b").firstChild.textContent));
    let r = await rows();
    if (!dark) {
      ok("Topplistan: skill, damer by default, Thea first (15.94)", /^Thea Holmberg Löving=15\.94$/.test(r[0]) && r.length === 5, r);
      await page.click('#topGender [data-g="M"]');
      r = await rows();
      ok("Topplistan: herrar skill, Victor first", /^Victor/.test(r[0]) && r.every(x => !/Thea/.test(x)), r);
      await page.click('#topTabs [data-top="rank"]');
      r = await rows();
      ok("Topplistan: ranking herrar, #118 first (Tobias)", r[0] === "Tobias Strandberg=#118" || /=#118$/.test(r[0]), r);
      ok("Topplistan: ranking note counts unranked", /utan ranking/.test(await page.textContent("#topNote")));
      await page.click('#topTabs [data-top="wins"]');
      r = await rows();
      ok("Topplistan: årets vinster, everyone, Thea 32 first", /^Thea Holmberg Löving=32$/.test(r[0]) && await page.$eval("#topGender", g => g.hidden), r);
      await page.click("#topMore");
      ok("Topplistan: Visa alla shows everyone with a record", (await rows()).length > 5, await rows());
      await page.click('#topTabs [data-top="climb"]');
      r = await rows();
      ok("Topplistan: veckans klättrare, Kian +41 first, only climbers", /^Kian Borgström=\+41$/.test(r[0]) && r.every(x => /=\+\d+$/.test(x)), r);
      ok("Topplistan: remembered on this device", (await page.evaluate(() => JSON.parse(localStorage.getItem("padel.top.v1")).tab)) === "climb");
      ok("Topplistan: no RankedIn calls on home", api.ri <= 2, api.paths);
      ok("Topplistan: no horizontal scroll at 390", await noHScroll(page));
      await page.click('#topTabs [data-top="skill"]');
      await page.click('#topGender [data-g="F"]');
    }
    await (await page.$("#secTop")).screenshot({ path: SP + "stats-top-" + tag + ".png" });
    await page.click('#topTabs [data-top="climb"]');
    await (await page.$("#secTop")).screenshot({ path: SP + "stats-top-climb-" + tag + ".png" });
    // Thea: next match QF vs Pettersson Österberg / Ekeland; she beat them at UNO July (fixture)
    const before = api.paths.length;
    await page.goto(url("#thea"));
    await page.waitForSelector("#p-thea .h2h .v", { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => /\d–\d mot|Första/.test(document.querySelector("#p-thea .h2h")?.textContent || "") && /Var för sig/.test(document.querySelector("#p-thea .h2h")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
    const h2h = (await page.textContent("#p-thea .h2h").catch(() => "")).replace(/\s+/g, " ");
    await page.waitForSelector("#paList-thea .parow", { timeout: 8000 }).catch(() => {});
    const calls = api.paths.slice(before);
    if (!dark) {
      ok("hero: Tidigare möten vs the next pair from Thea's earlier draws", /Tidigare möten/.test(h2h) && /1–0/.test(h2h) && /Pettersson Österberg \/ Ekeland/.test(h2h), h2h);
      ok("hero: each opponent on their own (RankedIn opponent stats, one POST)", /Var för sig:/.test(h2h) && calls.filter(c => /^POST .*SelectedOpponentsStats/.test(c)).length === 1, [h2h, calls]);
      ok("draw: the next match's card shows the record", /Tidigare möten 1–0/.test(await page.$eval("#p-thea .m.next", m => m.textContent).catch(() => "")), await page.$eval("#p-thea .m.next", m => m.textContent).catch(() => ""));
      const clip = await page.$eval("#p-thea .m.next .mf", el => { const r = el.getBoundingClientRect(), m = el.closest(".m").getBoundingClientRect(), sc = el.closest(".bk-scroll").getBoundingClientRect(), sl = el.closest(".slot").getBoundingClientRect();
        return { mf: [r.top, r.bottom], m: [m.top, m.bottom], sc: [sc.top, sc.bottom], slot: [sl.top, sl.bottom], ok: r.bottom <= m.bottom + 0.5 && r.bottom <= sc.bottom && m.bottom <= sl.bottom + 1 && m.top >= sl.top - 1 }; }).catch(e => ({ ok: false, e: String(e) }));
      ok("draw: the record line fits in the card and its slot", clip.ok, clip);
      const pa = await page.$$eval("#paList-thea .parow", a => a.map(x => x.querySelector(".pn b").textContent + "=" + x.querySelector(".pv b").textContent + (x.classList.contains("best") ? "*" : "")));
      // Only one partner in these draws: no "Bäst" (it needs someone to compare with)
      ok("Partners: Cassandra with W–L, not marked best when she is the only partner", pa.length === 1 && /^Cassandra Ersson=\d+–\d+$/.test(pa[0]), pa);
      const paNote = await page.textContent("#paNote-thea"), paMeta = await page.textContent("#paMeta-thea");
      ok("Partners: period is the one the counted tournaments cover (not a claimed 12 months)", /^Turneringsmatcher sedan \d+ [a-zä]+\.$/.test(paNote) && /^Sedan\u00a0?\s?\d+\u00a0[a-zä]+ · \d+\u00a0matcher$/.test(paMeta), [paNote, paMeta]);
      const draws = calls.filter(c => /GetDrawsForStage/.test(c) && !/164681/.test(c));
      ok("Thea page: earlier draws fetched once each (8 classes, stage 0)", draws.length <= 8 && new Set(draws).size === draws.length, calls);
      ok("Thea page: history rows show the record vs the same pair", /mot paret \d+–\d+/.test(await page.textContent("#hist-thea").catch(() => "")), await page.textContent("#hist-thea").catch(() => ""));
      ok("Thea page: no horizontal scroll", await noHScroll(page));
      // Again (new page view, same device): matches and opponent stats from the cache, no fetch
      const b2 = api.paths.length;
      await page.reload();
      await page.waitForSelector("#p-thea .h2h .v", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(800);
      const again = api.paths.slice(b2).filter(c => /SelectedOpponents|GetDrawsForStage.*tournamentClassId=(164475|166356|164806)/.test(c));
      ok("second view: no refetch of earlier draws or opponent stats (24 h cache)", again.length === 0, again);
    }
    await (await page.$("#p-thea .board")).screenshot({ path: SP + "stats-h2h-" + tag + ".png" });
    const nx = await page.$("#p-thea .m.next");
    if (nx) { await nx.evaluate(e => e.scrollIntoView({ block: "center", behavior: "instant" })); await page.waitForTimeout(700); const bb = await (await nx.evaluateHandle(e => e.closest(".slot"))).asElement().boundingBox(); await page.screenshot({ path: SP + "stats-h2h-card-" + tag + ".png", clip: { x: Math.max(0, bb.x - 4), y: bb.y, width: Math.min(390, bb.width + 40), height: bb.height } }); }
    const pas = await page.$("#pa-thea");
    await pas.scrollIntoViewIfNeeded();
    await pas.screenshot({ path: SP + "stats-partners-" + tag + ".png" });
    ok("stats " + tag + ": no CSP violations", (await page.evaluate(() => window.__csp)).length === 0, await page.evaluate(() => window.__csp));
    ok("stats " + tag + ": no console errors", errors.length === 0, errors);
    await ctx.close();
  }
  // Hidden page: the matches are not counted (nothing fetched) until it is visible again
  ({ page, ctx, errors, api } = await newPage());
  await page.addInitScript(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__vis || "visible" }); window.__vis = "hidden"; });
  await page.goto(url("#kian"));
  await page.waitForSelector("#p-kian:not([hidden]) .hero");
  await page.waitForTimeout(1200);
  ok("hidden tab: no draws or opponent stats fetched for Kian", !api.paths.some(c => /SelectedOpponents|GetDrawsForStage.*(164472|166357|161449|153541)/.test(c)), api.paths);
  await page.evaluate(() => document.getElementById("pa-kian").scrollIntoView());
  await page.waitForTimeout(600);
  ok("hidden tab: Partners on screen still waits", !(await page.evaluate(() => !!localStorage.getItem("padel.mh.v1.1680004"))));
  await page.evaluate(() => { window.__vis = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(1500);
  ok("visible again: Kian's matches are counted", /Partners|Inga turneringsmatcher|matcher/.test(await page.textContent("#pa-kian")) && await page.evaluate(() => !!localStorage.getItem("padel.mh.v1.1680004")));
  await ctx.close();

  // ---- dark mode, 360 wide ----
  await ctx.close();
  ({ page, ctx, errors: errors2 } = await newPage({ width: 360, dark: true }));
  await page.goto(url(""));
  await page.waitForSelector("#nowList .nowrow");
  ok("360 dark: no horizontal scroll (home)", await noHScroll(page));
  await page.goto(url("#nathalie"));
  await page.waitForSelector("#p-nathalie .hero .pmed img");
  ok("360 dark: no horizontal scroll (Nathalie)", await noHScroll(page));
  await shot(page, "nathalie-dark-360");
  ok("no console errors", errors.concat(errors2).length === 0, errors.concat(errors2));
  await ctx.close();

  // ---- Veckans vinnare: the week after Järfälla (worker "wins") ----
  for (const dark of [false, true]) {
    ({ page, ctx, errors, api } = await newPage({ events: EVENTS_WEEK, over: FINAL, dark }));
    await page.goto(url("", "", "2026-09-29T10:00:00+02:00"));
    await page.waitForSelector("#secWin:not([hidden]) .wcard");
    const card = (await page.textContent("#winList .wcard")).replace(/\s+/g, " ");
    if (!dark) {
      ok("week after (tis 29 sep): Veckans vinnare shows Thea & Cassandra's Damer C win", /THEA & CASSANDRA|Thea & Cassandra/i.test(card) && /Damer C/.test(card) && /Järfälla Padel Open no 11/.test(card) && /6-1 6-4/.test(card) && /Persson \/ Bradbury/.test(card) && /sön 27 sep/.test(card), card);
      ok("week after: card links to Thea, one card, two avatars", await page.getAttribute("#winList .wcard", "href") === "#thea" && (await page.$$("#winList .wcard")).length === 1 && (await page.$$("#winList .wcard .av")).length === 2);
      ok("week after: section sits after Spelar nu, before Senaste resultat", await page.evaluate(() => { const ids = [...document.querySelectorAll("#home section")].map(x => x.id); return ids.indexOf("secWin") === ids.indexOf("secNow") + 1; }));
      ok("week after: home makes no extra RankedIn calls for it", api.ri <= 2, api.ri);
    }
    ok("week after " + (dark ? "dark" : "light") + ": no horizontal scroll at 390", await noHScroll(page));
    const el = await page.$("#secWin");
    await el.screenshot({ path: "/tmp/claude-0/-home-user-padel/e0bacc1b-df2c-5dc3-aa35-2abf1c7370b5/scratchpad/wins-" + (dark ? "dark" : "light") + ".png" }).catch(() => {});
    if (SHOTS) await el.screenshot({ path: SHOTS + "/wins-" + (dark ? "dark" : "light") + ".png" });
    // The card the week after a class win: blue holo "Veckans vinnare" with the win on a ribbon (Thea and Cassandra), metal for the rest.
    await page.goto(url("#thea", "", "2026-09-29T10:00:00+02:00"));
    await page.waitForSelector("#p-thea:not([hidden]) .hero.t-champ .pwin", { timeout: 8000 }).catch(() => {});
    { const c = await cardOf("thea");
      ok("week after " + (dark ? "dark" : "light") + ": Thea's card is the champion variant, ribbon Vann Damer C · Järfälla Padel Open no 11", /\bt-champ\b/.test(c.cls) && /^Vann Damer C · Järfälla Padel Open no 11$/.test(c.win) && c.tip === "Veckans vinnare" && c.ovr === "15.9", c); }
    { const r = await page.$eval("#p-thea .pwin .wt", e => ({ d: getComputedStyle(e).display, sw: e.scrollWidth, cw: e.clientWidth }));
      ok("week after " + (dark ? "dark" : "light") + " 390: ribbon's tournament whole or left out, never ellipsised", r.d === "none" || r.sw <= r.cw + 1, r); }
    { const g = await page.$eval("#p-thea .pname .ln", e => { const cs = getComputedStyle(e); return parseFloat(cs.paddingTop) / parseFloat(cs.fontSize); });
      ok("surname has room above the caps for Å/Ä/Ö (not clipped)", g >= 0.18, g); }
    if (dark) {
      await page.setViewportSize({ width: 360, height: 844 });
      await page.waitForTimeout(300);
      const w360 = await page.$eval("#p-thea .pwin", e => ({ wt: getComputedStyle(e.querySelector(".wt")).display, fits: e.firstElementChild.scrollWidth <= e.clientWidth + 1 }));
      ok("week after 360: ribbon shortened to Vann Damer C (no ellipsised tournament), no horizontal scroll", w360.wt === "none" && w360.fits && await noHScroll(page), w360);
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.goto(url("#cassandra", "", "2026-09-29T10:00:00+02:00"));
    await page.waitForSelector("#p-cassandra:not([hidden]) .hero");
    ok("week after: Cassandra's card is the champion variant too", /\bt-champ\b/.test((await cardOf("cassandra")).cls));
    await page.goto(url("#kian", "", "2026-09-29T10:00:00+02:00"));
    await page.waitForSelector("#p-kian:not([hidden]) .hero");
    { const c = await cardOf("kian"); ok("week after: Kian (no win) keeps bronze", /\bt-bronze\b/.test(c.cls) && !c.win && c.tip === "Nynäs Padel Club", c); }
    ok("week after " + (dark ? "dark" : "light") + ": no console errors", errors.length === 0, errors);
    await ctx.close();
  }
  ({ page, ctx, errors, api } = await newPage({ events: EVENTS_WEEK, over: FINAL, width: 360 }));
  await page.goto(url("", "", "2026-10-05T09:00:00+02:00"));
  await page.waitForSelector("#nowList .nowrow, #nowList .empty");
  await page.waitForTimeout(300);
  ok("mån 5 okt: still in Veckans vinnare", !(await page.$eval("#secWin", s => s.hidden)) && /Thea/i.test(await page.textContent("#winList")));
  ok("mån 5 okt 360: no horizontal scroll", await noHScroll(page));
  await page.goto(url("#thea", "", "2026-10-05T12:00:00+02:00"));
  await page.waitForFunction(() => /Vinnare/i.test(document.querySelector("#dyn-thea [data-r=time]")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  const heroT = await page.$eval("#dyn-thea", d => ({ time: d.querySelector("[data-r=time]").textContent, pill: d.querySelector("[data-r=pill]").textContent, link: d.querySelector("[data-r=link]").textContent }));
  ok("mån 5 okt 12:00: Thea's hero still shows VINNARE (Järfälla)", /vinnare/i.test(heroT.time) && /vinnare/i.test(heroT.pill) && /Järfälla/.test(heroT.link), heroT);
  { const c = await cardOf("thea"); ok("mån 5 okt: Thea's card is still the champion card (same week as Veckans vinnare)", /\bt-champ\b/.test(c.cls), c); }
  await page.goto(url("#thea", "", "2026-10-06T12:00:00+02:00"));
  await page.waitForTimeout(800);
  { const c = await cardOf("thea"); ok("tis 6 okt: Thea's card is back to gold, no ribbon", /\bt-gold\b/.test(c.cls) && !c.win, c); }
  await page.goto(url("#kian", "", "2026-10-05T12:00:00+02:00"));
  await page.waitForSelector("#p-kian:not([hidden]) #dyn-kian [data-r=link]");
  await page.waitForTimeout(500);
  const heroK = await page.$eval("#dyn-kian", d => d.querySelector("[data-r=link]").textContent + " | " + d.querySelector("[data-r=round]").textContent);
  ok("mån 5 okt: Kian (no win) no longer shows his Järfälla result", !/Järfälla|Herrar C/.test(heroK), heroK);
  ok("mån 5 okt: no console errors", errors.length === 0, errors);
  await ctx.close();
  ({ page, ctx, errors, api } = await newPage({ events: EVENTS_WEEK, over: FINAL }));
  await page.goto(url("", "", "2026-10-06T00:00:00+02:00"));
  await page.waitForSelector("#nowList .nowrow, #nowList .empty");
  await page.waitForTimeout(300);
  ok("tis 6 okt 00:00: Veckans vinnare gone", await page.$eval("#secWin", s => s.hidden));
  await page.goto(url("#thea", "", "2026-10-06T00:00:00+02:00"));
  await page.waitForSelector("#p-thea:not([hidden]) #dyn-thea [data-r=link]");
  await page.waitForTimeout(500);
  const heroT2 = await page.$eval("#dyn-thea", d => d.querySelector("[data-r=link]").textContent + " | " + d.querySelector("[data-r=time]").textContent);
  ok("tis 6 okt: Thea's hero moved on from Järfälla", !/Järfälla/.test(heroT2), heroT2);
  await ctx.close();

  // ---- worker down: client discovery only for the opened player ----
  ({ page, ctx, errors, api } = await newPage({ workerDown: true }));
  await page.goto(url(""));
  await page.waitForTimeout(800);
  const riHome = api.ri;
  await page.goto(url("#kian"));
  await page.waitForFunction(() => /SPL|Herrar/.test(document.querySelector("#p-kian [data-r=round]")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  ok("worker down: home makes no RankedIn discovery calls", riHome === 0, riHome);
  ok("worker down: Kian's page finds his events on RankedIn", /SPL|Herrar/.test(await page.textContent("#p-kian [data-r=round]").catch(() => "")), await page.textContent("#p-kian .dyn").catch(() => ""));
  await ctx.close();
} catch (e) {
  results.push("FAIL exception " + (e && e.stack));
} finally {
  await browser.close();
}
var errors2;
if (process.env.DEBUG) { const c = {}; (globalThis.RI_LOG || []).forEach(x => { const k = x.replace(/=\d+/g, "=N"); c[k] = (c[k] || 0) + 1; }); console.log(Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => n + " " + k).join("\n")); }
console.log(results.join("\n"));
if (results.some(r => r.startsWith("FAIL"))) process.exitCode = 1;
