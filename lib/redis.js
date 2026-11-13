const { Redis } = require("@upstash/redis");

let client;
function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash Redis is not configured");
  if (!client) client = new Redis({ url, token });
  return client;
}

// Lazy initialization prevents missing optional secrets from crashing Worker startup.
module.exports = new Proxy({}, {
  get(_target, property) {
    const instance = getRedis();
    const value = instance[property];
    return typeof value === "function" ? value.bind(instance) : value;
  }
});
