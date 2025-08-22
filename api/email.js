import TurndownService from "turndown";
import Redis from "ioredis";

// Redis client (Upstash or any hosted Redis). Must be set as env var REDIS_URL (rediss://...)
const redis = new Redis(process.env.REDIS_URL);

// --- helpers ---
function jekyllSafeSlug(s) {
  return (s || "post")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "post";
}

function firstRecipientToLocal(toField = "") {
  // Handles "Name <user@domain>" or just "user@domain"
  const first = Array.isArray(toField) ? toField[0] : String(toField).split(",")[0] || "";
  const match = first.match(/<?([^<>\s@]+)@([^<>\s@]+)>?/);
  if (!match) return null;
  return { local: match[1], domain: match[2] };
}

async function readBody(req) {
  // Accept JSON or x-www-form-urlencoded (easiest for SendGrid Inbound)
  const ct = req.headers["content-type"] || "";
  const buf = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(Buffer.from(data)));
    req.on("error", reject);
  });
  const text = buf.toString("utf8");

  if (ct.includes("application/json")) {
    try { return JSON.parse(text || "{}"); } catch { return {}; }
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    const obj = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return obj;
  }
  // For multipart, you'd parse with a lib like busboy/formidable. v1 keeps it simple.
  return {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const body = await readBody(req);

    // 1) Recipient -> GitHub login (local-part)
    const toField = body.to || body.To || body.envelope?.to || body.rcpt_to;
    const rcpt = firstRecipientToLocal(toField);
    if (!rcpt) {
      return res.status(400).json({ error: "Could not parse recipient (To:)" });
    }
    const login = rcpt.local; // expected to be GitHub username

    // 2) Lookup userId via Redis written by Scotty UI: inbound:<login> -> userId
    const userId = await redis.get(`inbound:${login}`);
    if (!userId) {
      return res.status(404).json({ error: `No user mapping for ${login}@${rcpt.domain}` });
    }

    // 3) Lookup that user's selected repo
    const repo = await redis.get(`selected-repo:${userId}`);
    if (!repo) {
      return res.status(400).json({
        error: `No repo selected for userId ${userId}. Ask the user to pick a repo in Scotty UI.`,
      });
    }

    // 4) Content
    const subject = (body.subject || body.Subject || "untitled-post").toString().trim();
    const html = (body.html || body.Html || "").toString();
    const text = (body.text || body.Text || "").toString();
    const source = html || text || "No content";

    // 5) Convert to Markdown
    const turndown = new TurndownService();
    const markdownBody = turndown.turndown(source);

    // 6) Build Jekyll file
    const today = new Date().toISOString().split("T")[0];
    const safeTitle = jekyllSafeSlug(subject);
    const filename = `_posts/${today}-${safeTitle}.md`;

    const fileContent = `---
layout: post
title: "${subject.replace(/"/g, '\"')}"
date: ${today}
---

${markdownBody}
`;

    // 7) Commit to GitHub
    const url = `https://api.github.com/repos/${repo}/contents/${filename}`;
    const ghResp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `Add new post: ${subject}`,
        content: Buffer.from(fileContent).toString("base64"),
      }),
    });

    if (!ghResp.ok) {
      const errText = await ghResp.text();
      throw new Error(`GitHub ${ghResp.status}: ${errText}`);
    }

    const data = await ghResp.json();
    return res.status(200).json({
      message: "Markdown committed to GitHub!",
      repo,
      login,
      link: data.content.html_url,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
