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
_resetMemory();
await tick({ PUSH, NOW: "2026-09-27T11:52:00Z", ORIGIN: "x", RANK_OFF: "1" });
const EVENTS = await (await worker.fetch(new Request("https://w/events"), { PUSH, NOW: "2026-09-27T11:52:00Z", ORIGIN: "x" })).json();
globalThis.fetch = realFetch;
assert.ok(EVENTS.live["1675246"], "worker live view for Thea");

// What the page reads besides the discovery (ranking, skill, profile, SPL table): made up from players.json.
const ROSTER = JSON.parse(readFileSync(new URL("../../players.json", import.meta.url), "utf8"));
function pageApi(path, over) {
  const u = new URL("https://x" + path), q = k => u.searchParams.get(k), p = u.pathname.toLowerCase();
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

const results = [];
const ok = (name, cond, info) => { results.push((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(info))); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    colorScheme: opts.dark ? "dark" : "light", serviceWorkers: "block" });
  await ctx.grantPermissions(["notifications"], { origin: new URL(BASE).origin });
  const page = await ctx.newPage();
  const errors = [], api = { ri: 0, posts: [] };
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(String(e)));
  await page.route("https://api.rankedin.com/**", r => {
    api.ri++;
    const u = r.request().url(), body = pageApi(u.slice("https://api.rankedin.com/v1".length), opts.over || {});
    if (process.env.DEBUG) (globalThis.RI_LOG = globalThis.RI_LOG || []).push((body == null ? "404 " : "200 ") + u.slice(27).split("&language")[0]);
    return r.fulfill({ status: body == null ? 404 : 200, contentType: "application/json", body: JSON.stringify(body ?? {}), headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route(PUSH_API + "/**", r => {
    const u = new URL(r.request().url()), h = { "Access-Control-Allow-Origin": "*" };
    if (u.pathname === "/events") return opts.workerDown ? r.fulfill({ status: 503, body: "{}", headers: h }) : r.fulfill({ contentType: "application/json", body: JSON.stringify(EVENTS), headers: h });
    if (u.pathname === "/vapid") return r.fulfill({ contentType: "application/json", body: JSON.stringify({ key: "BOr5MaD1vP9w2uH0Pqzv8pH5v2cXf8j8e7Rrx6Qv0yq2mS9d2w8g5k2WnYQx1S0x0gJ5v8wV0z9Q2v5cXf8j8e7R", classes: [164681] }), headers: h });
    if (u.pathname === "/subscribe" || u.pathname === "/unsubscribe") { api.posts.push({ path: u.pathname, body: JSON.parse(r.request().postData() || "{}") }); return r.fulfill({ contentType: "application/json", body: "{\"ok\":true}", headers: h }); }
    return r.fulfill({ status: 404, body: "{}", headers: h });
  });
  // Push without a push service: a fake subscription, so the page's /subscribe calls can be checked.
  await page.addInitScript(() => {
    window.__notes = [];
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
const url = (h, extra = "") => BASE + "?t=" + encodeURIComponent(T) + extra + h;
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
  ok("home: two team cards with roster avatars", (await page.$$eval("#teams .tcard", c => c.map(x => x.querySelectorAll(".troster li").length))).join() === "6,7");
  ok("home: player list with all 13", (await page.$$("#plist li")).length === 13);
  await page.fill("#q", "sved");
  ok("home: search filters (sved -> Anton Svedman, Svante Svedberg)", (await page.$$eval("#plist b", b => b.map(x => x.textContent))).sort().join() === "Anton Svedman,Svante Svedberg");
  await page.fill("#q", "");
  ok("home: no horizontal scroll at 390", await noHScroll(page));
  ok("home: at most a handful of RankedIn calls on load", api.ri <= 2, api.ri);
  await shot(page, "home");

  // ---- player with photo (Thea): live view, deep link ----
  await page.goto(url("#thea/m6872156"));
  await page.waitForSelector('#p-thea [data-mid="6872156"]');
  await page.waitForTimeout(600);
  ok("deep link #thea/m6872156: Thea's page, match flashed", await page.$eval('#p-thea [data-mid="6872156"]', e => e.classList.contains("flash") || !!e.closest("#p-thea:not([hidden])")));
  ok("Thea: hero photo", await page.$eval("#p-thea .hero img", i => i.getAttribute("src")) === "img/thea.jpg");
  ok("Thea: chips show followed first and Thea current", (await page.$$eval("#chips .pchip", a => a.map(x => x.getAttribute("href") + (x.getAttribute("aria-current") ? "*" : "")))).slice(0, 2).join() === "#thea*,#kian");
  ok("Thea: trend numbers", /#\d+/.test(await page.textContent("#tv-thea-rank")));
  await shot(page, "thea");

  // ---- player without photo (Lisa): initials hero, no broken image ----
  await page.goto(url("#lisa"));
  await page.waitForSelector("#p-lisa .hero.noimg .ini-big");
  ok("Lisa: initials hero (LB), no img", (await page.textContent("#p-lisa .ini-big")) === "LB" && (await page.$$("#p-lisa .hero img")).length === 0);
  ok("Lisa: back to Nynäs idag", await page.isVisible("#pnav .back"));
  const broken = await page.$$eval("img", im => im.filter(i => i.complete && i.naturalWidth === 0 && i.getAttribute("src")).map(i => i.getAttribute("src")));
  ok("no broken images", broken.length === 0, broken);
  ok("Lisa: no horizontal scroll", await noHScroll(page));
  await shot(page, "lisa");

  // ---- Cassandra (photo, no avatar): her own Damer C entry from the worker ----
  await page.goto(url("#cassandra"));
  await page.waitForSelector("#p-cassandra .hero img");
  await page.waitForFunction(() => /Damer C/.test(document.querySelector("#p-cassandra [data-r=round]")?.textContent || ""));
  ok("Cassandra: live Damer C view with Thea as partner", /Thea|Holmberg/.test(await page.textContent("#p-cassandra .vs")));
  await shot(page, "cassandra");

  // ---- old #kian link ----
  await page.goto(url("#kian"));
  await page.waitForSelector("#p-kian:not([hidden]) .hero img");
  ok("old #kian link opens Kian", (await page.title()).startsWith("Kian Borgström"));

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

  // ---- dark mode, 360 wide ----
  await ctx.close();
  ({ page, ctx, errors: errors2 } = await newPage({ width: 360, dark: true }));
  await page.goto(url(""));
  await page.waitForSelector("#nowList .nowrow");
  ok("360 dark: no horizontal scroll (home)", await noHScroll(page));
  await page.goto(url("#nathalie"));
  await page.waitForSelector("#p-nathalie .hero img");
  ok("360 dark: no horizontal scroll (Nathalie)", await noHScroll(page));
  await shot(page, "nathalie-dark-360");
  ok("no console errors", errors.concat(errors2).length === 0, errors.concat(errors2));
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
