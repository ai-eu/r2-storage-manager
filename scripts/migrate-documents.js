#!/usr/bin/env node

const { spawnSync } = require("child_process");
const path = require("path");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

const ROOT = path.resolve(__dirname, "..");

function getWranglerEntry() {
  try { return require.resolve("wrangler"); } catch {
    return path.join(ROOT, "node_modules", "wrangler", "wrangler-dist", "cli.js");
  }
}

function wrangler(args, opts = {}) {
  const result = spawnSync(process.execPath, [getWranglerEntry(), ...args], {
    encoding: "utf-8",
    stdio: opts.input != null ? ["pipe", "pipe", "pipe"] : ["inherit", "pipe", "pipe"],
    input: opts.input,
    cwd: ROOT,
  });
  const out = (result.stdout || "") + (result.stderr || "");
  if (!opts.ignoreError && result.status !== 0) {
    throw new Error(out.slice(0, 500) || `Exit code ${result.status}`);
  }
  return out;
}

function d1Execute(sql) {
  return wrangler(["d1", "execute", "r2-storage", "--command", sql, "--remote"]);
}

function d1Count(sql) {
  const out = wrangler(["d1", "execute", "r2-storage", "--command", sql, "--json", "--remote"], { ignoreError: true });
  try {
    const parsed = JSON.parse(out);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    const vals = row ? Object.values(row) : [];
    return vals[0] ?? "?";
  } catch {
    return "?";
  }
}

async function main() {
  console.log("\n📦 R2 Storage Manager — Migration to documents\n");
  console.log("This script migrates existing objects to the new documents schema:");
  console.log("  - Creates documents rows for objects without one");
  console.log("  - Sets document_id and page_number on objects");
  console.log("  - Copies tags from object_tags to document_tags");
  console.log("  - Runs against the REMOTE D1 database\n");
  console.log("  - Safe to re-run (uses ON CONFLICT/INSERT OR IGNORE)\n");

  const confirm = await ask("Type YES to continue: ");
  if (confirm !== "YES") {
    console.log("Aborted.");
    rl.close();
    return;
  }

  // 1. Ensure schema
  console.log("\n1/4  Ensuring schema exists...");
  try {
    d1Execute(`CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 1,
      uploaded_at INTEGER NOT NULL,
      thumb_key TEXT
    )`);
    d1Execute(`CREATE TABLE IF NOT EXISTS document_tags (
      document_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (document_id, tag)
    )`);
    d1Execute(`CREATE INDEX IF NOT EXISTS idx_objects_document ON objects(document_id)`);
    d1Execute(`CREATE INDEX IF NOT EXISTS idx_documents_uploaded ON documents(uploaded_at)`);
    d1Execute(`CREATE INDEX IF NOT EXISTS idx_document_tags_tag ON document_tags(tag)`);
    d1Execute(`CREATE INDEX IF NOT EXISTS idx_document_tags_doc ON document_tags(document_id)`);
    console.log("   Schema OK");
  } catch (e) {
    console.log("   Error: " + (e.message || "").slice(0, 200));
    rl.close();
    return;
  }

  // 2. Create documents for all objects that don't have one yet
  //    Uses INSERT...SELECT to avoid JS parsing issues
  console.log("\n2/4  Creating documents for orphan objects...");
  try {
    d1Execute(
      `INSERT OR IGNORE INTO documents(id, title, page_count, uploaded_at, thumb_key)
       SELECT key, filename, 1, uploaded_at, thumb_key
       FROM objects
       WHERE document_id IS NULL
          OR document_id NOT IN (SELECT id FROM documents)`
    );
    console.log("   Documents created (if any orphans)");
  } catch (e) {
    console.log("   Error: " + (e.message || "").slice(0, 200));
  }

  // 3. Update objects: set document_id = key, page_number = 1 where missing
  console.log("\n3/4  Updating objects with document_id and page_number...");
  try {
    d1Execute(`UPDATE objects SET document_id = key, page_number = 1 WHERE document_id IS NULL`);
    console.log("   Objects updated");
  } catch (e) {
    console.log("   Error: " + (e.message || "").slice(0, 200));
  }

  // 4. Migrate tags
  console.log("\n4/4  Migrating tags from object_tags to document_tags...");
  try {
    d1Execute(
      `INSERT OR IGNORE INTO document_tags(document_id, tag)
       SELECT key, tag FROM object_tags`
    );
    console.log("   Tags migrated");
  } catch (e) {
    console.log("   Error: " + (e.message || "").slice(0, 200));
  }

  // Verify
  console.log("\n── Verification ──");
  const orphanCount = d1Count(`SELECT COUNT(*) as c FROM objects WHERE document_id IS NULL`);
  console.log(`   Objects without document_id: ${orphanCount}`);
  const docCount = d1Count(`SELECT COUNT(*) as c FROM documents`);
  console.log(`   Total documents: ${docCount}`);
  const objCount = d1Count(`SELECT COUNT(*) as c FROM objects`);
  console.log(`   Total objects: ${objCount}`);
  const tagCount = d1Count(`SELECT COUNT(*) as c FROM document_tags`);
  console.log(`   Total document_tags: ${tagCount}`);

  console.log("\n" + "=".repeat(60));
  console.log("Migration complete.");
  console.log("=".repeat(60) + "\n");

  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
