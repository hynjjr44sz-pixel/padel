// "På centret": Nynäshamn Padelcenter's activities on MATCHi (lunchpadel, clinics, courses), from the facility's public
// page: name, day, time, signed/seats and price. No login and no names (who is signed up shows only to MATCHi users).
// Read once an hour into KV "center" {at, list: [{id, oid (the occasion, for booking), name, d, t1, t2, n, max, price}]};
// GET /events "center".
export const CENTER_URL = "https://www.matchi.se/facilities/nynashamnpadelcenter";
const DAY = 864e5;
const text = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&#34;|&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

// The facility page -> the occasions from today (YYYY-MM-DD) and the next 14 days, by day and time. One activity can have
// several balls at the same time (two courts of lunchpadel): one row, the seats added up.
export function parseCenter(html, today) {
  const out = new Map(), end = new Date(Date.parse(today + "T00:00:00Z") + 14 * DAY).toISOString().slice(0, 10);
  for (const item of String(html || "").split('<li class="activity-item">').slice(1)) {
    const name = text((/<h4[^>]*>([\s\S]*?)<\/h4>/.exec(item) || [])[1]).slice(0, 80);
    const aid = (/name="ClassActivity-(\d+)"/.exec(item) || [])[1];
    if (!name) continue;
    for (const row of item.split('<tr class="activity-occasion').slice(1)) {
      const tm = /(\d\d:\d\d)\s*-\s*(\d\d:\d\d)/.exec(row), d = (/<small>(\d{4}-\d\d-\d\d)<\/small>/.exec(row) || [])[1];
      const seats = /<\/i>\s*(\d+)\s*\/\s*(\d+)\s*</.exec(row), price = /<strong>\s*(\d+)\s*SEK\s*<\/strong>/.exec(row);
      const oid = Number((/loginBeforeBooking\(this\.href,\s*(?:&#39;|')(\d+)/.exec(row) || /id%3D(\d+)/.exec(row) || [])[1]) || null;
      if (!tm || !d || !seats || d < today || d > end) continue;
      const k = name + "|" + d + "|" + tm[1], was = out.get(k);
      // the occasion to book: the first with a free seat
      if (was) { if (was.n >= was.max && +seats[1] < +seats[2] && oid) was.oid = oid; was.n += +seats[1]; was.max += +seats[2]; continue; }
      out.set(k, { id: aid ? Number(aid) : null, oid, name, d, t1: tm[1], t2: tm[2], n: +seats[1], max: +seats[2], price: price ? +price[1] : null });
    }
  }
  return [...out.values()].sort((a, b) => (a.d + a.t1).localeCompare(b.d + b.t1) || a.name.localeCompare(b.name)).slice(0, 60);
}

export async function loadCenter(env) {
  try { return JSON.parse((await env.PUSH.get("center")) || "null"); } catch (e) { return null; }
}
// Cron: once an hour (one subrequest); written only when something changed (free KV: 1000 writes a day)
export async function centerRun(env, t, budget) {
  if (budget.left < 2) return null;
  budget.left--;
  const r = await fetch(CENTER_URL, { headers: { "User-Agent": "Mozilla/5.0 (padel.holmberg.st)", "Accept-Language": "sv" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("MATCHi HTTP " + r.status);
  const list = parseCenter(await r.text(), t.toISOString().slice(0, 10)), old = await loadCenter(env);
  if (!list.length && old && old.list && old.list.length) return old;   // the page changed or failed: keep the last one
  const rec = { at: t.toISOString(), list };
  if (!old || JSON.stringify(old.list) !== JSON.stringify(list)) await env.PUSH.put("center", JSON.stringify(rec));
  return rec;
}
