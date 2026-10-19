import test from "node:test";
import assert from "node:assert/strict";
import { parseCenter, centerRun } from "../src/center.js";

const occ = (t, d, n, max, id, price = 125) => `<tr class="activity-occasion "><td><div><strong>${t}</strong><br><small>${d}</small></div></td>
  <td><span class="participation badge" title="Number of signed participants / total seats"><span><i class="far fa-user-friends" style="margin-right: 4px"></i>${n}/${max}</span></span></td>
  <td><div><strong>${price} SEK</strong></div></td><td><a href="/login/auth?returnUrl=%2Factivities%2Fsearch%3Fid%3D${id}">Book</a></td></tr>`;
const act = (aid, name, rows) => `<li class="activity-item"><a name="ClassActivity-${aid}"></a><div class="row"><div class="col-sm-4"><h4 class="no-top-margin">${name}</h4>
  <div class="description">Alla välkomna</div></div><div class="col-sm-8"><table class="table activity-occasions">${rows.join("")}</table></div></div></li>`;
const PAGE = "<html><ul>" +
  act(25048, "Lunchpadel tisdagar (Blandad nivå)", [occ("11:30 - 13:00", "2026-10-20", 4, 4, 1), occ("11:30 - 13:00", "2026-10-20", 2, 4, 2), occ("11:30 - 13:00", "2026-10-27", 0, 4, 3)]) +
  act(34387, "Clinic &amp; spel &#34;C-nivå&#34;", [occ("14:30 - 16:00", "2026-10-19", 5, 12, 4, 250), occ("14:30 - 16:00", "2026-10-18", 1, 12, 5), occ("09:00 - 10:00", "2026-11-20", 0, 8, 6)]) +
  "</ul></html>";

test("på centret: the facility page's activities from today and two weeks on, balls at the same time added up", () => {
  assert.deepEqual(parseCenter(PAGE, "2026-10-19"), [
    { id: 34387, name: 'Clinic & spel "C-nivå"', d: "2026-10-19", t1: "14:30", t2: "16:00", n: 5, max: 12, price: 250 },
    { id: 25048, name: "Lunchpadel tisdagar (Blandad nivå)", d: "2026-10-20", t1: "11:30", t2: "13:00", n: 6, max: 8, price: 125 },
    { id: 25048, name: "Lunchpadel tisdagar (Blandad nivå)", d: "2026-10-27", t1: "11:30", t2: "13:00", n: 0, max: 4, price: 125 },
  ]);
  assert.deepEqual(parseCenter("<html>nothing</html>", "2026-10-19"), []);
});

test("på centret: the hourly run writes only on a change and keeps the last list when the page has none", async () => {
  const m = new Map(), env = { PUSH: { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const real = globalThis.fetch;
  let body = PAGE, puts = 0;
  const put = env.PUSH.put; env.PUSH.put = async (k, v) => { puts++; return put(k, v); };
  globalThis.fetch = async u => { assert.match(String(u), /matchi\.se\/facilities\/nynashamnpadelcenter$/); return new Response(body); };
  try {
    const b = { left: 45 };
    let r = await centerRun(env, new Date("2026-10-19T08:37:00Z"), b);
    assert.equal(r.list.length, 3); assert.equal(b.left, 44); assert.equal(puts, 1);
    await centerRun(env, new Date("2026-10-19T09:37:00Z"), b);
    assert.equal(puts, 1);   // unchanged
    body = "<html>changed</html>";
    r = await centerRun(env, new Date("2026-10-19T10:37:00Z"), b);
    assert.equal(r.list.length, 3); assert.equal(puts, 1);
    assert.equal(await centerRun(env, new Date("2026-10-19T11:37:00Z"), { left: 1 }), null);   // no budget
  } finally { globalThis.fetch = real; }
});
