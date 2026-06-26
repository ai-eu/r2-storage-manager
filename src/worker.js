import { Hono } from "hono";
import { AwsClient } from "aws4fetch";

const app = new Hono();

// ── CORS ──
const normalizeOrigin = (v) =>
  typeof v === "string" ? v.replace(/\/+$/, "") : "";

const isAllowedOrigin = (origin, env) => {
  if (!origin) return false;
  const allowed = env.ALLOWED_ORIGINS;
  if (!allowed) return false;
  return allowed
    .split(",")
    .map((s) => normalizeOrigin(s.trim()))
    .includes(origin);
};

const applyCors = (c) => {
  const origin = normalizeOrigin(c.req.header("Origin"));
  if (!isAllowedOrigin(origin, c.env)) return;
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
  c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Access-Control-Max-Age", "86400");
};

app.onError((err, c) => {
  applyCors(c);
  return c.json({ error: err?.message || String(err) }, 500);
});

app.use("/*", async (c, next) => {
  applyCors(c);
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
  applyCors(c);
});

// ── Auth helpers ──
const constantTimeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
};

const getCookie = (headerValue, name) => {
  if (!headerValue) return null;
  for (const part of headerValue.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.length ? decodeURIComponent(v.join("=")) : null;
  }
  return null;
};

// ── Auth endpoints (public, before middleware) ──
app.post("/api/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!key) return c.json({ error: "apiKey required" }, 400);
  if (!constantTimeEqual(key, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.header(
    "Set-Cookie",
    `auth=${encodeURIComponent(key)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`,
  );
  return c.json({ success: true });
});

app.post("/api/logout", (c) => {
  c.header(
    "Set-Cookie",
    "auth=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
  );
  return c.json({ success: true });
});

// ── Auth middleware ──
const authMiddleware = async (c, next) => {
  if (c.req.method === "OPTIONS") return next();

  const cookieToken = getCookie(c.req.header("Cookie"), "auth");
  if (cookieToken && constantTimeEqual(cookieToken, c.env.API_KEY)) {
    await next();
    return;
  }

  const header = (c.req.header("Authorization") || "").trim();
  const bearerToken = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : "";
  if (bearerToken && constantTimeEqual(bearerToken, c.env.API_KEY)) {
    await next();
    return;
  }

  return c.json({ error: "Unauthorized" }, 401);
};

app.use("/api/*", authMiddleware);

app.get("/api/auth/check", (c) => c.json({ authenticated: true }));

// ── Helpers ──
const getAwsClient = (env) =>
  new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });

const sanitizeFilename = (name) => {
  if (typeof name !== "string") return "";
  return name.replace(/\0/g, "").replace(/\.\./g, "_").replace(/[/\\]/g, "_").trim();
};

const normalizeTag = (t) =>
  typeof t === "string" ? t.trim().toLowerCase() : "";

const normalizeTags = (tags) => {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(normalizeTag).filter(Boolean))];
};

const parseCsvTags = (csv) =>
  typeof csv === "string"
    ? normalizeTags(csv.split(",").map((s) => s.trim()).filter(Boolean))
    : [];

const sha256Hex = async (text) => {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// ── D1 schema ──
let schemaReady = false;
const ensureSchema = async (db) => {
  if (schemaReady) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS objects (
      key TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      content_type TEXT,
      size INTEGER,
      uploaded_at INTEGER NOT NULL,
      thumb_key TEXT
    )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS object_tags (
      key TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (key, tag)
    )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 1,
      uploaded_at INTEGER NOT NULL,
      thumb_key TEXT
    )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS document_tags (
      document_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (document_id, tag)
    )`,
  ).run();

  const cols = await db.prepare("PRAGMA table_info(objects)").all();
  const colNames = new Set((cols.results || []).map((r) => r.name));
  if (!colNames.has("document_id")) {
    await db.prepare("ALTER TABLE objects ADD COLUMN document_id TEXT").run();
  }
  if (!colNames.has("page_number")) {
    await db.prepare("ALTER TABLE objects ADD COLUMN page_number INTEGER").run();
  }
  if (!colNames.has("original_key")) {
    await db.prepare("ALTER TABLE objects ADD COLUMN original_key TEXT").run();
  }

  const docCols = await db.prepare("PRAGMA table_info(documents)").all();
  const docColNames = new Set((docCols.results || []).map((r) => r.name));
  if (!docColNames.has("pdf_key")) {
    await db.prepare("ALTER TABLE documents ADD COLUMN pdf_key TEXT").run();
  }
  if (!docColNames.has("correction_settings")) {
    await db.prepare("ALTER TABLE documents ADD COLUMN correction_settings TEXT").run();
  }

  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_objects_uploaded ON objects(uploaded_at)",
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_tags_tag ON object_tags(tag)",
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_tags_key ON object_tags(key)",
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_objects_document ON objects(document_id)",
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_documents_uploaded ON documents(uploaded_at)",
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_document_tags_tag ON document_tags(tag)",
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_document_tags_doc ON document_tags(document_id)",
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS usage_cache (
      date TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )`,
  ).run();
  schemaReady = true;
};

// ── GET /api/objects ──
app.get("/api/objects", async (c) => {
  const tag = normalizeTag(c.req.query("tag") || "");
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  try {
    await ensureSchema(db);

    const parts = [
      "SELECT o.key, o.filename, o.content_type, o.size, o.uploaded_at, o.thumb_key,",
      "  COALESCE(GROUP_CONCAT(t.tag), '') AS tags",
      "FROM objects o",
      "LEFT JOIN object_tags t ON t.key = o.key",
      "WHERE 1=1",
    ];
    const bindings = [];

    if (tag) {
      parts.push(
        "AND EXISTS (SELECT 1 FROM object_tags t2 WHERE t2.key = o.key AND t2.tag = ?)",
      );
      bindings.push(tag);
    }

    parts.push("GROUP BY o.key", "ORDER BY o.uploaded_at DESC", "LIMIT 200");

    const rows = await db
      .prepare(parts.join("\n"))
      .bind(...bindings)
      .all();

    const objects = (rows.results || []).map((r) => ({
      key: r.key,
      filename: r.filename,
      content_type: r.content_type,
      size: r.size,
      uploaded_at: r.uploaded_at,
      thumb_key: r.thumb_key || null,
      tags: parseCsvTags(r.tags || ""),
    }));

    return c.json({ objects });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── POST /api/objects/upload ──
app.post("/api/objects/upload", async (c) => {
  const filename = sanitizeFilename(c.req.query("filename"));
  const contentType = c.req.query("content_type") || "application/octet-stream";
  if (!filename) return c.json({ error: "filename required" }, 400);

  const key = `files/${Date.now()}_${filename}`;
  const body = await c.req.arrayBuffer();

  await c.env.MY_BUCKET.put(key, body, {
    httpMetadata: { contentType },
  });

  return c.json({ key });
});

// ── PUT /api/objects/replace — overwrite existing R2 object by key ──
app.put("/api/objects/replace", async (c) => {
  const key = c.req.query("key");
  const contentType = c.req.query("content_type") || "application/octet-stream";
  if (!key) return c.json({ error: "key required" }, 400);

  const body = await c.req.arrayBuffer();
  await c.env.MY_BUCKET.put(key, body, { httpMetadata: { contentType } });

  return c.json({ key });
});

// ── POST /api/objects/thumb-upload ──
app.post("/api/objects/thumb-upload", async (c) => {
  const key = c.req.query("key");
  const ext = c.req.query("ext") || "jpg";
  if (!key) return c.json({ error: "key required" }, 400);

  const hash = await sha256Hex(key);
  const thumbKey = `thumbs/${hash}.${ext}`;
  const contentType = ext === "webp" ? "image/webp" : "image/jpeg";
  const body = await c.req.arrayBuffer();

  await c.env.MY_BUCKET.put(thumbKey, body, {
    httpMetadata: { contentType },
  });

  return c.json({ thumb_key: thumbKey });
});

// ── POST /api/objects/register ──
app.post("/api/objects/register", async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const { key, filename, content_type, size, thumb_key } = body;
  const uploadedAt = Number.isFinite(body.uploaded_at) ? body.uploaded_at : Date.now();
  const tags = normalizeTags(body.tags);

  if (!key || typeof filename !== "string" || !filename.trim()) {
    return c.json({ error: "key and filename required" }, 400);
  }

  try {
    await ensureSchema(db);
    const stmts = [
      db.prepare(
        `INSERT INTO objects(key, filename, content_type, size, uploaded_at, thumb_key)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET
           filename=excluded.filename, content_type=excluded.content_type,
           size=excluded.size, uploaded_at=excluded.uploaded_at, thumb_key=excluded.thumb_key`,
      ).bind(key, filename.trim(), content_type || null, size || null, uploadedAt, thumb_key || null),
      db.prepare("DELETE FROM object_tags WHERE key=?").bind(key),
    ];
    for (const tag of tags) {
      stmts.push(
        db.prepare("INSERT OR IGNORE INTO object_tags(key, tag) VALUES(?,?)").bind(key, tag),
      );
    }
    await db.batch(stmts);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── PUT /api/objects/tags ──
app.put("/api/objects/tags", async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const { key } = body;
  const tags = normalizeTags(body.tags);
  if (!key) return c.json({ error: "key required" }, 400);

  try {
    await ensureSchema(db);
    const exists = await db
      .prepare("SELECT 1 AS ok FROM objects WHERE key=? LIMIT 1")
      .bind(key)
      .first();
    if (!exists) return c.json({ error: "Not found" }, 404);

    const stmts = [
      db.prepare("DELETE FROM object_tags WHERE key=?").bind(key),
    ];
    for (const tag of tags) {
      stmts.push(
        db.prepare("INSERT OR IGNORE INTO object_tags(key, tag) VALUES(?,?)").bind(key, tag),
      );
    }
    await db.batch(stmts);
    return c.json({ success: true, tags });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── POST /api/documents/register ──
app.post("/api/documents/register", async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const { id, title, pages, thumb_key } = body;
  const tags = normalizeTags(body.tags);
  const uploadedAt = Number.isFinite(body.uploaded_at) ? body.uploaded_at : Date.now();

  if (!id || typeof title !== "string" || !title.trim()) {
    return c.json({ error: "id and title required" }, 400);
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    return c.json({ error: "pages array required" }, 400);
  }

  try {
    await ensureSchema(db);
    const stmts = [
      db.prepare(
        `INSERT INTO documents(id, title, page_count, uploaded_at, thumb_key)
         VALUES(?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, page_count=excluded.page_count,
           uploaded_at=excluded.uploaded_at, thumb_key=excluded.thumb_key`,
      ).bind(id, title.trim(), pages.length, uploadedAt, thumb_key || null),
      db.prepare("DELETE FROM document_tags WHERE document_id=?").bind(id),
    ];

    for (const tag of tags) {
      stmts.push(
        db.prepare(
          "INSERT OR IGNORE INTO document_tags(document_id, tag) VALUES(?,?)",
        ).bind(id, tag),
      );
    }

    for (const p of pages) {
      if (!p.key || typeof p.filename !== "string" || !p.filename.trim()) continue;
      stmts.push(
        db.prepare(
          `INSERT INTO objects(key, filename, content_type, size, uploaded_at, thumb_key, document_id, page_number, original_key)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET
             filename=excluded.filename, content_type=excluded.content_type,
             size=excluded.size, uploaded_at=excluded.uploaded_at, thumb_key=excluded.thumb_key,
             document_id=excluded.document_id, page_number=excluded.page_number,
             original_key=excluded.original_key`,
        ).bind(
          p.key, p.filename.trim(), p.content_type || null,
          p.size || null, uploadedAt, p.thumb_key || null,
          id, p.page_number || null, p.original_key || null,
        ),
      );
    }

    await db.batch(stmts);
    return c.json({ success: true, document_id: id });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── GET /api/documents ──
app.get("/api/documents", async (c) => {
  const tag = normalizeTag(c.req.query("tag") || "");
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  try {
    await ensureSchema(db);

    const parts = [
      "SELECT d.id, d.title, d.page_count, d.uploaded_at, d.thumb_key, d.pdf_key,",
      "  COALESCE(GROUP_CONCAT(dt.tag), '') AS tags",
      "FROM documents d",
      "LEFT JOIN document_tags dt ON dt.document_id = d.id",
      "WHERE 1=1",
    ];
    const bindings = [];

    if (tag) {
      parts.push(
        "AND EXISTS (SELECT 1 FROM document_tags dt2 WHERE dt2.document_id = d.id AND dt2.tag = ?)",
      );
      bindings.push(tag);
    }

    parts.push("GROUP BY d.id", "ORDER BY d.uploaded_at DESC", "LIMIT 200");

    const rows = await db
      .prepare(parts.join("\n"))
      .bind(...bindings)
      .all();

    const documents = (rows.results || []).map((r) => ({
      id: r.id,
      title: r.title,
      page_count: r.page_count,
      uploaded_at: r.uploaded_at,
      thumb_key: r.thumb_key || null,
      pdf_key: r.pdf_key || null,
      tags: parseCsvTags(r.tags || ""),
    }));

    return c.json({ documents });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── GET /api/documents/:id/pages ──
app.get("/api/documents/:id{[^/]+}/pages", async (c) => {
  const docId = c.req.param("id");
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  try {
    await ensureSchema(db);
    const rows = await db
      .prepare(
        "SELECT key, filename, content_type, size, uploaded_at, thumb_key, page_number FROM objects WHERE document_id=? ORDER BY page_number",
      ).bind(docId)
      .all();

    const pages = (rows.results || []).map((r) => ({
      key: r.key,
      filename: r.filename,
      content_type: r.content_type,
      size: r.size,
      uploaded_at: r.uploaded_at,
      thumb_key: r.thumb_key || null,
      page_number: r.page_number || 1,
    }));

    return c.json({ pages });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── POST /api/documents/:id/pages ──
app.post("/api/documents/:id{[^/]+}/pages", async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const docId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const pages = Array.isArray(body.pages) ? body.pages : [];
  if (pages.length === 0) return c.json({ error: "pages array required" }, 400);

  try {
    await ensureSchema(db);

    const doc = await db
      .prepare("SELECT id, page_count FROM documents WHERE id=?")
      .bind(docId)
      .first();
    if (!doc) return c.json({ error: "Document not found" }, 404);

    const startPage = (doc.page_count || 0) + 1;
    const stmts = [];

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (!p.key || typeof p.filename !== "string" || !p.filename.trim()) continue;
      stmts.push(
        db.prepare(
          `INSERT INTO objects(key, filename, content_type, size, uploaded_at, thumb_key, document_id, page_number, original_key)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET
             filename=excluded.filename, content_type=excluded.content_type,
             size=excluded.size, uploaded_at=excluded.uploaded_at, thumb_key=excluded.thumb_key,
             document_id=excluded.document_id, page_number=excluded.page_number,
             original_key=excluded.original_key`,
        ).bind(
          p.key, p.filename.trim(), p.content_type || null,
          p.size || null, Date.now(), p.thumb_key || null,
          docId, startPage + i, p.original_key || null,
        ),
      );
    }

    const newPageCount = startPage + pages.length - 1;
    stmts.push(
      db.prepare("UPDATE documents SET page_count=? WHERE id=?").bind(newPageCount, docId),
    );

    await db.batch(stmts);
    return c.json({ success: true, document_id: docId, page_count: newPageCount });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── DELETE /api/documents/:id ──
app.delete("/api/documents/:id{[^/]+}", async (c) => {
  const docId = c.req.param("id");
  if (!docId) return c.json({ error: "id required" }, 400);

  try {
    const db = c.env.DB;
    if (!db) return c.json({ error: "DB not configured" }, 500);
    await ensureSchema(db);

    const docRow = await db
      .prepare("SELECT thumb_key FROM documents WHERE id=?")
      .bind(docId)
      .first();

    const pageRows = await db
      .prepare("SELECT key, thumb_key FROM objects WHERE document_id=?")
      .bind(docId)
      .all();

    for (const r of (pageRows.results || [])) {
      try { await c.env.MY_BUCKET.delete(r.key); } catch {}
      if (r.thumb_key) {
        try { await c.env.MY_BUCKET.delete(r.thumb_key); } catch {}
      }
    }
    if (docRow?.thumb_key) {
      try { await c.env.MY_BUCKET.delete(docRow.thumb_key); } catch {}
    }

    await db.batch([
      db.prepare("DELETE FROM objects WHERE document_id=?").bind(docId),
      db.prepare("DELETE FROM document_tags WHERE document_id=?").bind(docId),
      db.prepare("DELETE FROM documents WHERE id=?").bind(docId),
    ]);

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── DELETE /api/documents/:id/pages ──
app.delete("/api/documents/:id{[^/]+}/pages", async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const docId = c.req.param("id");
  const pageKey = c.req.query("key");
  if (!pageKey) return c.json({ error: "key required" }, 400);

  try {
    await ensureSchema(db);

    const pageRow = await db
      .prepare("SELECT key, thumb_key, page_number FROM objects WHERE key=? AND document_id=?")
      .bind(pageKey, docId)
      .first();
    if (!pageRow) return c.json({ error: "Page not found" }, 404);

    try { await c.env.MY_BUCKET.delete(pageRow.key); } catch {}
    if (pageRow.thumb_key) {
      try { await c.env.MY_BUCKET.delete(pageRow.thumb_key); } catch {}
    }

    await db.batch([
      db.prepare("DELETE FROM object_tags WHERE key=?").bind(pageKey),
      db.prepare("DELETE FROM objects WHERE key=?").bind(pageKey),
    ]);

    const remaining = await db
      .prepare("SELECT key, thumb_key, page_number FROM objects WHERE document_id=? ORDER BY page_number")
      .bind(docId)
      .all();
    const pages = remaining.results || [];

    if (pages.length === 0) {
      const docRow = await db.prepare("SELECT thumb_key FROM documents WHERE id=?").bind(docId).first();
      if (docRow?.thumb_key && docRow.thumb_key !== pageRow.thumb_key) {
        try { await c.env.MY_BUCKET.delete(docRow.thumb_key); } catch {}
      }
      await db.batch([
        db.prepare("DELETE FROM document_tags WHERE document_id=?").bind(docId),
        db.prepare("DELETE FROM documents WHERE id=?").bind(docId),
      ]);
      return c.json({ success: true, document_deleted: true });
    }

    const stmts = [];
    for (let i = 0; i < pages.length; i++) {
      stmts.push(
        db.prepare("UPDATE objects SET page_number=? WHERE key=?").bind(i + 1, pages[i].key),
      );
    }

    const docRow = await db.prepare("SELECT thumb_key FROM documents WHERE id=?").bind(docId).first();
    if (docRow?.thumb_key === pageRow.thumb_key) {
      const newThumb = pages[0].thumb_key || null;
      stmts.push(
        db.prepare("UPDATE documents SET page_count=?, thumb_key=? WHERE id=?").bind(pages.length, newThumb, docId),
      );
    } else {
      stmts.push(
        db.prepare("UPDATE documents SET page_count=? WHERE id=?").bind(pages.length, docId),
      );
    }

    await db.batch(stmts);
    return c.json({ success: true, page_count: pages.length });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── PUT /api/documents/:id/page-order ──
// Body: { keys: ["key1","key2",...] } — full ordered list of page keys
app.put("/api/documents/:id{[^/]+}/page-order", async (c) => {
  const docId = c.req.param("id");
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.keys) || body.keys.length === 0) {
    return c.json({ error: "keys array required" }, 400);
  }

  try {
    await ensureSchema(db);
    const stmts = body.keys.map((key, i) =>
      db.prepare("UPDATE objects SET page_number=? WHERE key=? AND document_id=?")
        .bind(i + 1, key, docId),
    );
    await db.batch(stmts);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── GET /api/documents/:id/pdf-settings ──
app.get("/api/documents/:id{[^/]+}/pdf-settings", async (c) => {
  const docId = c.req.param("id");
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  try {
    await ensureSchema(db);

    const doc = await db
      .prepare("SELECT pdf_key, correction_settings FROM documents WHERE id=? LIMIT 1")
      .bind(docId)
      .first();
    if (!doc) return c.json({ error: "Not found" }, 404);

    const rows = await db
      .prepare(
        "SELECT key, original_key, thumb_key, page_number FROM objects WHERE document_id=? ORDER BY page_number",
      )
      .bind(docId)
      .all();

    let correctionSettings = null;
    try { correctionSettings = doc.correction_settings ? JSON.parse(doc.correction_settings) : null; } catch {}

    return c.json({
      pdf_key: doc.pdf_key || null,
      correction_settings: correctionSettings,
      pages: (rows.results || []).map((r) => ({
        key: r.key,
        original_key: r.original_key || null,
        thumb_key: r.thumb_key || null,
        page_number: r.page_number || 1,
      })),
    });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── PUT /api/documents/:id/pdf ──
app.put("/api/documents/:id{[^/]+}/pdf", async (c) => {
  const docId = c.req.param("id");
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const { pdf_key, correction_settings, thumb_key, pages } = body;

  try {
    await ensureSchema(db);

    const exists = await db
      .prepare("SELECT 1 AS ok FROM documents WHERE id=? LIMIT 1")
      .bind(docId)
      .first();
    if (!exists) return c.json({ error: "Not found" }, 404);

    // Build documents UPDATE dynamically — only set thumb_key if provided
    const docSetParts = ["pdf_key=?", "correction_settings=?"];
    const docBinds = [
      pdf_key || null,
      correction_settings ? JSON.stringify(correction_settings) : null,
    ];
    if (thumb_key !== undefined) {
      docSetParts.push("thumb_key=?");
      docBinds.push(thumb_key || null);
    }
    docBinds.push(docId);

    const stmts = [
      db.prepare(`UPDATE documents SET ${docSetParts.join(", ")} WHERE id=?`).bind(...docBinds),
    ];

    if (Array.isArray(pages)) {
      for (const p of pages) {
        if (!p.key) continue;
        if (p.thumb_key !== undefined) {
          // Set original_key only if not already set (never overwrite an existing original)
          stmts.push(
            db.prepare("UPDATE objects SET original_key=COALESCE(original_key,?), thumb_key=? WHERE key=? AND document_id=?")
              .bind(p.original_key || null, p.thumb_key, p.key, docId),
          );
        } else {
          stmts.push(
            db.prepare("UPDATE objects SET original_key=COALESCE(original_key,?) WHERE key=? AND document_id=?")
              .bind(p.original_key || null, p.key, docId),
          );
        }
      }
    }

    await db.batch(stmts);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── PUT /api/documents/:id/tags ──
app.put("/api/documents/:id{[^/]+}/tags", async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const docId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const tags = normalizeTags(body.tags);
  if (!docId) return c.json({ error: "id required" }, 400);

  try {
    await ensureSchema(db);
    const exists = await db
      .prepare("SELECT 1 AS ok FROM documents WHERE id=? LIMIT 1")
      .bind(docId)
      .first();
    if (!exists) return c.json({ error: "Not found" }, 404);

    const stmts = [
      db.prepare("DELETE FROM document_tags WHERE document_id=?").bind(docId),
    ];
    for (const tag of tags) {
      stmts.push(
        db.prepare(
          "INSERT OR IGNORE INTO document_tags(document_id, tag) VALUES(?,?)",
        ).bind(docId, tag),
      );
    }
    await db.batch(stmts);
    return c.json({ success: true, tags });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── GET /api/tags/top ──
app.get("/api/tags/top", async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const limit = Math.max(1, Math.min(50, Number(c.req.query("limit") || "10") || 10));

  try {
    await ensureSchema(db);
    const rows = await db
      .prepare(
        "SELECT tag, COUNT(*) AS count FROM document_tags GROUP BY tag ORDER BY count DESC, tag ASC LIMIT ?",
      )
      .bind(limit)
      .all();
    return c.json({ tags: (rows.results || []).map((r) => ({ tag: r.tag, count: r.count })) });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── GET /api/tags/all ──
app.get("/api/tags/all", async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const limit = Math.max(1, Math.min(500, Number(c.req.query("limit") || "500") || 500));

  try {
    await ensureSchema(db);
    const rows = await db
      .prepare(
        "SELECT tag, COUNT(*) AS count FROM document_tags GROUP BY tag ORDER BY count DESC, tag ASC LIMIT ?",
      )
      .bind(limit)
      .all();
    return c.json({ tags: (rows.results || []).map((r) => ({ tag: r.tag, count: r.count })) });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── GET /api/tags/related ──
app.get("/api/tags/related", async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const baseTag = normalizeTag(c.req.query("tag") || "");
  if (!baseTag) return c.json({ tags: [] });

  const limit = Math.max(1, Math.min(50, Number(c.req.query("limit") || "10") || 10));

  try {
    await ensureSchema(db);
    const rows = await db
      .prepare(
        `SELECT t.tag, COUNT(*) AS count
         FROM document_tags t
         JOIN document_tags b ON b.document_id = t.document_id
         WHERE b.tag = ? AND t.tag <> ?
         GROUP BY t.tag ORDER BY count DESC, t.tag ASC LIMIT ?`,
      )
      .bind(baseTag, baseTag, limit)
      .all();
    return c.json({ tags: (rows.results || []).map((r) => ({ tag: r.tag, count: r.count })) });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── GET /api/objects/download-url ──
app.get("/api/objects/download-url", async (c) => {
  const key = c.req.query("key");
  if (!key) return c.json({ error: "key required" }, 400);

  const object = await c.env.MY_BUCKET.get(key);
  if (!object) return c.json({ error: "not found" }, 404);

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": object.size,
      "Content-Disposition": `inline; filename="${key.split("/").pop()}"`,
    },
  });
});

// ── GET /api/objects/thumb-download-url ──
app.get("/api/objects/thumb-download-url", async (c) => {
  const thumbKey = c.req.query("thumb_key");
  if (!thumbKey) return c.json({ error: "thumb_key required" }, 400);

  const object = await c.env.MY_BUCKET.get(thumbKey);
  if (!object) return c.json({ error: "not found" }, 404);

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// ── DELETE /api/objects/:key ──
app.delete("/api/objects/:key{.*}", async (c) => {
  const key = c.req.param("key");
  if (!key) return c.json({ error: "key required" }, 400);

  try {
    // Delete main file
    await c.env.MY_BUCKET.delete(key);

    // Delete thumb if exists
    const db = c.env.DB;
    if (db) {
      await ensureSchema(db);
      const row = await db
        .prepare("SELECT thumb_key FROM objects WHERE key=?")
        .bind(key)
        .first();
      if (row?.thumb_key) {
        try { await c.env.MY_BUCKET.delete(row.thumb_key); } catch {}
      }
      await db.batch([
        db.prepare("DELETE FROM object_tags WHERE key=?").bind(key),
        db.prepare("DELETE FROM objects WHERE key=?").bind(key),
      ]);
    }
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ── GET /api/usage ──
const WORKERS_FREE_LIMIT = 100000;

const fetchWorkersUsage = async (env) => {
  const accountId = env.R2_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!accountId || !token) return null;

  const today = new Date().toISOString().slice(0, 10);

  const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query {
        viewer {
          accounts(filter: { accountTag: "${accountId}" }) {
            workersInvocationsAdaptive(
              filter: { date_geq: "${today}", date_leq: "${today}" }
              limit: 100
            ) {
              sum { requests }
            }
          }
        }
      }`,
    }),
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  const accounts = data?.data?.viewer?.accounts;
  if (!accounts || !accounts.length) return null;

  let total = 0;
  for (const acc of accounts) {
    const groups = acc.workersInvocationsAdaptive || [];
    for (const g of groups) {
      total += g?.sum?.requests || 0;
    }
  }

  return { used: total, limit: WORKERS_FREE_LIMIT, remaining: WORKERS_FREE_LIMIT - total, date: today };
};

app.get("/api/usage", async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  try {
    await ensureSchema(db);

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const hourBucket = now.toISOString().slice(0, 13);
    const cached = await db
      .prepare("SELECT data FROM usage_cache WHERE date=?")
      .bind(hourBucket)
      .first();

    if (cached) {
      return c.json(JSON.parse(cached.data));
    }

    const usage = await fetchWorkersUsage(c.env);
    if (!usage) {
      return c.json({ used: 0, limit: WORKERS_FREE_LIMIT, remaining: WORKERS_FREE_LIMIT, date: today, unavailable: true });
    }

    await db.batch([
      db.prepare("DELETE FROM usage_cache WHERE date <> ?").bind(hourBucket),
      db.prepare(
        "INSERT OR REPLACE INTO usage_cache(date, data, fetched_at) VALUES(?,?,?)",
      ).bind(hourBucket, JSON.stringify(usage), Date.now()),
    ]);

    return c.json(usage);
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

export default app;
