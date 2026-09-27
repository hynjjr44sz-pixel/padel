// players.json (repo root) is the roster: this copies the fields the worker needs into src/players.js.
// Run by `npm test` (pretest) and deploy.sh; test/players.test.mjs fails when the two drift apart.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../players.json", import.meta.url), out = new URL("./src/players.js", import.meta.url);
const FIELDS = ["key", "pid", "name", "short", "gender", "rt", "ag", "rid", "team", "teamId", "league", "division"];
export function render(list) {
  const rows = list.map(p => "  " + JSON.stringify(Object.fromEntries(FIELDS.map(k => [k, p[k] ?? null]))));
  return "// Generated from players.json by sync-players.mjs. Do not edit by hand.\nexport default [\n" + rows.join(",\n") + "\n];\n";
}
if (import.meta.url === "file://" + process.argv[1]) {
  const text = render(JSON.parse(readFileSync(root, "utf8")));
  let old = "";
  try { old = readFileSync(out, "utf8"); } catch (e) {}
  if (old !== text) { writeFileSync(out, text); console.log("src/players.js updated"); }
}
