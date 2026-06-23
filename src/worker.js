import { Hono } from "hono";
import { AwsClient } from "aws4fetch";

const app = new Hono();

// ── CORS ──
const normalizeOrigin = (v) =>
  typeof v === "string" ? v.replace(/\/+$/, "") : "";

const applyCors = (c) => {
  const origin = normalizeOrigin(c.req.header("Origin"));
  if (!origin) return;
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
  c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
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

// ── Auth middleware (API_KEY) ──
const authMiddleware = async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const header = (c.req.header("Authorization") || "").trim();
  const token = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : header;
  const queryToken = c.req.query("token") || "";
  const finalToken = token || queryToken;
  if (!finalToken || finalToken !== c.env.API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

app.use("/api/*", authMiddleware);

// ── Helpers ──
const getAwsClient = (env) =>
  new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });

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
    "CREATE INDEX IF NOT EXISTS idx_objects_uploaded ON objects(uploaded_at)",
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_tags_tag ON object_tags(tag)",
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_tags_key ON object_tags(key)",
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
  const filename = c.req.query("filename");
  const contentType = c.req.query("content_type") || "application/octet-stream";
  if (!filename) return c.json({ error: "filename required" }, 400);

  const key = `files/${Date.now()}_${filename}`;
  const body = await c.req.arrayBuffer();

  await c.env.MY_BUCKET.put(key, body, {
    httpMetadata: { contentType },
  });

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

// ── GET /api/tags/top ──
app.get("/api/tags/top", async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: "DB not configured" }, 500);

  const limit = Math.max(1, Math.min(50, Number(c.req.query("limit") || "10") || 10));

  try {
    await ensureSchema(db);
    const rows = await db
      .prepare(
        "SELECT tag, COUNT(*) AS count FROM object_tags GROUP BY tag ORDER BY count DESC, tag ASC LIMIT ?",
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
        "SELECT tag, COUNT(*) AS count FROM object_tags GROUP BY tag ORDER BY count DESC, tag ASC LIMIT ?",
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
         FROM object_tags t
         JOIN object_tags b ON b.key = t.key
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

export default app;
