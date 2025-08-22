# email-to-jekyll (minimal)

A tiny Vercel serverless function that:
- receives inbound email webhooks (SendGrid Inbound Parse)
- converts HTML/Text -> Markdown via Turndown
- commits `_posts/YYYY-MM-DD-title.md` to a selected GitHub repo

## Deploy (Origami mode)

1) Create a new Vercel Project from this repo.
2) Add Environment Variables (Production + Preview):
   - `GITHUB_TOKEN` = PAT with repo:contents write
   - `REDIS_URL`   = rediss://... (Upstash/Redis)
3) Deploy. Your endpoint will be:
   `https://<project>.vercel.app/api/email`

4) In Scotty UI, ensure these Redis keys exist:
   - `inbound:<github_login>` -> `<github_user_id>`
   - `selected-repo:<github_user_id>` -> `owner/repo`

5) Point SendGrid Inbound Parse for `inbox.scotty.ink` to:
   `https://<project>.vercel.app/api/email`
   Set method = POST, and (for v1) content = `application/x-www-form-urlencoded` or JSON.

## Local test

curl -X POST https://<project>.vercel.app/api/email       -H "Content-Type: application/x-www-form-urlencoded"       --data-urlencode "to=YOUR_GH_LOGIN@inbox.scotty.ink"       --data-urlencode "subject=Scotty via URL-encoded"       --data-urlencode "html=<p>Hello <b>world</b></p>"
