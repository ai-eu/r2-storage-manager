#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

const ROOT = path.resolve(__dirname, "..");
const TOML_PATH = path.join(ROOT, "wrangler.toml");

// ── Wrangler helper (no shell, cross-platform) ──
function getWranglerEntry() {
  try { return require.resolve("wrangler"); } catch {
    return path.join(ROOT, "node_modules", "wrangler", "wrangler-dist", "cli.js");
  }
}

function wrangler(args, opts = {}) {
  const result = spawnSync(process.execPath, [getWranglerEntry(), ...args], {
    encoding: "utf-8",
    stdio: opts.input != null ? ["pipe", "pipe", "pipe"] : [opts.interactive ? "inherit" : "pipe", "pipe", "pipe"],
    input: opts.input,
    cwd: ROOT,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const combined = stdout + stderr;
  if (!opts.ignoreError && result.status !== 0) {
    const err = new Error(combined.slice(0, 500) || `Exit code ${result.status}`);
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  }
  return { stdout, stderr, combined, status: result.status };
}

// ── TOML updater ──
const updateToml = (key, value) => {
  let content = fs.readFileSync(TOML_PATH, "utf-8");
  const regex = new RegExp(`^(${key}\\s*=\\s*).*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `$1"${value}"`);
  }
  fs.writeFileSync(TOML_PATH, content);
};

async function main() {
  console.log("\n📦 R2 Storage Manager — Setup\n");

  // 1. Check wrangler
  console.log("Checking wrangler...");
  try {
    const { combined } = wrangler(["--version"], { ignoreError: true });
    console.log("   " + combined.trim().split("\n")[0]);
  } catch {
    console.error("❌ wrangler not found. Run: npm install");
    process.exit(1);
  }

  // 2. Login (skip if already logged in)
  console.log("\n🔑 Checking Cloudflare auth...");
  const { combined: whoamiCheck } = wrangler(["whoami"], { ignoreError: true });
  if (whoamiCheck.includes("Not authenticated") || whoamiCheck.includes("not authenticated") || !whoamiCheck.match(/[0-9a-f]{32}/)) {
    console.log("   Not logged in. Opening browser...\n");
    spawnSync(process.execPath, [getWranglerEntry(), "login"], {
      stdio: "inherit",
      cwd: ROOT,
    });
  } else {
    console.log("   ✅ Already logged in");
  }

  // 3. Get account ID
  console.log("\nFetching account info...");
  const { combined: whoami } = wrangler(["whoami"], { ignoreError: true });
  const accountMatch = whoami.match(/([0-9a-f]{32})/);
  let accountId = accountMatch ? accountMatch[1] : "";

  if (!accountId) {
    accountId = await ask("Enter your Cloudflare Account ID: ");
  } else {
    console.log(`   Account ID: ${accountId}`);
  }

  // 4. Create R2 bucket (check if exists first)
  console.log("\n🪣 Setting up R2 bucket...");
  const { combined: bucketList } = wrangler(["r2", "bucket", "list"], { ignoreError: true });
  if (bucketList.includes("r2-storage")) {
    console.log("   ✅ Bucket 'r2-storage' already exists");
  } else {
    try {
      wrangler(["r2", "bucket", "create", "r2-storage"]);
      console.log("   ✅ Bucket 'r2-storage' created");
    } catch {
      console.log("   ⚠️  Could not create bucket. Check the dashboard manually.");
    }
  }

  // 4.5. Set R2 bucket CORS (required for browser uploads via presigned URLs)
  console.log("\n🌐 Setting R2 bucket CORS...");
  const corsFile = path.join(ROOT, "scripts", "r2-cors.json");
  try {
    wrangler(["r2", "bucket", "cors", "set", "r2-storage", "--file", corsFile]);
    console.log("   ✅ CORS configured");
  } catch (e) {
    console.log("   ⚠️  Could not set CORS: " + (e.message || "").slice(0, 100));
  }

  // 5. Create D1 database (check if exists first)
  console.log("\n🗄️  Setting up D1 database...");
  let dbId = "";
  const { combined: dbList } = wrangler(["d1", "list"], { ignoreError: true });
  const existingDb = dbList.match(/([0-9a-f-]{36})\s*[│|]\s*r2-storage/);
  if (existingDb) {
    dbId = existingDb[1].trim();
    console.log(`   ✅ Database 'r2-storage' already exists: ${dbId}`);
  } else {
    try {
      const { combined: output } = wrangler(["d1", "create", "r2-storage"]);
      const dbMatch = output.match(/database_id\s*=\s*"([^"]+)"/);
      dbId = dbMatch ? dbMatch[1] : "";
      if (dbId) console.log(`   ✅ Database created: ${dbId}`);
    } catch (e) {
      const errStr = (e.stdout || "") + (e.stderr || "");
      const errMatch = errStr.match(/database_id\s*=\s*"([^"]+)"/);
      if (errMatch) {
        dbId = errMatch[1];
        console.log(`   ⚠️  Database may already exist: ${dbId}`);
      }
    }
  }

  if (!dbId) {
    dbId = await ask("Enter D1 database ID (from Cloudflare dashboard): ");
  }

  // 6. Update wrangler.toml
  console.log("\n📝 Updating wrangler.toml...");
  updateToml("R2_ACCOUNT_ID", accountId);
  updateToml("database_id", dbId);
  console.log("   ✅ Done");

  // 7. Initialize D1 schema (via stdin, no shell quoting issues)
  console.log("\n📋 Initializing D1 schema...");
  const schemaSql = [
    "CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, filename TEXT NOT NULL, content_type TEXT, size INTEGER, uploaded_at INTEGER NOT NULL, thumb_key TEXT, document_id TEXT, page_number INTEGER, original_key TEXT);",
    "CREATE TABLE IF NOT EXISTS object_tags (key TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (key, tag));",
    "CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, page_count INTEGER NOT NULL DEFAULT 1, uploaded_at INTEGER NOT NULL, thumb_key TEXT, pdf_key TEXT, correction_settings TEXT);",
    "CREATE TABLE IF NOT EXISTS document_tags (document_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (document_id, tag));",
    "CREATE TABLE IF NOT EXISTS usage_cache (date TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_objects_uploaded ON objects(uploaded_at);",
    "CREATE INDEX IF NOT EXISTS idx_tags_tag ON object_tags(tag);",
    "CREATE INDEX IF NOT EXISTS idx_tags_key ON object_tags(key);",
    "CREATE INDEX IF NOT EXISTS idx_objects_document ON objects(document_id);",
    "CREATE INDEX IF NOT EXISTS idx_documents_uploaded ON documents(uploaded_at);",
    "CREATE INDEX IF NOT EXISTS idx_document_tags_tag ON document_tags(tag);",
    "CREATE INDEX IF NOT EXISTS idx_document_tags_doc ON document_tags(document_id);",
  ].join("\n");

  try {
    wrangler(["d1", "execute", "r2-storage", "--remote", "--file=-"], { input: schemaSql });
    console.log("   ✅ Tables and indexes ready");
  } catch (e) {
    // Fallback: try one by one
    console.log("   ⚠️  Batch failed, trying one by one...");
    let ok = true;
    for (const line of schemaSql.split("\n")) {
      try {
        wrangler(["d1", "execute", "r2-storage", "--remote", "--command", line.replace(/;$/, "")]);
      } catch {
        ok = false;
        console.log(`   ⚠️  Failed: ${line.slice(0, 60)}...`);
      }
    }
    if (ok) console.log("   ✅ Tables and indexes ready");
  }

  // 8. R2 API Token
  console.log("\n" + "=".repeat(60));
  console.log("⚠️  MANUAL STEP REQUIRED");
  console.log("=".repeat(60));
  console.log("\nYou need an R2 API Token from the Cloudflare dashboard.");
  console.log("If you already have one, just enter the keys below.\n");
  console.log("To create a new one:");
  console.log("  1. Go to: https://dash.cloudflare.com/ → R2 Object Storage → Manage R2 API Tokens");
  console.log("  2. Click 'Create API token'");
  console.log("  3. Permissions: Object Read & Write");
  console.log("  4. Specify bucket: r2-storage");
  console.log("  5. Copy the Access Key ID and Secret Access Key\n");

  const accessKeyId = await ask("Enter R2 Access Key ID: ");
  const secretAccessKey = await ask("Enter R2 Secret Access Key: ");

  // 9. API Key
  console.log("\n🔐 Setting up access key...");
  let apiKey = await ask("Choose an API key for web access (or press Enter for random): ");
  if (!apiKey) {
    apiKey = Array.from(crypto.getRandomValues(new Uint8Array(24)))
      .map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 32);
    console.log(`   Generated: ${apiKey}`);
  }

  // 10. Set secrets
  console.log("\n🔒 Setting secrets...");
  const secrets = {
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
    API_KEY: apiKey,
  };

  let allSecretsOk = true;
  for (const [name, value] of Object.entries(secrets)) {
    try {
      wrangler(["secret", "put", name], { input: value + "\n" });
      console.log(`   ✅ ${name}`);
    } catch (e) {
      allSecretsOk = false;
      console.log(`   ❌ Failed to set ${name}: ${(e.message || "").slice(0, 100)}`);
      console.log(`      Set it manually: npx wrangler secret put ${name}`);
    }
  }

  // 11. Deploy
  console.log("\n🚀 Deploying to Cloudflare...");
  try {
    wrangler(["deploy"]);
    console.log("   ✅ Deployed");
  } catch {
    console.log("   ❌ Deploy failed. Run manually: npm run deploy");
  }

  // 12. Done
  console.log("\n" + "=".repeat(60));
  if (allSecretsOk) {
    console.log("✅ Setup complete!");
  } else {
    console.log("⚠️  Setup finished with errors. Fix the secrets above, then redeploy.");
  }
  console.log("=".repeat(60));
  console.log("\nYour API key for login: " + apiKey);
  console.log("Save it somewhere safe!\n");

  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
