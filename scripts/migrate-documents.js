#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
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

function d1Execute(sql, remote = true) {
  const args = ["d1", "execute", "r2-storage", "--command", sql];
  if (remote) args.push("--remote");
  return wrangler(args);
}

function d1Query(sql, remote = true) {
  const args = ["d1", "execute", "r2-storage", "--command", sql, "--json"];
  if (remote) args.push("--remote");
  const out = wrangler(args, { ignoreError: true });
  try {
    return JSON.parse(out);
  } catch {
    return [];
  }
}

async function main() {
  console.log("\n📦 R2 Storage Manager — Migration to documents\n");
  console.log("This script migrates existing objects to the new documents schema:");
  console.log("  - Creates a 'documents' row for each object without document_id");
  console.log("  - Sets document_id and page_number on objects");
  console.log("  - Copies tags from object_tags to document_tags");
  console.log("  - Runs against the REMOTE D1 database\n");

  const confirm = await ask("Type YES to continue: ");
  if (confirm !== "YES") {
    console.log("Aborted.");
    rl.close();
    return;
  }

  // 1. Ensure schema (tables + columns) exists
  console.log("\n1/5  Ensuring schema exists...");
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

    const cols = d1Query(`SELECT name FROM pragma_table_info('objects')`);
    const colNames = new Set((Array.isArray(cols) ? cols : []).flatMap((r) => Object.values(r)));
    if (!colNames.has("document_id")) {
      d1Execute(`ALTER TABLE objects ADD COLUMN document_id TEXT`);
      console.log("   Added column document_id");
    }
    if (!colNames.has("page_number")) {
      d1Execute(`ALTER TABLE objects ADD COLUMN page_number INTEGER`);
      console.log("   Added column page_number");
    }

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

  // 2. Find objects without document_id
  console.log("\n2/5  Finding objects without document_id...");
  let orphans = [];
  try {
    orphans = d1Query(`SELECT key, filename, content_type, size, uploaded_at, thumb_key FROM objects WHERE document_id IS NULL`);
    orphans = Array.isArray(orphans) ? orphans : [];
    console.log(`   Found ${orphans.length} object(s) to migrate`);
  } catch (e) {
    console.log("   Error: " + (e.message || "").slice(0, 200));
    rl.close();
    return;
  }

  if (orphans.length === 0) {
    console.log("\nNothing to migrate. All objects already have document_id.");
    rl.close();
    return;
  }

  // 3. Create documents for orphans
  console.log(`\n3/5  Creating ${orphans.length} document(s)...`);
  let created = 0;
  for (const obj of orphans) {
    try {
      d1Execute(
        `INSERT INTO documents(id, title, page_count, uploaded_at, thumb_key)
         VALUES('${obj.key.replace(/'/g, "''")}', '${(obj.filename || "").replace(/'/g, "''")}', 1, ${obj.uploaded_at || Date.now()}, ${obj.thumb_key ? "'" + obj.thumb_key.replace(/'/g, "''") + "'" : "NULL"})
         ON CONFLICT(id) DO NOTHING`
      );
      created++;
    } catch (e) {
      console.log(`   Failed for ${obj.key}: ${(e.message || "").slice(0, 100)}`);
    }
  }
  console.log(`   Created ${created} document(s)`);

  // 4. Update objects with document_id and page_number
  console.log(`\n4/5  Updating objects with document_id and page_number...`);
  try {
    d1Execute(`UPDATE objects SET document_id = key, page_number = 1 WHERE document_id IS NULL`);
    console.log("   Objects updated");
  } catch (e) {
    console.log("   Error: " + (e.message || "").slice(0, 200));
  }

  // 5. Migrate tags from object_tags to document_tags
  console.log(`\n5/5  Migrating tags from object_tags to document_tags...`);
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
  console.log("\n6/6  Verifying migration...");
  try {
    const remaining = d1Query(`SELECT COUNT(*) as cnt FROM objects WHERE document_id IS NULL`);
    const cnt = Array.isArray(remaining) ? Object.values(remaining[0] || {})[0] : "?";
    console.log(`   Objects without document_id: ${cnt}`);

    const docCount = d1Query(`SELECT COUNT(*) as cnt FROM documents`);
    const dc = Array.isArray(docCount) ? Object.values(docCount[0] || {})[0] : "?";
    console.log(`   Total documents: ${dc}`);

    const tagCount = d1Query(`SELECT COUNT(*) as cnt FROM document_tags`);
    const tc = Array.isArray(tagCount) ? Object.values(tagCount[0] || {})[0] : "?";
    console.log(`   Total document_tags: ${tc}`);
  } catch (e) {
    console.log("   Verification error: " + (e.message || "").slice(0, 200));
  }

  console.log("\n" + "=".repeat(60));
  console.log("Migration complete.");
  console.log("=".repeat(60) + "\n");

  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
