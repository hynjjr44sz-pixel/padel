// Own profile pictures. A logged-in player (or a parent for their junior, or the admin) uploads a photo cropped on the
// phone: hero 800x1000 and avatar 150x150, both JPEG. Kept in KV ("photo:<pid>", "photo:index" {pid: {v, cut}}) and
// shown at once. The GitHub Action photos.yml takes GET /photos/pending, removes the background (rembg) and commits
// <pid>-<v>.webp and <pid>-<v>-av.webp to the branch "photos"; the cron sees them there (cut: 1) and the app switches
// to the cut-out, served through GET /photo/<pid>-cut.webp?v= (and -cutav).
const RAW = "https://raw.githubusercontent.com/hynjjr44sz-pixel/padel/photos/";
const MAX_JPG = 400000, MAX_AV = 50000, V_RE = /^[a-z0-9]{4,12}$/;
const b64bytes = s => Math.floor(s.length * 3 / 4);
const isJpeg = s => typeof s === "string" && /^\/9j\/[A-Za-z0-9+/]+=*$/.test(s);
const dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
// A JPEG's size from its frame header (SOF0-SOF15 but DHT/JPG/DAC), or null when it is no JPEG we can read
export function jpegSize(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xFF) return null;
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  return null;
}
// the phone sends 800x1000 and 150x150; a little room, but no huge picture packed into a small file
const sizeOk = (b64, maxW, maxH) => { try { const z = jpegSize(dec(b64)); return !!z && z.w > 0 && z.h > 0 && z.w <= maxW && z.h <= maxH; } catch (e) { return false; } };

export async function photoIndex(env) {
  try { return JSON.parse((await env.PUSH.get("photo:index")) || "{}") || {}; } catch (e) { return {}; }
}
export const canPhoto = (me, pid) => !!me && (me.roles.includes("admin") || me.pid === pid || (me.kids || []).includes(pid));

// POST /me/photo {pid, jpg, av} (base64 JPEG) | {pid, remove: true}
export async function photoSet(env, me, b, byPid, t) {
  const pid = Number(b && b.pid);
  if (!byPid.has(pid)) return { err: "unknown player", status: 400 };
  if (!canPhoto(me, pid)) return { err: "forbidden", status: 403 };
  const idx = await photoIndex(env);
  if (b.remove) {
    delete idx[pid];
    await env.PUSH.delete("photo:" + pid);
    await env.PUSH.put("photo:index", JSON.stringify(idx));
    return { ok: true, up: idx };
  }
  if (!isJpeg(b.jpg) || !isJpeg(b.av) || b64bytes(b.jpg) > MAX_JPG || b64bytes(b.av) > MAX_AV || !sizeOk(b.jpg, 1000, 1250) || !sizeOk(b.av, 300, 300)) return { err: "bad image", status: 400 };
  const v = t.toString(36);
  await env.PUSH.put("photo:" + pid, JSON.stringify({ v, jpg: b.jpg, av: b.av, by: me.id, at: t }));
  idx[pid] = { v, cut: 0 };
  await env.PUSH.put("photo:index", JSON.stringify(idx));
  return { ok: true, v, up: idx };
}

// RankedIn profile photos of the club members shown (no photo uploaded in the app; the roster's players have their own
// cut-outs made by hand): cut out by the same Action, committed as r<pid>-<v>.webp and r<pid>-<v>-av.webp. KV "photo:ri"
// {pid: {v, url, cut}}; v from the RankedIn URL, so a new photo there is cut out again.
const RI_IMG = /^https:\/\/(cdn\.rankedin\.com|rankedin-prod-cdn-[a-z0-9]+\.[a-z0-9]+\.azurefd\.net)\/[^\s"'<>]{1,400}$/;
export async function riIndex(env) {
  try { return JSON.parse((await env.PUSH.get("photo:ri")) || "{}") || {}; } catch (e) { return {}; }
}
async function vOf(url) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
  return [...h.slice(0, 5)].map(b => b.toString(16).padStart(2, "0")).join("");
}
// The members' photos (discovery's {pid: {url, placeholder}}) -> the index; returns it (written only when changed)
export async function riSync(env, photos, isMember) {
  const idx = await riIndex(env), up = await photoIndex(env), next = {};
  for (const [p, x] of Object.entries(photos || {})) {
    if (!isMember(p) || up[p] || !x || x.placeholder || !RI_IMG.test(x.url || "")) continue;
    const v = await vOf(x.url), was = idx[p];
    next[p] = was && was.v === v ? was : { v, url: x.url, cut: 0 };
  }
  if (JSON.stringify(next) !== JSON.stringify(idx)) await env.PUSH.put("photo:ri", JSON.stringify(next));
  return next;
}
// For the page (GET /events "ri"): {pid: v} of the cut-outs ready
export const riOut = idx => Object.fromEntries(Object.entries(idx).filter(([, x]) => x.cut).map(([p, x]) => [p, x.v]));

// GET /photo/<pid>.jpg | -av.jpg (KV) | -cut.webp | -cutav.webp | -rcut.webp | -rcutav.webp (the branch "photos"), ?v= the version
export async function photoGet(env, pid, kind, v) {
  if (!V_RE.test(v || "")) return null;
  const imm = { "Cache-Control": "public, max-age=31536000, immutable" };
  if (kind === "cut" || kind === "cutav" || kind === "rcut" || kind === "rcutav") {
    const r = await fetch(RAW + (kind[0] === "r" ? "r" : "") + pid + "-" + v + (kind.endsWith("av") ? "-av" : "") + ".webp", { cf: { cacheTtl: 86400, cacheEverything: true }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return new Response(r.body, { headers: { "Content-Type": "image/webp", ...imm } });
  }
  let x = null;
  try { x = JSON.parse(await env.PUSH.get("photo:" + pid)); } catch (e) {}
  if (!x || x.v !== v) return null;
  return new Response(dec(kind === "av" ? x.av : x.jpg), { headers: { "Content-Type": "image/jpeg", ...imm } });
}

// GET /photos/pending: for the Action {pending: [{pid, v}], ri: [{pid, v, url}], current: {pid | "r"pid: v}}
export async function photosPending(env) {
  const idx = await photoIndex(env), ri = await riIndex(env);
  return { pending: Object.keys(idx).filter(p => !idx[p].cut).map(p => ({ pid: Number(p), v: idx[p].v })),
    ri: Object.keys(ri).filter(p => !ri[p].cut).slice(0, 15).map(p => ({ pid: Number(p), v: ri[p].v, url: ri[p].url })),
    current: Object.fromEntries(Object.keys(idx).map(p => [p, idx[p].v]).concat(Object.keys(ri).map(p => ["r" + p, ri[p].v]))) };
}
// Cron: a cut-out committed by the Action -> cut: 1 (at most 4 checks a run, own photos first). photos, isMember: the
// members' RankedIn photos (riSync) when given.
export async function photosCheck(env, budget, photos, isMember) {
  const idx = await photoIndex(env), ri = photos ? await riSync(env, photos, isMember) : await riIndex(env);
  const todo = Object.keys(idx).filter(p => !idx[p].cut).map(p => ["", p, idx]).concat(Object.keys(ri).filter(p => !ri[p].cut).map(p => ["r", p, ri])).slice(0, 4);
  let changed = 0;
  for (const [pre, p, x] of todo) {
    if (budget && budget.left < 3) break;
    if (budget) budget.left--;
    try {
      const r = await fetch(RAW + pre + p + "-" + x[p].v + "-av.webp", { method: "HEAD", signal: AbortSignal.timeout(8000) });
      if (r.ok) { x[p].cut = 1; changed |= pre ? 2 : 1; }
    } catch (e) {}
  }
  if (changed & 1) await env.PUSH.put("photo:index", JSON.stringify(idx));
  if (changed & 2) await env.PUSH.put("photo:ri", JSON.stringify(ri));
  return !!changed;
}
