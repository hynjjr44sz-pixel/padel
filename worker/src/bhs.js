// Backhandsmash (MATCHi's league site): the club's series tables, read once a night with the captain's own MATCHi
// login (secrets BHS_USER / BHS_PASS; off without them). Only the pages the captain sees in the browser, never more.
// Login: backhandsmash.com -> auth.matchi.com (Keycloak, username + password form) -> back with a code -> session cookie.

const BHS = "https://backhandsmash.com";

// Minimal cookie jar: name=value per host (enough for the login round trip; paths and expiry are not needed here).
function jar() {
  const by = {};
  return {
    take(url, res) {
      const host = new URL(url).host, list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      for (const c of list) {
        const [nv] = c.split(";"), i = nv.indexOf("=");
        if (i > 0) (by[host] = by[host] || {})[nv.slice(0, i).trim()] = nv.slice(i + 1).trim();
      }
    },
    header(url) {
      const c = by[new URL(url).host] || {};
      return Object.keys(c).map(k => k + "=" + c[k]).join("; ");
    }
  };
}

// fetch that follows redirects by hand, so every hop's cookies are kept. -> {res, url, text}
async function go(j, url, init = {}, hops = 10) {
  for (let i = 0; i < hops; i++) {
    const headers = { "User-Agent": "Mozilla/5.0 (padel.holmberg.st nightly)", "Accept": "text/html,application/xhtml+xml", ...(init.headers || {}) };
    const ck = j.header(url);
    if (ck) headers.Cookie = ck;
    const res = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
    j.take(url, res);
    const loc = res.headers.get("Location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).href;
      init = { method: "GET" };   // a POST answered with a redirect continues as GET
      continue;
    }
    return { res, url, text: await res.text() };
  }
  throw new Error("too many redirects");
}

const unescape = s => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// -> a cookie jar with a logged-in Backhandsmash session. Errors never include the credentials.
export async function bhsLogin(env) {
  if (!env.BHS_USER || !env.BHS_PASS) throw new Error("BHS_USER/BHS_PASS not set");
  const j = jar();
  const a = await go(j, BHS + "/sv/Pages/Login");
  // MATCHi's login page is a Keycloakify app: the form's target is in its kcContext ("loginAction"); a plain form as fallback
  const m = /"loginAction"\s*:\s*"([^"]+)"/.exec(a.text) || /<form[^>]*action="([^"]*login-actions\/authenticate[^"]*)"/i.exec(a.text);
  if (!m) throw new Error("login form not found (" + new URL(a.url).host + " " + a.res.status + ")");
  const body = new URLSearchParams({ username: env.BHS_USER, password: env.BHS_PASS, credentialId: "" });
  const b = await go(j, new URL(unescape(m[1].replace(/\\\//g, "/")), a.url).href, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (new URL(b.url).host.indexOf("matchi.com") >= 0) {
    const err = /"message"\s*:\s*\{[^}]*"summary"\s*:\s*"([^"]*)"/.exec(b.text) || /kc-feedback-text[^>]*>([^<]*)/i.exec(b.text);
    const page = /pageId = "([^"]+)"/.exec(b.text);
    throw new Error("login refused" + (err ? ": " + err[1].trim() : "") + " (" + (page ? page[1] : b.res.status) + ")");
  }
  return { get: async path => { const r = await go(j, new URL(path, BHS).href); return { status: r.res.status, url: r.url, html: r.text }; } };
}
