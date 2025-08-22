import { Redis } from "@upstash/redis";
import { Octokit } from "octokit";
import TurndownService from "turndown";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const ct = String(req.headers["content-type"] || "").toLowerCase();
  let b = req.body || {};
  if (typeof b === "string" && ct.includes("application/json")) b = JSON.parse(b || "{}");
  const to = b.to || b["to"];                  // also works for urlencoded when body is an object
  const subject = b.subject || b["subject"];
  const html = b.html || b["html"];
  const text = b.text || b["text"];
  if (!to || !subject || (!html && !text)) return res.status(400).json({ error: "Missing to/subject/body" });

  const username = String(to).split("@")[0];

  const userId = await redis.get(`inbound:${username}`);
  if (!userId) return res.status(404).json({ error: `No mapping for ${username}` });

  const repoFull = await redis.get(`selected-repo:${userId}`);
  if (!repoFull) return res.status(404).json({ error: `No selected repo for ${userId}` });

  const md = (html ? new TurndownService().turndown(html) : text).trim();
  const date = new Date().toISOString().slice(0, 10);
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const path = `_posts/${date}-${slug}.md`;

  const [owner, name] = String(repoFull).split("/");
  const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const contentB64 = Buffer.from(md + "\n").toString("base64");

  await octo.rest.repos.createOrUpdateFileContents({
    owner, repo: name, path,
    message: `Scotty: ${subject}`,
    content: contentB64,
  });

  return res.status(200).json({ message: "Markdown committed to GitHub!", repo: repoFull, path });
}
