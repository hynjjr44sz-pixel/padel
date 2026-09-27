// End-to-end against `wrangler dev --test-scheduled` (local workerd + local KV, no Cloudflare account):
// a local server plays RankedIn (fixtures) and a push service; we subscribe, fire the cron twice and
// check the push request (VAPID header, aes128gcm body we can decrypt). Run: node test/e2e-dev.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { makeSubscription, makeVapid, td } from "./helpers.mjs";
import { b64u } from "../src/webpush.js";
import { route, A } from "./fake-rankedin.mjs";

const dir = new URL("..", import.meta.url).pathname, FX = new URL("./fixtures/", import.meta.url).pathname;
const P = +(process.env.E2E_PORT || 18787), W = P + 1;   // E2E_PORT: run next to another copy
let fixture = "dc_1031.json";   // file name, or a draw object (served as JSON)
// Damer C starts without a published draw (class list): the draw check (PUB_MINUTE=0) records "0" on the first cron
const unpublished = A("t66374_classnames_draws").map(x => x.Id === 164681 ? { ...x, TournamentDraws: [] } : x);
const over = { "/tournament/GetClassesAndDrawNamesAsync/?tournamentId=66374": unpublished };
const pushes = [], fixtureHits = [], apiHits = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/rankedin") {
    res.setHeader("Content-Type", "application/json");
    if (u.searchParams.get("classId") !== "164681") return res.end("[]");   // other live classes: no draw
    fixtureHits.push(u.search); return res.end(typeof fixture === "string" ? readFileSync(FX + fixture) : JSON.stringify(fixture));
  }
  if (u.pathname.startsWith("/api/")) {   // discovery: the fake RankedIn API
    apiHits.push(u.pathname);
    const body = route(req.url.slice(4), over);
    res.statusCode = body == null ? 404 : 200; res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(body ?? {}));
  }
  if (u.pathname.startsWith("/push/")) {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => { pushes.push({ path: u.pathname, headers: req.headers, body: new Uint8Array(Buffer.concat(chunks)) }); res.statusCode = u.pathname === "/push/gone" ? 410 : 201; res.end(); });
    return;
  }
  res.statusCode = 404; res.end();
});
await new Promise(r => srv.listen(P, "127.0.0.1", r));

const v = await makeVapid();
writeFileSync(dir + ".dev.vars", [
  "VAPID_PUBLIC_KEY=" + v.VAPID_PUBLIC_KEY, "VAPID_PRIVATE_KEY='" + v.VAPID_PRIVATE_KEY + "'", "PUSH_HOST_ANY=1",
  "FIXTURE_URL=http://127.0.0.1:" + P + "/rankedin?classId={classId}&stage={stage}", "API_BASE=http://127.0.0.1:" + P + "/api", "NOW=2026-09-27T12:00:00+02:00", "PUB_MINUTE=0"].join("\n") + "\n");
const persist = mkdtempSync(join(tmpdir(), "padel-kv-"));
const wr = spawn("npx", ["wrangler", "dev", "--test-scheduled", "--port", String(W), "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false"],
  { cwd: dir, stdio: ["ignore", "pipe", "pipe"], detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
let log = "";
wr.stdout.on("data", d => { log += d; }); wr.stderr.on("data", d => { log += d; });
const base = "http://127.0.0.1:" + W;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = (name, cond, info) => { if (process.env.DEBUG) console.error(cond ? "ok" : "FAIL", name); results.push((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(info))); };
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch (e) {} await sleep(500); }
  const h = await (await fetch(base + "/health")).json();
  ok("health: Damer C active (NOW)", h.ok && h.active.includes("Damer C"), h);
  const vk = await (await fetch(base + "/vapid", { headers: { Origin: "http://localhost:8765" } })).json();
  ok("vapid key served", vk.key === v.VAPID_PUBLIC_KEY, vk);

  const a = await makeSubscription("http://127.0.0.1:" + P + "/push/a"), gone = await makeSubscription("http://127.0.0.1:" + P + "/push/gone");
  // cas follows Cassandra (Thea's partner in Damer C): same news; kian follows Kian only: nothing from Damer C
  const cas = await makeSubscription("http://127.0.0.1:" + P + "/push/cas"), kian = await makeSubscription("http://127.0.0.1:" + P + "/push/kian");
  for (const [s, prefs] of [[a, { thea: true, kian: true }], [gone, { thea: true, kian: true }], [cas, { follow: [1849853] }], [kian, { follow: [1680004] }]]) {
    const r = await fetch(base + "/subscribe", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:8765" },
      body: JSON.stringify({ subscription: s.sub, prefs }) });
    ok("subscribe " + s.sub.endpoint.split("/").pop(), r.status === 200 && r.headers.get("access-control-allow-origin") === "http://localhost:8765", r.status);
  }

  const cron = () => fetch(base + "/__scheduled?cron=" + encodeURIComponent("* * * * *"));
  await cron(); await sleep(1500);
  ok("baseline tick: RankedIn fetched, no push", fixtureHits.length === 1 && pushes.length === 0, { fixtureHits, pushes: pushes.length });
  ok("first tick ran discovery against the (fake) RankedIn API", apiHits.some(x => /ParticipatedEventsAsync/.test(x)) && apiHits.length <= 45, apiHits.length);
  const evs = await (await fetch(base + "/events", { headers: { Origin: "http://localhost:8765" } })).json();
  ok("GET /events: discovered tournaments and SPL play days (+ past list)", evs.src === "worker" && Array.isArray(evs.past) && evs.events.some(e => e.key === "t173729-thea") && evs.events.some(e => e.kind === "teamleague" && e.who === "kian"), evs.events.map(e => e.key));
  ok("GET /events: roster players (Cassandra in Damer C), one SPL entry per team day, live view", evs.events.some(e => e.key === "t164681-cassandra") &&
    new Set(evs.events.map(e => e.key)).size === evs.events.length && evs.live && evs.live["1675246"] && evs.live["1675246"].st === "next", { keys: evs.events.map(e => e.key), live: evs.live });
  fixture = "dc_1112.json";
  delete over["/tournament/GetClassesAndDrawNamesAsync/?tournamentId=66374"];   // the draw is out
  await cron();
  for (let i = 0; i < 40 && pushes.length < 5; i++) await sleep(250);
  for (let i = 0; i < 20 && pushes.length < 5; i++) await sleep(250);
  const toA = pushes.filter(p => p.path === "/push/a"), toGone = pushes.filter(p => p.path === "/push/gone");
  ok("2 pushes to the live subscription (draw published + next opponent)", toA.length === 2, pushes.map(p => p.path));
  const toCas = pushes.filter(p => p.path === "/push/cas");
  const casMsgs = await Promise.all(toCas.map(async x => JSON.parse(await cas.decrypt(x.body)).title));
  ok("follow Cassandra: the same 2 notiser (her pair), once each", casMsgs.length === 2 && casMsgs[1] === "Thea och Cassandra möter Pettersson Österberg / Ekeland", casMsgs);
  ok("follow Kian only: nothing from Damer C", !pushes.some(p => p.path === "/push/kian"), pushes.map(p => p.path));
  ok("1 push to the 410 subscription, then dropped", toGone.length === 1, toGone.length);
  const p = toA[0];
  if (p) {
    const auth = p.headers.authorization || "", m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(auth);
    ok("Authorization: vapid t=..., k=...", !!m && m[2] === v.VAPID_PUBLIC_KEY, auth);
    if (m) {
      const [hd, cl, sig] = m[1].split("."), claims = JSON.parse(td.decode(b64u.dec(cl)));
      ok("JWT aud = push origin, sub = site", claims.aud === "http://127.0.0.1:" + P && claims.sub === "https://padel.holmberg.st", claims);
      ok("JWT signature verifies", await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, v.verifyKey, b64u.dec(sig), new TextEncoder().encode(hd + "." + cl)));
    }
    ok("Content-Encoding: aes128gcm", p.headers["content-encoding"] === "aes128gcm", p.headers);
    ok("TTL 3600, Urgency high, Topic", p.headers.ttl === "3600" && p.headers.urgency === "high" && /^[\w-]{1,32}$/.test(p.headers.topic || ""), p.headers);
    const msgs = await Promise.all(toA.map(async x => JSON.parse(await a.decrypt(x.body))));
    ok("decrypted payloads", msgs.map(x => x.title).join(" | ") ===
      "Lottningen klar: Thea och Cassandra möter Pettersson Österberg / Ekeland | Thea och Cassandra möter Pettersson Österberg / Ekeland", msgs);
    ok("tags + deep links", msgs[0].tag === "padel-164681:lottning" && msgs[0].url === "./#thea/m6872156" &&
      msgs[1].tag === "padel-164681:opp:m6872156:6440356" && msgs[1].url === "./#thea/m6872156", msgs);
  }
  // The quarterfinal moves: "Ny tid" for Thea's next match
  const moved = JSON.parse(readFileSync(FX + "dc_1112.json"));
  moved.forEach(dr => dr.Elimination && dr.Elimination.DrawData.forEach(col => (col || []).forEach(c => { if (c && c.MatchId === 6872156) { c.Date = "2026-09-27T13:15:00"; c.CourtName = "Bana 2"; } })));
  fixture = moved;
  const n0 = pushes.length;
  await cron();
  for (let i = 0; i < 40 && pushes.length < n0 + 2; i++) await sleep(250);
  const tm = pushes.slice(n0).filter(x => x.path === "/push/a");
  const tmsg = tm.length ? JSON.parse(await a.decrypt(tm[0].body)) : {};
  ok("time change pushed once", tm.length === 1 && tmsg.title === "Ny tid: Thea och Cassandra spelar kvartsfinalen 13:15, Bana 2" && tmsg.url === "./#thea/m6872156" && tmsg.tag === "padel-164681:tid:m6872156", tmsg);
  const n = pushes.length;
  await cron(); await sleep(1500);
  ok("same data again: no pushes", pushes.length === n, pushes.length - n);
  fixture = "dc_wins_qf.json";
  await cron();
  for (let i = 0; i < 40 && pushes.length < n + 3; i++) await sleep(250);
  const later = pushes.slice(n);
  const laterA = later.filter(x => x.path === "/push/a");
  ok("dropped subscription gets nothing", later.every(x => x.path !== "/push/gone") && later.some(x => x.path === "/push/a"), later.map(x => x.path));
  const last = laterA.length ? JSON.parse(await a.decrypt(laterA.at(-1).body)) : {};
  ok("Thea's QF win pushed", last.title === "Thea och Cassandra vann kvartsfinalen 6-2 7-5", last);
} catch (e) {
  results.push("FAIL exception " + e.stack);
} finally {
  try { process.kill(-wr.pid, "SIGTERM"); } catch (e) { wr.kill("SIGTERM"); }   // npx + wrangler + workerd
  srv.close();
  rmSync(dir + ".dev.vars", { force: true });
  rmSync(persist, { recursive: true, force: true });
}
console.log(results.join("\n"));
if (results.some(r => r.startsWith("FAIL"))) { console.log("\n--- wrangler log ---\n" + log.slice(-4000)); process.exitCode = 1; }
