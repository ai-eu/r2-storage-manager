#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

const ROOT = path.resolve(__dirname, "..");
const TOML_PATH = path.join(ROOT, "wrangler.toml");

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
    throw new Error(out.slice(0, 300) || `Exit code ${result.status}`);
  }
  return out;
}

async function main() {
  console.log("\n🧹 R2 Storage Manager — Reset\n");
  console.log("This will DELETE all Cloudflare resources created by setup:");
  console.log("  - Worker deployment (r2-storage-manager)");
  console.log("  - Worker secrets");
  console.log("  - D1 database (r2-storage)");
  console.log("  - R2 bucket (r2-storage) — only if empty");
  console.log("  - Reset wrangler.toml to defaults\n");

  const confirm = await ask("Type YES to continue: ");
  if (confirm !== "YES") {
    console.log("Aborted.");
    rl.close();
    return;
  }

  // 1. Delete worker
  console.log("\n🗑️  Deleting worker...");
  try {
    wrangler(["delete", "--force"], { input: "y\n" });
    console.log("   ✅ Worker deleted");
  } catch (e) {
    console.log("   ⚠️  " + (e.message || "").slice(0, 100));
  }

  // 2. Delete D1 database
  console.log("\n🗑️  Deleting D1 database...");
  try {
    const list = wrangler(["d1", "list"], { ignoreError: true });
    const match = list.match(/([0-9a-f-]{36})\s*[│|]\s*r2-storage/);
    if (match) {
      wrangler(["d1", "delete", "--database-id", match[1].trim()], { input: "y\n" });
      console.log("   ✅ Database deleted");
    } else {
      console.log("   ⚠️  Database 'r2-storage' not found (already deleted?)");
    }
  } catch (e) {
    console.log("   ⚠️  " + (e.message || "").slice(0, 100));
  }

  // 3. Delete R2 bucket
  console.log("\n🗑️  Deleting R2 bucket...");
  try {
    wrangler(["r2", "bucket", "delete", "r2-storage"]);
    console.log("   ✅ Bucket deleted");
  } catch (e) {
    const msg = (e.message || "").toLowerCase();
    if (msg.includes("not empty")) {
      console.log("   ⚠️  Bucket is not empty. Empty it in the dashboard first, then re-run reset.");
    } else if (msg.includes("not found") || msg.includes("does not exist")) {
      console.log("   ⚠️  Bucket not found (already deleted?)");
    } else {
      console.log("   ⚠️  " + (e.message || "").slice(0, 100));
    }
  }

  // 4. Reset wrangler.toml
  console.log("\n📝 Resetting wrangler.toml...");
  const cleanToml = `name = "r2-storage-manager"
main = "src/worker.js"
compatibility_date = "2024-03-22"
assets = { directory = "./public" }

# These values are filled in by \`npm run setup\`
# account_id = ""

[[r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "r2-storage"

[[d1_databases]]
binding = "DB"
database_name = "r2-storage"
database_id = ""

[vars]
R2_ACCOUNT_ID = ""
R2_BUCKET_NAME = "r2-storage"
`;
  fs.writeFileSync(TOML_PATH, cleanToml);
  console.log("   ✅ Done");

  console.log("\n" + "=".repeat(60));
  console.log("✅ Reset complete. Run `npm run setup` to start fresh.");
  console.log("=".repeat(60) + "\n");

  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
