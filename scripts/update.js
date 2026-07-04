#!/usr/bin/env node

// Pull upstream changes, refresh dependencies, and redeploy.
// Intended for users who cloned the repo and deployed under their own
// Cloudflare account. Secrets, R2 bucket, and D1 database persist in
// Cloudflare and are not touched. wrangler.toml is gitignored locally,
// so `git pull` never overwrites the user's account_id / database_id.
//
// Usage: npm run update

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: ROOT,
    ...opts,
  });
  if (result.status !== 0) {
    console.error(`\n❌ Command failed: ${cmd} ${args.join(" ")} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  console.log("📦 R2 Storage Manager — Update\n");

  // 1. Pull latest changes from the current upstream.
  //    wrangler.toml is gitignored, so no conflicts are expected there.
  run("git", ["pull"]);

  // 2. Refresh dependencies in case package.json changed.
  run("npm", ["install"]);

  // 3. Rebuild deploy-info.json and deploy.
  run("npm", ["run", "deploy"]);

  console.log("\n✅ Update complete.");
  console.log("   Database schema migrations (if any) apply lazily on Worker startup via ensureSchema.");
}

main();
