// Generates a VAPID (P-256) key pair with WebCrypto.
// Public key (raw, base64url) -> the file given as argv[2]. Private key (JWK) -> stdout only,
// so it can be piped straight into `wrangler secret put` and never lands on disk.
import { writeFileSync } from "node:fs";

const b64u = buf => Buffer.from(buf).toString("base64url");
const out = process.argv[2];
if (!out) { console.error("usage: node gen-vapid.mjs <public-key-file>"); process.exit(1); }
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", kp.privateKey);
writeFileSync(out, pub + "\n");
process.stdout.write(JSON.stringify({ kty, crv, x, y, d }));
