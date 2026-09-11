---
name: security
description: Build and audit software so it is safe by default — secrets, authentication and authorization, input validation, injection, XSS, CSRF, SSRF, uploads, dependencies and headers, checked against how attacks actually happen.
auto: security, secure, vulnerability, vulnerabilities, auth, authentication, authorization, login, sign in, signup, sign up, password, passwords, jwt, oauth, session cookie, xss, csrf, ssrf, sql injection, injection, secrets, api key, api keys, owasp, harden, hardening, permissions, rate limit
---

# Security

Assume every input is hostile and every secret will be looked for. Most real
breaches come from a short list of boring mistakes; this skill is that list,
with what to do about each.

## 1. Secrets

- **Never in the browser.** Anything imported by client code ships to every
  visitor — including a "temporary" hardcoded key. Keys live in server routes,
  server actions or server-only modules (`import 'server-only'`).
- **Never in the repository.** Use `.env.local` / `.env` (gitignored) and commit
  a `.env.example` with placeholders. If a key was ever committed or pasted
  somewhere public, rotate it — deleting the line does not un-leak it.
- **Never in logs, errors or URLs.** Redact before logging; do not put tokens
  in query strings.
- If the user insists on hardcoding a key for now, put it in one server-only
  file, say exactly where it is, and recommend moving it to an env var.

## 2. Authentication

- Use a proven library or provider (Auth.js/NextAuth, Clerk, Supabase Auth,
  Lucia-style patterns) rather than hand-rolled sessions and hashing.
- Passwords: argon2id or bcrypt, never reversible, never logged. Rate-limit
  login and reset endpoints. Same error message for "no such user" and "wrong
  password".
- Sessions: `HttpOnly`, `Secure`, `SameSite=Lax` (or `Strict`) cookies. Rotate
  the session on login. Expire idle sessions.
- JWTs: short expiry, verify signature and algorithm server-side, never trust
  claims the client can edit.

## 3. Authorization — the most common real hole

- **Check ownership on every request**, on the server, for every object:
  `WHERE id = $1 AND user_id = $session.user`. Changing an ID in a URL or body
  must never reveal someone else's data (IDOR).
- Deny by default. Every route states who may call it.
- Hiding a button is not authorization; the endpoint behind it must check too.

## 4. Input validation and injection

- Validate every input at the boundary with a schema (zod, pydantic): type,
  length, range, format. Reject, do not "clean".
- **SQL:** parameterized queries or an ORM only. Never string-build SQL with
  user input.
- **Shell:** avoid it; if unavoidable, pass arguments as an array
  (`execFile`, `spawn` without `shell: true`), never interpolate.
- **Paths:** resolve and verify the result stays inside the allowed directory;
  reject `..` and absolute paths from users.
- **SSRF:** when fetching a user-supplied URL, allow-list hosts, block private
  and link-local ranges (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
  ::1), and do not follow redirects blindly.

## 5. Output: XSS

- Let the framework escape (React, templating engines). Treat
  `dangerouslySetInnerHTML`, `innerHTML`, `v-html` and markdown-to-HTML as
  red flags: sanitize with DOMPurify if you must render HTML.
- Never put user input into `href` without checking the scheme
  (`javascript:` URLs), or into inline `<script>` or event handlers.
- Set a Content-Security-Policy where you can.

## 6. Requests

- **CSRF:** SameSite cookies plus a CSRF token or origin check on state-changing
  requests that use cookie auth. Next.js server actions check origin; custom
  routes need it done.
- **CORS:** never `*` with credentials; allow-list the origins that need it.
- **Rate limiting** on login, signup, password reset, and any expensive or paid
  endpoint (AI calls especially) — per IP and per user.

## 7. File uploads

- Check type by content (magic bytes), not just the extension or MIME header.
- Enforce a size limit on the server, not only the client.
- Store outside the web root or in object storage with generated names; never
  execute or serve uploads from the app's own origin as HTML.
- Strip metadata (EXIF location) from images when privacy matters.

## 8. Errors, headers, dependencies

- Errors to users are generic; details go to server logs. No stack traces in
  responses.
- Headers: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `frame-ancestors` via CSP.
- Dependencies: `npm audit` (or the ecosystem equivalent), remove unused
  packages, pin versions with a lockfile, be wary of new packages with few
  downloads or typo-like names.

## 9. Auditing existing code

Search rather than read everything:

```
grep for: api[_-]?key|secret|token|password   (hardcoded secrets)
          dangerouslySetInnerHTML|innerHTML|eval\(|new Function
          exec\(|execSync|shell: true|child_process
          \$\{.*\}.*(SELECT|INSERT|UPDATE|DELETE)  (string-built SQL)
          fetch\(.*req\.|axios\(.*req\.         (user-controlled URLs)
```

Then check every route for authentication and ownership checks. Report
findings ranked by severity with the file, the attack, and the fix — and fix
the critical ones first if asked to fix.
