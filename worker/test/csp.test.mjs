import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scriptHash } from "../csp.mjs";

test("index.html: the CSP allows its one inline script by hash; no inline handlers", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  assert.ok(csp, "CSP meta");
  assert.ok(csp[1].includes("script-src '" + scriptHash(html) + "'"), "hash current (node worker/csp.mjs)");
  assert.ok(!/<[^>]+\son[a-z]+=/i.test(html.replace(/<script>[\s\S]*?<\/script>/, "")), "no on*= attributes");
  const push = /var PUSH_API = "([^"]+)"/.exec(html)[1];
  assert.ok(csp[1].includes(push), "connect-src has the worker");
});
