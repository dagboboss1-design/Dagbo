(function () {
  "use strict";
  var SW_URL = "./service-worker.js";
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var registrationPromise = null;

  function isStandalone() {
    return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  }

  function notifState() {
    if (isIOS && !isStandalone()) return "needs-install";
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission;
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return Promise.reject(new Error("Service workers are not supported"));
    if (!registrationPromise) {
      registrationPromise = navigator.serviceWorker.register(SW_URL).then(function () {
        return navigator.serviceWorker.ready;
      });
    }
    return registrationPromise;
  }

  function urlBase64ToUint8Array(value) {
    var padding = "=".repeat((4 - value.length % 4) % 4);
    var raw = window.atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
    var result = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) result[i] = raw.charCodeAt(i);
    return result;
  }

  function sameBytes(a, b) {
    if (!a || !b || a.byteLength !== b.byteLength) return false;
    var x = new Uint8Array(a), y = new Uint8Array(b);
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  function subscribePush() {
    if (!("PushManager" in window)) return Promise.reject(new Error("Push notifications are not supported by this browser"));
    return fetch("/api/push?action=public-key", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || "Could not load push key"); });
        return res.json();
      })
      .then(function (data) {
        if (!data.publicKey) throw new Error("Push public key is missing on the server");
        var applicationServerKey = urlBase64ToUint8Array(data.publicKey);
        return registerSW().then(function (reg) {
          return reg.pushManager.getSubscription().then(function (existing) {
            if (existing && existing.options && existing.options.applicationServerKey &&
                !sameBytes(existing.options.applicationServerKey, applicationServerKey)) {
              return existing.unsubscribe().then(function (ok) {
                if (!ok) throw new Error("Could not refresh the old push subscription. Please disable and enable notifications again.");
                return null;
              });
            }
            return existing;
          }).then(function (existing) {
            return existing || reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: applicationServerKey
            });
          });
        });
      })
      .then(function (subscription) {
        return fetch("/api/push?action=subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subscription)
        }).then(function (res) {
          if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || "Could not save subscription"); });
          return subscription;
        });
      });
  }

  function enableNotifications() {
    var state = notifState();
    if (state === "needs-install") return Promise.reject(new Error("Add DAGBO SIGNAL to your Home Screen first, then enable notifications."));
    if (state === "unsupported") return Promise.reject(new Error("This browser does not support notifications."));
    if (state === "denied") return Promise.reject(new Error("Notifications are blocked. Allow them in your browser settings."));
    var permission = state === "granted" ? Promise.resolve("granted") : Notification.requestPermission();
    return permission.then(function (result) {
      if (result !== "granted") throw new Error("Notification permission was not granted.");
      return subscribePush();
    }).then(function () {
      return { status: "granted", message: "Push notifications are enabled on this device." };
    });
  }

  function disableNotifications() {
    return registerSW().then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (subscription) {
      if (!subscription) return { status: "disabled" };
      return fetch("/api/push?action=unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint })
      }).then(function (res) {
        if (!res.ok) throw new Error("Could not remove notification subscription from server");
        return subscription.unsubscribe();
      }).then(function () {
        return { status: "disabled" };
      });
    });
  }

  function sendTest() {
    return registerSW().then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (subscription) {
      if (!subscription) throw new Error("Enable notifications first.");
      return fetch("/api/push?action=test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription)
      });
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "Test notification failed");
        return data;
      });
    });
  }

  function getStatus() {
    var permission = notifState();
    if (permission !== "granted") {
      return Promise.resolve({ enabled: false, permission: permission, message: permission === "denied" ? "Notifications are blocked in browser settings." : "Notifications are not enabled on this device." });
    }
    return subscribePush().then(function () {
      return { enabled: true, permission: permission, message: "This device is registered for push notifications." };
    }).catch(function (error) {
      return { enabled: false, permission: permission, message: error.message || "Push subscription could not be verified." };
    });
  }

  function getSubscription() {
    return registerSW().then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (subscription) {
      if (!subscription) return null;
      var json = subscription.toJSON();
      // Keep the server-side recipient registry fresh for scheduled news and signal alerts.
      return fetch("/api/push?action=subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json)
      }).then(function (res) {
        if (!res.ok) return res.json().then(function (data) {
          throw new Error(data.error || "Could not register this device for scheduled alerts");
        });
        return json;
      });
    });
  }

  window.DagboPWA = {
    getSubscription: getSubscription,
    getStatus: getStatus,
    enableNotifications: enableNotifications,
    disableNotifications: disableNotifications,
    sendTest: sendTest,
    notifState: notifState
  };

  registerSW().catch(function (error) { console.error("DAGBO service worker:", error); });
})();
