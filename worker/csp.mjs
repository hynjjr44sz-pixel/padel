// Content-Security-Policy of index.html: its one inline <script> is allowed by hash. Any edit of the script
// changes the hash, so this rewrites it (npm test runs it first, deploy.sh after setting PUSH_API).
//   node worker/csp.mjs           update index.html
//   node worker/csp.mjs --check   exit 1 when the hash is stale
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const file = new URL("../index.html", import.meta.url);
export function scriptHash(html) {
  const all = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (all.length !== 1) throw new Error("expected exactly one inline <script> in index.html, found " + all.length);
  return "sha256-" + createHash("sha256").update(all[0][1], "utf8").digest("base64");
}
export function withHash(html) {
  const re = /(<meta http-equiv="Content-Security-Policy" content="[^"]*script-src )'sha256-[A-Za-z0-9+/=]+'/;
  if (!re.test(html)) throw new Error("no CSP meta with a script-src hash in index.html");
  return html.replace(re, "$1'" + scriptHash(html) + "'");
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const html = readFileSync(file, "utf8"), next = withHash(html);
  if (process.argv.includes("--check")) {
    if (next !== html) { console.error("index.html: CSP script hash is stale (run node worker/csp.mjs)"); process.exit(1); }
  } else if (next !== html) { writeFileSync(file, next); console.log("index.html: CSP script hash updated"); }
}
