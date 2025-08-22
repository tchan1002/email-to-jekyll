// /api/email.js  (ESM: package.json has "type":"module")
import { Redis } from "@upstash/redis";
import { Octokit } from "@octokit/rest";
import TurndownService from "turndown";
import { parse as parseQS } from "querystring";

// ---------- helpers ----------
const TZ = "+0000"; // keep UTC for now

function toSlug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function dateParts(d = new Date()) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return { yyyy, mm, dd, hh, mi, ss };
}

// Build correct Jekyll front matter block
function makeFrontMatter({ title, dateISO, categories = [] }) {
  const safeTitle = String(title || "Untitled").replace(/"/g, '\\"');
  const lines = [
    "---",
    "layout: post",
    `title: "${safeTitle}"`,
    `date: ${dateISO} ${TZ}`,
  ];
  if (categories && categories.length) {
    lines.push(`categories: [${categories.map((c) => `"${c}"`).join(", ")}]`);
  }
  return lines.join("\n") + "\n---\n\n";
}

// parse body
function readCT(req) {
  return String(req.headers["content-type"] || "").toLowerCase();
}
async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
async function parseBody(req) {
  const ct = readCT(req);
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    if (ct.includes("application/json")) {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    if (ct.includes("application/x-www-form-urlencoded")) return parseQS(req.body);
  }
  const raw = await readRaw(req);
  if (ct.includes("application/json")) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (ct.includes("application/x-www-form-urlencoded")) return parseQS(raw);
  try { return JSON.parse(raw); } catch { return parseQS(raw); }
}

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  // envs
  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!REST_URL || !REST_TOKEN) return res.status(500).json({ error: "Missing Upstash REST envs" });
  if (!GITHUB_TOKEN) return res.status(500).json({ error: "GITHUB_TOKEN missing" });

  // parse incoming
  const b = await parseBody(req);
  const to = b.to || b.recipient || b.envelope?.to || b["to[]"] || "";
  const subject = b.subject || b.Subject || b.mime_subject || "";
  const html = b.html || b.htmlBody || "";
  const text = b.text || b.plain || b.body || "";

  if (!to || !subject || (!html && !text)) {
    return res.status(400).json({
      error: "Missing to/subject/body",
      got: { to: !!to, subject: !!subject, html: !!html, text: !!text },
    });
  }

  // username: "name@inbox.scotty.ink" -> "name"
  const username = String(to).split(",")[0].trim().split("@")[0];

  // redis lookups
  const redis = new Redis({ url: REST_URL, token: REST_TOKEN });
  const userId = await redis.get(`inbound:${username}`);
  if (!userId) return res.status(404).json({ error: `No mapping for username '${username}'` });
  const repoFull = await redis.get(`selected-repo:${userId}`);
  if (!repoFull) return res.status(404).json({ error: `No selected repo for userId '${userId}'` });
  const [owner, repo] = String(repoFull).split("/");

  // html/text -> markdown
  const turndown = new TurndownService();
  const bodyMd = (html ? turndown.turndown(html) : text || "").trim();

  // make Jekyll content + path
  const now = new Date();
  const { yyyy, mm, dd, hh, mi, ss } = dateParts(now);
  const dateISO = `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  const fm = makeFrontMatter({ title: subject, dateISO });
  const contentMd = fm + bodyMd + "\n";
  const slug = toSlug(subject) || "email-post";
  const path = `_posts/${yyyy}-${mm}-${dd}-${slug}.md`;

  // commit (create or update)
  const octo = new Octokit({ auth: GITHUB_TOKEN });

  try {
    let sha;
    try {
      const { data } = await octo.repos.getContent({ owner, repo, path });
      if (data && !Array.isArray(data) && data.sha) sha = data.sha;
    } catch (err) {
      if (err.status !== 404) throw err; // only ignore 404
    }

    await octo.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message: `Scotty: ${subject}`,
      content: Buffer.from(contentMd).toString("base64"),
      ...(sha ? { sha } : {}),
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
