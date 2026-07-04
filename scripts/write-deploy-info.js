// Writes public/deploy-info.json with the current timestamp.
// Runs before `wrangler dev` / `wrangler deploy` so the frontend can show
// when this version was built/deployed. The file is gitignored.
const fs = require("fs");
const path = require("path");

const outPath = path.join(__dirname, "..", "public", "deploy-info.json");
const deployedAt = new Date().toISOString();

fs.writeFileSync(outPath, JSON.stringify({ deployedAt }, null, 2) + "\n");
console.log(`[write-deploy-info] wrote ${outPath} (${deployedAt})`);
