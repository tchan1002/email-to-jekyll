import TurndownService from "turndown";
import Redis from "ioredis";

// ...

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  // ✅ create a fresh client per invocation, with serverless-safe options
  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) return res.status(500).json({ error: "REDIS_URL missing" });

  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,        // avoid 20x retry storm
    enableOfflineQueue: false,      // do not queue in lambdas
    connectTimeout: 5000,           // fail fast
    tls: REDIS_URL.startsWith("rediss://") ? {} : undefined,
    retryStrategy(times) {
      return times > 2 ? null : 200 * times; // short backoff, then stop
    },
  });

  try {
    // ... your existing body parsing and logic ...
    // e.g.
    // const { to, subject, html, text } = req.body ?? {};
    // const username = String(to).split("@")[0];
    // const userId = await redis.get(`inbound:${username}`);
    // const repo = await redis.get(`selected-repo:${userId}`);
    // turndown → commit to GitHub → res.status(200).json({ message: "Markdown committed to GitHub!" })

  } catch (err) {
    console.error("WEBHOOK ERROR", err);
    return res.status(500).json({ error: err?.message || String(err) });
  } finally {
    // ✅ ensure socket closes between invocations
    try { await redis.quit(); } catch {}
  }
}
