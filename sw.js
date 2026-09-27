/* Nynäs Padel service worker.
   index.html: network first (updates arrive at once), cache as offline fallback.
   img/ and icons/: cache first. Other origins (api.rankedin.com, fonts) are never touched. */
var VERSION = "padel-v1";
var PRECACHE = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(VERSION).then(function(c){ return c.addAll(PRECACHE); }).catch(function(){}));
  self.skipWaiting();
});

self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k.indexOf("padel-") === 0 && k !== VERSION; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // never cache the API or other hosts
  var scopePath = new URL(self.registration.scope).pathname;
  var rel = url.pathname.indexOf(scopePath) === 0 ? url.pathname.slice(scopePath.length) : url.pathname;

  if (req.mode === "navigate" || rel === "" || rel === "index.html"){
    e.respondWith(
      fetch(req, {cache:"no-store"}).then(function(res){
        if (res && res.ok){ var copy = res.clone(); caches.open(VERSION).then(function(c){ c.put("index.html", copy); }); }
        return res;
      }).catch(function(){
        return caches.match("index.html").then(function(r){ return r || caches.match("./"); }).then(function(r){ return r || Response.error(); });
      })
    );
    return;
  }

  if (/^(img|icons)\//.test(rel)){
    e.respondWith(caches.match(req).then(function(hit){
      return hit || fetch(req).then(function(res){
        if (res && res.ok){ var copy = res.clone(); caches.open(VERSION).then(function(c){ c.put(req, copy); }); }
        return res;
      });
    }));
  }
});

self.addEventListener("notificationclick", function(e){
  e.notification.close();
  var target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type:"window", includeUncontrolled:true}).then(function(list){
    for (var i = 0; i < list.length; i++){
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && "focus" in c){
        return c.focus();
      }
    }
    return self.clients.openWindow ? self.clients.openWindow(target) : null;
  }));
});
