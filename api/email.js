// /api/email.js  (ESM; your package.json has "type":"module")
import { Redis } from "@upstash/redis";
import { Octokit } from "@octokit/rest";
import TurndownService from "turndown";
import { parse as parseQS } from "querystring";

// --- helpers ---------------------------------------------------
function readContentType(req) {
  return String(req.headers["content-type"] || "").toLowerCase();
}

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// Parse body from JSON or x-www-form-urlencoded (and handle raw string)
async function parseBody(req) {
  const ct = readContentType(req);
  // If body already parsed to object by the runtime, use it
  if (req.body && typeof req.body === "object") return req.body;

  // If body is a string, parse based on content-type
  if (typeof req.body === "string") {
    if (ct.includes("application/json")) {
      try { return JSON.parse(req.body || "{}"); } catch { return {}; }
    }
    if (ct.includes("application/x-www-form-urlencoded")) {
      return parseQS(req.body || "");
    }
  }

  // Fallback: read the stream and parse
  const raw = await readRawBody(req);
  if (ct.includes("application/json")) {
    try { return JSON.parse(raw || "{}"); } catch { return {}; }
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    return parseQS(raw || "");
  }

  // Last resort: try querystring parse then JSON parse
  try { return JSON.parse(raw || "{}"); } catch { /*ignore*/ }
  return parseQS(raw || "");
}

function toSlug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isoDateParts(d = new Date()) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return { yyyy, mm, dd, hh, mi, ss };
}

// --- main handler ----------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  // Ensure env
  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!REST_URL || !REST_TOKEN) {
    return res.status(500).json({ error: "Upstash REST envs missing (UPSTASH_REDIS_REST_URL/TOKEN)" });
  }
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: "GITHUB_TOKEN missing" });
  }

  // Parse body forgivingly
  const b = await parseBody(req);

  // Accept multiple field names so tests & SendGrid both work
  const to = b.to || b.recipient || b.envelope?.to || b["to[]"] || "";
  const subject = b.subject || b.Subject || b["mime_subject"] || "";
  const html = b.html || b["htmlBody"] || "";
  const text = b.text || b["plain"] || b.body || "";

  if (!to || !subject || (!html && !text)) {
    return res.status(400).json({ error: "Missing to/subject/body", got: { to: !!to, subject: !!subject, html: !!html, text: !!text } });
  }

  // Resolve username from the inbound address
  // e.g., "tchan1002@inbox.scotty.ink" -> "tchan1002"
  const username = String(to).split(",")[0].trim().split("@")[0]; // handle "a@x,b@y" too

  // Redis (Upstash REST)
  const redis = new Redis({ url: REST_URL, token: REST_TOKEN });

  // Look up userId and repo for this username
  const userId = await redis.get(`inbound:${username}`);
  if (!userId) {
    return res.status(404).json({ error: `No mapping for username '${username}'. Hit scotty-ui /api/my-inbound once while signed in.` });
  }
  const repoFull = await redis.get(`selected-repo:${userId}`);
  if (!repoFull) {
    return res.status(404).json({ error: `No selected repo for userId '${userId}'. Choose a repo in scotty-ui.` });
  }
  const [owner, repo] = String(repoFull).split("/");

  // Build Markdown with front-matter
  const turndown = new TurndownService();
  const bodyMd = (html ? turndown.turndown(html) : text).trim();

  const now = new Date();
  const { yyyy, mm, dd, hh, mi, ss } = isoDateParts(now);
  const fm = [
    "---",
    "layout: post",
    `title: "${String(subject).replace(/"/g, '\\"')}"`,
    `date: ${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} +0000`,
    "---",
    "",
  ].join("\n");
  const contentMd = fm + bodyMd + "\n";

  const slug = toSlug(subject);
  const path = `_posts/${yyyy}-${mm}-${dd}-${slug || "email-post"}.md`;

  // Commit to GitHub
  const octo = new Octokit({ auth: GITHUB_TOKEN });

  try {
    const contentB64 = Buffer.from(contentMd).toString("base64");

    // createOrUpdate without worrying about existing sha (we rarely overwrite same path)
    await octo.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message: `Scotty: ${subject}`,
      content: contentB64,
    });

    return res.status(200).json({
      message: "Markdown committed to GitHub!",
      repo: repoFull,
      path,
      username,
      userId,
    });
  } catch (e) {
    return res.status(500).json({ error: `GitHub write failed: ${e?.message || String(e)}` });
  }
}
