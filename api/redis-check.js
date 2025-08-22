// /api/redis-check.js
import Redis from "ioredis";

export default async function handler(req, res) {
  const username = String(req.query.username || "").trim();
  if (!username) return res.status(400).json({ error: "Provide ?username=YOUR_GITHUB_USERNAME" });

  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) return res.status(500).json({ error: "REDIS_URL missing" });

  const t0 = Date.now();
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    tls: REDIS_URL.startsWith("rediss://") ? {} : undefined,
    retryStrategy(times) { return times > 2 ? null : 200 * times; },
  });

  try {
    const ping = await redis.ping();
    const userId = await redis.get(`inbound:${username}`);
    const repo = userId ? await redis.get(`selected-repo:${userId}`) : null;

    return res.status(200).json({
      ok: true,
      ping,
      username,
      userId,
      repo,
      durationMs: Date.now() - t0,
      env: {
        hasRedisUrl: !!REDIS_URL,
        vercelEnv: process.env.VERCEL_ENV || process.env.NODE_ENV,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    try { await redis.quit(); } catch {}
  }
}
