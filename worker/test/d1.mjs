// A D1 stand-in for tests (node:sqlite, in memory) with the parts of the API auth.js uses; schema.sql applied.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    _run: () => db.prepare(sql).run(...args),
  });
  return {
    db,
    prepare: sql => stmt(sql),
    batch: async list => { db.exec("BEGIN"); try { const out = list.map(s => s._run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
}
// A logged-in arrangör in db -> the Authorization header
import { sha } from "../src/auth.js";
export async function arrHeader(db, roles = ["arr"]) {
  const token = "T".repeat(43), id = "arrtest";
  if (!db.db.prepare("SELECT id FROM users WHERE id = ?").get(id)) {
    db.db.prepare("INSERT INTO users (id, org, name, pid, created) VALUES (?, 'nynas', 'Arr Test', NULL, 0)").run(id);
    for (const r of roles) db.db.prepare("INSERT INTO roles (user, org, role) VALUES (?, 'nynas', ?)").run(id, r);
    db.db.prepare("INSERT INTO devices (hash, user, label, created, seen) VALUES (?, ?, NULL, 0, 0)").run(await sha(token), id);
  }
  return { Authorization: "Bearer " + token };
}
