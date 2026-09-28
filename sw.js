/* Nynäs Padel service worker.
   index.html and players.json (the roster): network first with revalidation (an unchanged file is a 304), the
   cached copy after 3 s on a slow network or at once offline. Other pages (integritet.html): network first, cached
   under their own URL. img/ and icons/: the cached copy at once, refreshed in the background (a replaced photo
   shows on the next view, a removed one leaves the cache). Other origins (api.rankedin.com, fonts) are never touched. */
var VERSION = "padel-v7";
var PRECACHE = ["index.html", "players.json", "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(VERSION).then(function(c){ return c.addAll(PRECACHE); }).catch(function(){}));
  self.skipWaiting();
});

self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k.indexOf("padel-") === 0 && k !== VERSION; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

function networkFirst(e, key, wait){
  var net = fetch(e.request, {cache:"no-cache"});
  e.waitUntil(net.then(function(res){   // attached first: the copy is taken before the page reads the body
    if (res && res.ok && !res.redirected){ var copy = res.clone(); return caches.open(VERSION).then(function(c){ return c.put(key, copy); }); }
  }).catch(function(){}));
  e.respondWith(new Promise(function(resolve){
    var done = false, timer = null;
    function fallback(err){
      return caches.match(key).then(function(r){ if (!done && (r || err)){ done = true; clearTimeout(timer); resolve(r || Response.error()); } });
    }
    if (wait) timer = setTimeout(function(){ fallback(false); }, wait);
    net.then(function(res){ if (!done){ done = true; clearTimeout(timer); resolve(res); } }, function(){ fallback(true); });
  }));
}

self.addEventListener("fetch", function(e){
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // never cache the API or other hosts
  var scopePath = new URL(self.registration.scope).pathname;
  var rel = url.pathname.indexOf(scopePath) === 0 ? url.pathname.slice(scopePath.length) : url.pathname;

  // The app shell is keyed on its path, never on req.mode: another page must not overwrite it.
  if (rel === "" || rel === "index.html" || rel === "players.json"){
    networkFirst(e, rel === "players.json" ? "players.json" : "index.html", 3000);
    return;
  }
  if (req.mode === "navigate"){
    networkFirst(e, req, 0);
    return;
  }

  if (/^(img|icons)\//.test(rel)){
    var fresh = fetch(req).then(function(res){
      return caches.open(VERSION).then(function(c){
        if (res.ok) return c.put(req, res.clone()).then(function(){ return res; });
        if (res.status === 404 || res.status === 410) return c.delete(req).then(function(){ return res; });
        return res;
      });
    });
    e.waitUntil(fresh.catch(function(){}));
    e.respondWith(caches.match(req).then(function(hit){ return hit || fresh; }));
  }
});

/* Web Push from the padel-push worker: {title, body, tag, url}. Same tag as the page's own notiser. */
self.addEventListener("push", function(e){
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err){ d = {body:e.data ? e.data.text() : ""}; }
  e.waitUntil(self.registration.showNotification(d.title || "Nynäs Padel", {
    body:d.body || "", tag:d.tag || "padel",
    icon:"icons/icon-192.png", badge:"icons/icon-192.png", data:{url:d.url || "./"}
  }));
});

/* Tap on a notis: url is a deep link ("./#thea/m6872156" = player + match). An open page gets it as a message
   (it switches tab and scrolls to the match without reloading); otherwise the app opens at that link. */
self.addEventListener("notificationclick", function(e){
  e.notification.close();
  var target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  var hash = target.indexOf("#") >= 0 ? target.slice(target.indexOf("#")) : "";
  e.waitUntil(self.clients.matchAll({type:"window", includeUncontrolled:true}).then(function(list){
    for (var i = 0; i < list.length; i++){
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && "focus" in c){
        return c.focus().then(function(w){
          w = w || c;
          try { w.postMessage({type:"padel-open", url:target, hash:hash}); return w; }
          catch (err){ return "navigate" in w ? w.navigate(target).catch(function(){ return w; }) : w; }
        });
      }
    }
    return self.clients.openWindow ? self.clients.openWindow(target) : null;
  }));
});
