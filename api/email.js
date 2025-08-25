// /api/email.js  (ESM: package.json has "type":"module")
import { Redis } from "@upstash/redis";
import { Octokit } from "@octokit/rest";
import TurndownService from "turndown";
import { parse as parseQS } from "querystring";

// ---------- helpers ----------
const TZ = "+0000"; // keep UTC for now

import Busboy from "busboy";

async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    try {
      const fields = {};
      const bb = Busboy({ headers: req.headers });

      bb.on("field", (name, val) => {
        // SendGrid uses: to, from, subject, text, html, envelope, headers, cc, cc[], etc.
        fields[name] = val;
      });

      bb.on("file", (name, file, info) => {
        // We don't need attachments yet; drain to discard
        file.on("data", () => {});
        file.on("end", () => {});
      });

      bb.on("error", reject);
      bb.on("close", () => resolve(fields));

      req.pipe(bb);
    } catch (e) {
      reject(e);
    }
  });
}

function firstEmailAddress(x) {
  if (!x) return "";
  // Arrays → first element
  if (Array.isArray(x)) x = x[0];
  let s = String(x).trim();

  // If it has an angle-bracket form: Name <addr@host>
  const m = s.match(/<([^>]+)>/);
  if (m && m[1]) s = m[1];

  // Strip surrounding quotes
  s = s.replace(/^"+|"+$/g, "");

  // If multiple tokens, pick the first that looks like an email
  const parts = s.split(/[,\s]/).filter(p => p.includes("@"));
  if (parts.length) s = parts[0];

  return s.toLowerCase();
}

function toSlug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Remove stray CSS rules that sometimes appear in plaintext exports
function stripCssNoise(s) {
  if (!s) return s;
  // Drop single-line CSS rules like: p {margin-top:0; margin-bottom:0;}
  return s.replace(/^[^{\n]{1,80}\{[^}]*\}\s*$/gm, "").trim();
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
    `tag: "general"`,
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

  if (ct.includes("multipart/form-data")) {
    return await parseMultipart(req);
  }

  if (req.body && typeof req.body === "object") return req.body;

  if (typeof req.body === "string") {
    if (ct.includes("application/json")) {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    if (ct.includes("application/x-www-form-urlencoded")) {
      return parseQS(req.body);
    }
  }

  const raw = await readRaw(req);

  if (ct.includes("application/json")) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    return parseQS(raw);
  }

  // Fallback: try JSON then QS
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

  console.log("INBOUND parsed", {
    to, subject, hasHtml: !!html, hasText: !!text,
    contentType: String(req.headers["content-type"] || "")
  });

  if (!to || !subject || (!html && !text)) {
    return res.status(400).json({
      error: "Missing to/subject/body",
      got: { to: !!to, subject: !!subject, html: !!html, text: !!text },
    });
  }

  // username: "name@inbox.scotty.ink" -> "name"
  // Prefer envelope.to (array) if SendGrid provided it; else parse "to"
let toAddr = firstEmailAddress(b.envelope ? (() => {
  try {
    const env = JSON.parse(b.envelope);
    return env?.to?.[0] || b.to;
  } catch {
    return b.to;
  }
})() : b.to);

const username = (toAddr.split("@")[0] || "").replace(/^"+|"+$/g, "");
console.log("TO PARSED", { rawTo: b.to, envelope: b.envelope, toAddr, username });

  console.log("USERNAME", { username });

  // redis lookups
  const redis = new Redis({ url: REST_URL, token: REST_TOKEN });
  const userId = await redis.get(`inbound:${username}`);
  if (!userId) {
    console.log("404 no mapping for username", {
      triedKey: `inbound:${username}`,
      username
    });
    return res.status(404).json({ error: `No mapping for username '${username}'` });
  }

// 1. Grab repo from Redis
const repoFull = await redis.get(`selected-repo:${userId}`);
console.log("RAW REPO", { repoFull });

// 2. Split into owner/repo (this is the new part)
const [owner, repo] = (repoFull || "").replace(/['"]+/g, "").trim().split("/");
console.log("OWNER/REPO", { owner, repo });

// 3. Use them when calling GitHub API
if (!owner || !repo) {
  throw new Error(`Invalid repo string: ${repoFull}`);
}

  if (!repoFull) {
    console.log("404 no selected repo", {
      triedKey: `selected-repo:${userId}`,
      userId
    });
    return res.status(404).json({ error: `No selected repo for userId '${userId}'` });
  }

  // html/text -> markdown
  // --- helpers for Markdown cleanliness ---
  function normalizeBodyForMarkdown(input) {
    if (!input) return "";
    let t = input.toString("utf8"); // ensure UTF-8
  
    // normalize newlines
    t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\\n/g, "\n");
  
    // collapse excessive blank lines
    t = t.replace(/\n{3,}/g, "\n\n");
  
    // strip trailing spaces
    t = t.split("\n").map(line => line.replace(/[ \t]+$/g, "")).join("\n");
  
    return t.trim();
  }
  
 // --- choose the cleanest body: prefer text; fallback to html->md ---
let bodyClean = "";
if (text) {
  bodyClean = normalizeBodyForMarkdown(text);
} else if (html) {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  // strip <style> so no CSS leaks into output
  const htmlNoStyle = String(html).replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  bodyClean = normalizeBodyForMarkdown(turndown.turndown(htmlNoStyle));
}

  // make Jekyll content + path
  const now = new Date();
  const { yyyy, mm, dd, hh, mi, ss } = dateParts(now);
  const dateISO = `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  const fm = makeFrontMatter({ title: subject, dateISO });
  // assemble final Markdown
  const contentMd = fm + bodyClean + "\n";
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
      content: Buffer.from(contentMd, "utf8").toString("base64"), // force UTF-8
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
