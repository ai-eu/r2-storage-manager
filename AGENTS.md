# R2 Storage Manager — Agent Guidelines

Self-hosted file manager for Cloudflare R2. Backend is a single Cloudflare Worker (Hono + aws4fetch) talking to R2 and D1. Frontend is a vanilla-JS Vue 3 ESM app served as Worker assets, organized into ES modules and composables.

## Stack

- **Backend**: Cloudflare Worker, `hono` router, `aws4fetch` for S3-compatible R2 calls, D1 for metadata/tags.
- **Frontend**: Vue 3 loaded via ESM from `https://unpkg.com/vue@3/...` (no build step, no bundler). PDF.js from cdnjs. Modules are native ES modules with `import`/`export`.
- **Storage bindings** (see `wrangler.toml`): `MY_BUCKET` (R2), `DB` (D1). Vars: `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`. Secrets: `API_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `ALLOWED_ORIGINS`.
- **No TypeScript, no bundler, no test runner.** Keep it that way unless explicitly asked.

## Commands

- `npm run dev` — local dev via `wrangler dev`
- `npm run deploy` — `wrangler deploy`
- `npm run setup` — interactive first-time provisioning (creates R2 bucket, D1 DB, sets secrets, deploys)
- `npm run reset` — wipes bucket + DB (destructive; ask before running)
- `npm run migrate` — `node scripts/migrate-documents.js`

There is no lint/typecheck/test command. Verify changes by running `npm run dev` and exercising the affected flow in the browser.

## Project Layout

```
src/worker.js              # The entire backend. Hono app, auth, all /api/* routes, D1 + R2 ops.
schema.sql                 # Canonical D1 schema. DO NOT modify — see "Database" below.
wrangler.toml              # Worker config + bindings.
public/                    # Frontend assets served by the Worker.
  index.html               # Login page.
  app.html / app.js        # Main app shell + Vue composition root.
  style.css
  modules/
    api/                   # client.js, documents.js, usage.js — fetch wrappers + resource modules.
    composables/           # useXxx.js — Vue composables (state + handlers), dependency-injected.
    image/                 # process.js (decode/autocorrect), thumb.js (thumbnail generation).
    pdf/                   # build.js (PDF.js render/assemble helpers).
    utils/                 # files.js, format.js, tags.js — pure helpers.
scripts/                   # setup.js, reset.js, migrate-documents.js, r2-cors.json.
.github/workflows/         # one-click deploy action.
docs/                      # notes (e.g. create_agents.md).
```

## Architecture Conventions

### Backend (`src/worker.js`)

- Single file. Route handlers are short and delegate to local helpers (`getAwsClient`, `sanitizeFilename`, `normalizeTag`, `normalizeTags`, `parseCsvTags`, `sha256Hex`).
- Auth: `authMiddleware` runs on `/api/*`. Accepts either the `auth` cookie or `Authorization: Bearer <key>`. Token compare uses `constantTimeEqual` — keep using it for any new secret comparison.
- CORS handled by `applyCors` + the `/*` middleware; allowed origins come from `env.ALLOWED_ORIGINS` (comma-separated). Always call `applyCors(c)` in `onError` and after `next()`.
- Public routes (`/api/login`, `/api/logout`) are registered **before** `app.use("/api/*", authMiddleware)`. Keep new public routes above that line.
- R2 keys: sanitize user-supplied filenames with `sanitizeFilename` before building keys. Never use raw user input as an R2 key.
- Tags are normalized via `normalizeTag` (trim + lowercase) and deduped. Use `normalizeTags`/`parseCsvTags` for any tag input.
- D1 access is via `c.env.DB.prepare(...).run()/all()/first()`. Schema is created lazily by `ensureSchema` with `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` migrations guarded by `PRAGMA table_info`.

### Frontend (`public/`)

- **No build step.** Use native ESM `import`/`export`. Vue is imported from the unpkg ESM URL directly in every module that needs it — match this pattern.
- `public/app.js` is the **composition root**: it imports everything, wires composables together, and injects dependencies. Shared refs that bridge composables with circular dependencies (e.g. `uploading`, `pagesViewOpen`) live here and are passed in.
- Composables (`modules/composables/useXxx.js`) are dependency-injected factories: `export function useXxx({ dep1, dep2, ... }) { ... return { ... } }`. **Do not** import other composables or API modules directly inside a composable — accept them as parameters. Document the injected deps in the comment header (see `useDocuments.js` for the canonical format).
- API access goes through `modules/api/client.js` (`apiFetch` redirects to `/` on 401). Resource modules (`documents.js`, `usage.js`) wrap specific endpoints; composables call those, never `fetch` directly.
- Pure helpers belong in `modules/utils/` (no Vue imports, no side effects).
- Image/PDF processing helpers in `modules/image/` and `modules/pdf/` are framework-agnostic and operate on `Blob`/`ArrayBuffer`/canvas.
- Pan/zoom/pinch logic is centralized in `usePanZoom.js` (supports `translate` and `scroll` pan modes). Reuse it for new viewers instead of reimplementing pointer handling.

## Database

- `schema.sql` is the **current, authoritative schema**. Do **not** modify it or run migrations that change it without explicit user approval.
- Tables: `objects`, `object_tags`, `documents`, `document_tags`, `usage_cache`. See `schema.sql` for columns and indexes.
- `objects` rows can be standalone files or pages belonging to a `document_id` (with `page_number` and `original_key`).
- When adding columns, follow the existing `ensureSchema` pattern: `PRAGMA table_info` check + `ALTER TABLE ADD COLUMN`, and **do not** edit `schema.sql`.

## Code Style

- **Two spaces indentation, no tabs.** Apply to all new and existing files.
- Single quotes for strings. Trailing commas in multi-line arrays/objects.
- Keep route handlers and composable methods short; extract reusable logic into helpers.
- Comments: preserve existing comments. The `// ── Section ──` divider style is used throughout `worker.js` — follow it for new sections.
- Don't add verbose try/catch around every line; match the existing minimal error-handling style. `worker.js`'s `app.onError` is the global boundary.
- No emojis in code or UI unless explicitly requested.

## Security

- Never log or expose `API_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. They come from `env` and stay server-side.
- Always use `constantTimeEqual` for secret/token comparisons.
- Always sanitize filenames and normalize tags before storing or using them as keys.
- Auth cookie is `HttpOnly; Secure; SameSite=Strict`. Keep these attributes on any new cookies.
- R2 presigned download URLs (if added) must be short-lived.

## Workflow

- For bug fixes / features: reproduce the issue, trace the code path, fix the root cause, then verify by running `npm run dev` and exercising the flow in the browser.
- After edits, check for syntax errors (e.g. `node --check` on changed JS files).
- Don't run `npm run reset` or `npm run migrate` without explicit confirmation — they are destructive / schema-affecting.
- Don't push or commit unless asked. When committing, follow the existing `feat:/refactor:/fix:` conventional-commit style seen in `git log`.
