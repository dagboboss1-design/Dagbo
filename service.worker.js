const VERSION = "dagbo-v1";
const PRECACHE = ["./", "index.html", "signals.html", "chart.html", "ai.html", "journal.html", "settings.html", "dagbo.css", "manifest.json", "pwa.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => Promise.allSettled(PRECACHE.map((u) => cache.add(u)))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("dagbo-") && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request)).then((res) => res || caches.match("index.html"))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || "./index.html"));
});

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(d.title || "DAGBO SIGNAL", {
      body: d.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: d.url || "./index.html" }
    })
  );
});
