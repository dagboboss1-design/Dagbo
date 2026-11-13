const VERSION = "dagbo-v22";
const PRECACHE = ["./", "index.html", "boss1.html", "signals.html", "signal-insights.html", "chart.html", "news.html", "ai.html", "journal.html", "alerts.html", "trader-score.html", "strategy-lab.html", "market-heatmap.html", "replay.html", "settings.html", "icons/dagbo-icon.svg", "dagbo.css", "manifest.json", "pwa.js", "navigation.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("dagbo-") && key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  // Leave external resources and live API responses to the network. In
  // particular, never return the app shell as a substitute for an API/JS file.
  if (requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(event.request).then((response) => {
      if (response && response.ok && response.type === "basic") {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request).then((cached) => {
      if (cached) return cached;
      if (event.request.mode === "navigate") return caches.match("./index.html");
      return Response.error();
    }))
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (error) {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "DAGBO SIGNAL", {
      body: data.body || "You have a new trading alert.",
      tag: data.tag || "dagbo-alert",
      icon: "./icons/dagbo-icon.svg",
      badge: "./icons/dagbo-icon.svg",
      timestamp: Date.now(),
      data: { url: data.url || "./signals.html" },
      vibrate: [90, 45, 90],
      renotify: false,
      requireInteraction: false,
      silent: false,
      actions: [{ action: "open-signals", title: "View signal" }]
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || "./signals.html", self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
