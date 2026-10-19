// Notiser to given accounts' own phones (not to followers): the page links its push subscription to the logged-in
// account (POST /me/push -> KV "acctsubs" {user: [subscription keys]}; an admin's also "admsubs"). Queued with the
// americano notiser ("amx:pend", {subs, m}) and sent by the next tick (index.js fanOut).
async function kvJson(env, k, d) { try { return JSON.parse((await env.PUSH.get(k)) || "null") || d; } catch (e) { return d; } }
export async function linkSub(env, me, key) {
  for (const name of ["acctsubs", ...(me.roles.includes("admin") ? ["admsubs"] : [])]) {
    const a = await kvJson(env, name, {}), l = (a[me.id] || []).filter(x => x !== key);
    l.unshift(key); a[me.id] = l.slice(0, 5);
    await env.PUSH.put(name, JSON.stringify(a));
  }
}
async function queue(env, subs, m) {
  if (!subs.length) return;
  const q = await kvJson(env, "amx:pend", []);
  q.push({ subs, m });
  await env.PUSH.put("amx:pend", JSON.stringify(q.slice(-50)));
}
export async function notifyAdmins(env, m) { await queue(env, [...new Set(Object.values(await kvJson(env, "admsubs", {})).flat())], m); }
export async function notifyUsers(env, users, m) {
  const a = await kvJson(env, "acctsubs", {});
  await queue(env, [...new Set(users.flatMap(u => a[u] || []))], m);
}
