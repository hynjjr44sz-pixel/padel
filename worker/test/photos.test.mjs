import test from "node:test";
import assert from "node:assert/strict";
import worker, { _resetMemory } from "../src/index.js";
import { fakeD1 } from "./d1.mjs";
import { sha } from "../src/auth.js";
import { photosCheck } from "../src/photos.js";
function kv() { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) }; }
const ORIGIN = "https://padel.holmberg.st";
const call = (env, method, path, body, hd = {}) => worker.fetch(new Request("https://w" + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...hd }, body: body ? JSON.stringify(body) : undefined }), env);
async function login(db, id, pid, roles = [], kids = []) {
  const token = (id + "x".repeat(43)).slice(0, 43);
  db.db.prepare("INSERT INTO users (id, org, name, pid, created) VALUES (?, 'nynas', ?, ?, 0)").run(id, id, pid);
  for (const r of roles) db.db.prepare("INSERT INTO roles (user, org, role) VALUES (?, 'nynas', ?)").run(id, r);
  for (const k of kids) db.db.prepare("INSERT INTO guardians (user, pid) VALUES (?, ?)").run(id, k);
  db.db.prepare("INSERT INTO devices (hash, user, created, seen) VALUES (?, ?, 0, ?)").run(await sha(token), id, Date.parse("2026-10-18T00:00:00Z"));
  return { Authorization: "Bearer " + token };
}
// a JPEG start and frame header (SOF0) with the size, then filler
const jpeg = (w, h, n) => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3]), Buffer.alloc(n, 7)]).toString("base64");
const JPG = jpeg(800, 1000, 300), AV = jpeg(150, 150, 60);

test("profilbild: own, a parent's junior or the admin; served at once; the cut-out once the Action has committed it", async () => {
  _resetMemory();
  const env = { PUSH: kv(), DB: fakeD1(), NOW: "2026-10-18T10:00:00Z", ORIGIN };
  const thea = await login(env.DB, "thea", 1675246), kian = await login(env.DB, "kian", 1680004), anna = await login(env.DB, "anna", null, [], [1680004]), adm = await login(env.DB, "boss", null, ["admin"]);
  assert.equal((await call(env, "POST", "/me/photo", { pid: 1675246, jpg: JPG, av: AV })).status, 401);
  assert.equal((await call(env, "POST", "/me/photo", { pid: 1675246, jpg: JPG, av: AV }, kian)).status, 403);
  assert.equal((await call(env, "POST", "/me/photo", { pid: 1675246, jpg: "iVBOR" + "A".repeat(10), av: AV }, thea)).status, 400);   // a PNG
  assert.equal((await call(env, "POST", "/me/photo", { pid: 1675246, jpg: "/9j/" + "A".repeat(540000), av: AV }, thea)).status, 400);   // too big
  assert.equal((await call(env, "POST", "/me/photo", { pid: 1675246, jpg: jpeg(20000, 20000, 300), av: AV }, thea)).status, 400);   // a huge picture in a small file
  assert.equal((await call(env, "POST", "/me/photo", { pid: 1675246, jpg: "/9j/" + "A".repeat(400), av: AV }, thea)).status, 400);   // no frame header
  let r = await (await call(env, "POST", "/me/photo", { pid: 1675246, jpg: JPG, av: AV }, thea)).json();
  const v = r.v;
  assert.deepEqual(r.up, { 1675246: { v, cut: 0 } });
  assert.equal((await call(env, "POST", "/me/photo", { pid: 1680004, jpg: JPG, av: AV }, anna)).status, 200);   // Kian's parent
  assert.equal((await call(env, "POST", "/me/photo", { pid: 1849853, jpg: JPG, av: AV }, adm)).status, 200);    // the admin, anyone
  // served at once, by version
  let g = await call(env, "GET", "/photo/1675246.jpg?v=" + v);
  assert.equal(g.headers.get("Content-Type"), "image/jpeg");
  assert.equal((await g.arrayBuffer()).byteLength, 312);
  assert.equal(g.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal((await call(env, "GET", "/photo/1675246-av.jpg?v=" + v)).status, 200);
  assert.equal((await call(env, "GET", "/photo/1675246.jpg?v=old1")).status, 404);
  assert.equal((await call(env, "GET", "/photo/1675246.webp?v=" + v)).status, 404);
  const ev = await (await call(env, "GET", "/events")).json();
  assert.equal(ev.up[1675246].v, v);
  // the Action's list; the cron finds the committed cut-out
  const pend = await (await call(env, "GET", "/photos/pending")).json();
  assert.deepEqual(pend.pending.map(x => x.pid).sort(), [1675246, 1680004, 1849853]);
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => /raw\.githubusercontent\.com\/hynjjr44sz-pixel\/padel\/photos\/1675246-/.test(String(u)) ? new Response(o && o.method === "HEAD" ? null : "WEBP", { status: 200 }) : new Response("", { status: 404 });
  try {
    await photosCheck(env, { left: 50 });
    g = await call(env, "GET", "/photo/1675246-cut.webp?v=" + v);
    assert.deepEqual([g.status, g.headers.get("Content-Type"), await g.text()], [200, "image/webp", "WEBP"]);
  } finally { globalThis.fetch = real; }
  const idx = JSON.parse(env.PUSH.m.get("photo:index"));
  assert.deepEqual([idx[1675246].cut, idx[1680004].cut], [1, 0]);
  // removed: back to the RankedIn/club photo
  r = await (await call(env, "POST", "/me/photo", { pid: 1675246, remove: true }, thea)).json();
  assert.equal(r.up[1675246], undefined);
  assert.equal((await call(env, "GET", "/photo/1675246.jpg?v=" + v)).status, 404);
});

test("profilbild: the club members' RankedIn photos are cut out too (not the roster's, not with an own photo, not a placeholder)", async () => {
  _resetMemory();
  const env = { PUSH: kv(), DB: fakeD1(), NOW: "2026-10-18T10:00:00Z", ORIGIN };
  const CDN = "https://rankedin-prod-cdn-adavg8d3dwfegkbd.z01.azurefd.net/images/upload/player/";
  const photos = { 900001: { url: CDN + "1.png" }, 900002: { url: CDN + "2.png", placeholder: true }, 900003: { url: "https://evil.example/x.png" }, 900004: { url: CDN + "4.png" }, 1675246: { url: CDN + "t.png" } };
  const member = p => [900001, 900002, 900003, 900004].includes(Number(p));
  env.PUSH.m.set("photo:index", JSON.stringify({ 900004: { v: "abcd", cut: 0 } }));   // 900004 has uploaded their own
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => /\/photos\/r900001-[0-9a-f]{10}(-av)?\.webp$/.test(String(u)) ? new Response(o && o.method === "HEAD" ? null : "WEBP", { status: 200 }) : new Response("", { status: 404 });
  try {
    await photosCheck(env, { left: 50 }, photos, member);   // the index made; the cut-out not committed yet... found at once by the fake
  } finally { globalThis.fetch = real; }
  const ri = JSON.parse(env.PUSH.m.get("photo:ri"));
  assert.deepEqual(Object.keys(ri), ["900001"]);
  assert.match(ri[900001].v, /^[0-9a-f]{10}$/);
  assert.equal(ri[900001].cut, 1);
  const ev = await (await call(env, "GET", "/events")).json();
  assert.deepEqual(ev.ri, { 900001: ri[900001].v });
  globalThis.fetch = async u => /\/photos\/r900001-/.test(String(u)) ? new Response("WEBP", { status: 200 }) : new Response("", { status: 404 });
  try {
    const g = await call(env, "GET", "/photo/900001-rcutav.webp?v=" + ri[900001].v);
    assert.deepEqual([g.status, g.headers.get("Content-Type")], [200, "image/webp"]);
  } finally { globalThis.fetch = real; }
  assert.equal((await call(env, "GET", "/photo/900001-rcut.jpg?v=" + ri[900001].v)).status, 404);
  // a new photo on RankedIn: a new version, to be cut out again (listed for the Action with its URL)
  await photosCheck(env, { left: 0 }, { ...photos, 900001: { url: CDN + "1b.png" } }, member);
  const pend = await (await call(env, "GET", "/photos/pending")).json();
  assert.deepEqual(pend.ri.map(x => [x.pid, x.url]), [[900001, CDN + "1b.png"]]);
  assert.equal(pend.current["r900001"], pend.ri[0].v);
});
