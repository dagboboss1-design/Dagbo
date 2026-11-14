const { Redis } = require("@upstash/redis");

const clients = new Map();

function createRedis(env) {
  const source = env || (typeof process !== "undefined" ? process.env : {});
  const url = source.UPSTASH_REDIS_REST_URL;
  const token = source.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash Redis is not configured");
  const key = url + "|" + token;
  if (!clients.has(key)) clients.set(key, new Redis({ url, token }));
  return clients.get(key);
}

// Backward-compatible proxy for existing Vercel routes. Cloudflare request
// handlers should use createRedis(req.env) so each request uses its bindings.
const legacyProxy = new Proxy({}, {
  get(_target, property) {
    const instance = createRedis();
    const value = instance[property];
    return typeof value === "function" ? value.bind(instance) : value;
  }
});

module.exports = legacyProxy;
module.exports.createRedis = createRedis;
