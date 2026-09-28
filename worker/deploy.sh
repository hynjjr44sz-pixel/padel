#!/usr/bin/env bash
# Deploys the padel-push worker to Cloudflare (free plan) and points index.html at it.
# Idempotent: safe to run again after changing players.json, src/events.js or anything else.
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./worker/deploy.sh
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN (token from the 'Edit Cloudflare Workers' template)}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID WRANGLER_SEND_METRICS=false

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
# The token goes to curl through a file descriptor (printf is a builtin): never in curl's argv, which other local
# users can read with ps. Needs curl 7.55+.
cf() { curl -fsS -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN") -H "Content-Type: application/json" "$@"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);$1})"; }

echo "1/6 wrangler (pinned in package.json)"
npm install --no-audit --no-fund --silent
WR=(npx --no-install wrangler)

# Checked before anything is created: without a workers.dev subdomain, deploy has nowhere to go.
SUB="$(cf "$API/workers/subdomain" | js 'process.stdout.write(r.result&&r.result.subdomain||"")' 2>/dev/null || true)"
if [ -z "$SUB" ]; then
  echo "No workers.dev subdomain (or the token/account id is wrong): open Workers & Pages in the Cloudflare dashboard once, then run this again." >&2
  exit 1
fi
URL="https://padel-push.$SUB.workers.dev"

echo "2/6 KV namespace 'padel-push'"
KV_ID="$(cf "$API/storage/kv/namespaces?per_page=100" | js 'const n=r.result.find(x=>x.title==="padel-push");process.stdout.write(n?n.id:"")')"
if [ -z "$KV_ID" ]; then
  KV_ID="$(cf -X POST "$API/storage/kv/namespaces" -d '{"title":"padel-push"}' | js 'process.stdout.write(r.result.id)')"
  echo "    created $KV_ID"
fi
sed -i.bak -E "s/^id = \"[^\"]*\"/id = \"$KV_ID\"/" wrangler.toml && rm -f wrangler.toml.bak

echo "3/6 deploy (roster: players.json -> src/players.js)"
node sync-players.mjs
"${WR[@]}" deploy

echo "4/6 VAPID keys, fan-out secret"
# The private key goes straight from gen-vapid.mjs into a wrangler secret (stdin), never to disk or screen.
# A new key pair breaks every existing subscription: only when there is none yet, or with ROTATE_VAPID=1.
SECRETS="$("${WR[@]}" secret list)" || { echo "Cannot list the worker's secrets (network, or token permissions): stopping, nothing rotated." >&2; exit 1; }
HAS_KEY=0; grep -q VAPID_PRIVATE_KEY <<<"$SECRETS" && HAS_KEY=1
if [ "${ROTATE_VAPID:-0}" != "1" ] && [ -s vapid-public.txt ] && [ "$HAS_KEY" = 1 ]; then
  echo "    already set (vapid-public.txt + secret) - keeping them"
elif [ "${ROTATE_VAPID:-0}" != "1" ] && { [ -s vapid-public.txt ] || [ "$HAS_KEY" = 1 ]; }; then
  echo "Only half of the VAPID key pair is there (vapid-public.txt: $([ -s vapid-public.txt ] && echo yes || echo no), secret: $([ "$HAS_KEY" = 1 ] && echo yes || echo no))." >&2
  echo "A new pair would break every subscription. Run again with ROTATE_VAPID=1 to make one anyway." >&2
  exit 1
else
  node gen-vapid.mjs vapid-public.tmp | "${WR[@]}" secret put VAPID_PRIVATE_KEY >/dev/null
  tr -d '\n' < vapid-public.tmp | "${WR[@]}" secret put VAPID_PUBLIC_KEY >/dev/null
  mv vapid-public.tmp vapid-public.txt
  echo "    new key pair; public key in worker/vapid-public.txt (commit it)"
fi

# The push fan-out's shared secret (the worker calls itself: POST /fanout). Made once; until it exists the tick sends
# in-process as before.
if grep -q FANOUT_KEY <<<"$SECRETS"; then
  echo "    FANOUT_KEY already set"
else
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' | "${WR[@]}" secret put FANOUT_KEY >/dev/null
  echo "    FANOUT_KEY set (push fan-out)"
fi

echo "5/6 URL"
for _ in 1 2 3 4 5 6; do
  KEY="$(curl -fsS "$URL/vapid" 2>/dev/null | js 'process.stdout.write(r.key||"")' 2>/dev/null || true)"
  [ -n "$KEY" ] && break
  sleep 5
done
if [ "$KEY" != "$(tr -d '\n' < vapid-public.txt)" ]; then
  echo "Warning: $URL/vapid does not (yet) return the key in vapid-public.txt. New workers.dev URLs can take a minute; run again later." >&2
fi
echo "    $URL"

echo "6/6 index.html -> PUSH_API (+ preconnect and CSP connect-src, then the CSP script hash)"
sed -i.bak -E "s#^(  var PUSH_API = )\"[^\"]*\";#\1\"$URL\";#; s#https://padel-push\.[a-z0-9-]+\.workers\.dev#$URL#g" "$ROOT/index.html" && rm -f "$ROOT/index.html.bak"
grep -q "var PUSH_API = \"$URL\";" "$ROOT/index.html" || { echo "Could not set PUSH_API in index.html" >&2; exit 1; }
node csp.mjs

echo
echo "Done. Worker: $URL"
echo "Commit and push index.html, worker/wrangler.toml and worker/vapid-public.txt so GitHub Pages picks it up."
