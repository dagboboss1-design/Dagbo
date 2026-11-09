(function () {
  "use strict";
  var SW_URL = "service-worker.js";
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var deferred = null;

  function isStandalone() { return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches; }

  function notifState() {
    if (isIOS && !isStandalone()) return "needs-install";
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission;
  }

  function askPermission() {
    return new Promise(function (resolve) {
      try {
        var r = Notification.requestPermission(resolve);
        if (r && typeof r.then === "function") r.then(resolve, function () { resolve("default"); });
      } catch (e) { resolve("default"); }
    });
  }

  function enableNotifications() {
    var st = notifState();
    if (st === "needs-install") return Promise.resolve({ status: st, message: "Add DAGBO to your Home Screen first." });
    if (st === "unsupported") return Promise.resolve({ status: st, message: "This browser no support alerts." });
    if (st === "granted") return Promise.resolve({ status: st, message: "Alerts are on." });
    if (st === "denied") return Promise.resolve({ status: st, message: "Alerts are blocked. Allow them in settings." });
    return askPermission().then(function (p) {
      if (p === "granted") return { status: "granted", message: "Alerts on." };
      return { status: "default", message: "You no allow am yet." };
    });
  }

  function subscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return Promise.resolve({ status: 'unsupported' });
    return fetch('/api/push?action=public-key')
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.publicKey) throw new Error('No key');
        function urlBase64ToUint8Array(base64String) {
          const padding = '='.repeat((4 - base64String.length % 4) % 4);
          const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
          const rawData = window.atob(base64);
          const outputArray = new Uint8Array(rawData.length);
          for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
          return outputArray;
        }
        return navigator.serviceWorker.ready.then(function(registration) {
          return registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(data.publicKey)
          });
        });
      })
      .then(function(subscription) {
        return fetch('/api/push?action=subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription)
        });
      })
      .then(function() { return { status: 'granted', message: 'Push notifications enabled!' }; })
      .catch(function(err) { console.error(err); return { status: 'error', message: 'Failed to subscribe' }; });
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(SW_URL).catch(function () {});
  }

  window.DagboPWA = {
    enableNotifications: enableNotifications,
    subscribePush: subscribePush,
    notifState: notifState
  };
  
  registerSW();
})();
