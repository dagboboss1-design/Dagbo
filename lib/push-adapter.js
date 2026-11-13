let vapidDetails = null;

function setVapidDetails(subject, publicKey, privateKey) {
  if (!subject || !publicKey || !privateKey) throw new Error("VAPID keys are not configured");
  vapidDetails = { subject, publicKey, privateKey };
}

async function sendNotification(subscription, message, options = {}) {
  if (!vapidDetails) throw new Error("VAPID details have not been configured");
  if (!subscription || typeof subscription.endpoint !== "string" || !subscription.endpoint.startsWith("https://")) {
    throw new Error("Invalid Web Push subscription endpoint");
  }

  const { buildPushPayload } = await import("@block65/webcrypto-web-push");
  const request = await buildPushPayload({
    data: typeof message === "string" ? message : JSON.stringify(message),
    options: { ttl: Number.isFinite(Number(options.TTL)) ? Number(options.TTL) : 60 }
  }, subscription, {
    subject: vapidDetails.subject,
    publicKey: vapidDetails.publicKey,
    privateKey: vapidDetails.privateKey
  });

  const headers = new Headers(request.headers || {});
  if (options.urgency) headers.set("Urgency", String(options.urgency));
  if (options.topic) headers.set("Topic", String(options.topic));

  const response = await fetch(subscription.endpoint, { ...request, headers });
  if (!response.ok) {
    const error = new Error("Push service returned HTTP " + response.status);
    error.statusCode = response.status;
    error.body = await response.text().catch(() => "");
    throw error;
  }
  return { statusCode: response.status };
}

module.exports = { setVapidDetails, sendNotification };
