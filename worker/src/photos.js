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
  if (!isJpeg(b.jpg) || !isJpeg(b.av) || b64bytes(b.jpg) > MAX_JPG || b64bytes(b.av) > MAX_AV) return { err: "bad image", status: 400 };
  const v = t.toString(36);
  await env.PUSH.put("photo:" + pid, JSON.stringify({ v, jpg: b.jpg, av: b.av, by: me.id, at: t }));
  idx[pid] = { v, cut: 0 };
  await env.PUSH.put("photo:index", JSON.stringify(idx));
  return { ok: true, v, up: idx };
}

// GET /photo/<pid>.jpg | -av.jpg (KV) | -cut.webp | -cutav.webp (the branch "photos"), ?v= the version
export async function photoGet(env, pid, kind, v) {
  if (!V_RE.test(v || "")) return null;
  const imm = { "Cache-Control": "public, max-age=31536000, immutable" };
  if (kind === "cut" || kind === "cutav") {
    const r = await fetch(RAW + pid + "-" + v + (kind === "cutav" ? "-av" : "") + ".webp", { cf: { cacheTtl: 86400, cacheEverything: true }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return new Response(r.body, { headers: { "Content-Type": "image/webp", ...imm } });
  }
  let x = null;
  try { x = JSON.parse(await env.PUSH.get("photo:" + pid)); } catch (e) {}
  if (!x || x.v !== v) return null;
  return new Response(dec(kind === "av" ? x.av : x.jpg), { headers: { "Content-Type": "image/jpeg", ...imm } });
}

// GET /photos/pending: for the Action {pending: [{pid, v}], current: {pid: v}}
export async function photosPending(env) {
  const idx = await photoIndex(env);
  return { pending: Object.keys(idx).filter(p => !idx[p].cut).map(p => ({ pid: Number(p), v: idx[p].v })), current: Object.fromEntries(Object.keys(idx).map(p => [p, idx[p].v])) };
}
// Cron: a cut-out committed by the Action -> cut: 1 (at most 4 checks a run)
export async function photosCheck(env, budget) {
  const idx = await photoIndex(env);
  let changed = false;
  for (const p of Object.keys(idx).filter(p => !idx[p].cut).slice(0, 4)) {
    if (budget && budget.left < 3) break;
    if (budget) budget.left--;
    try {
      const r = await fetch(RAW + p + "-" + idx[p].v + "-av.webp", { method: "HEAD", signal: AbortSignal.timeout(8000) });
      if (r.ok) { idx[p].cut = 1; changed = true; }
    } catch (e) {}
  }
  if (changed) await env.PUSH.put("photo:index", JSON.stringify(idx));
  return changed;
}
