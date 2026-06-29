# R2 Storage Manager

Personal secure cloud storage for documents, photos, and sensitive files. Self-hosted on your own Cloudflare account — no third-party access to your data, no VPS to maintain, no monthly bills.

![Dark UI](https://img.shields.io/badge/UI-Dark_Theme-1a1a1a) ![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020) ![Free Tier](https://img.shields.io/badge/Cost-Free_Tier-4caf50)

## Why

- **Your data stays yours.** Files are stored in your personal Cloudflare R2 bucket. No one else has access — not even the app developer.
- **Perfect for sensitive documents.** Passport scans, contracts, tax returns, medical records — anything you wouldn't trust to Google Drive or Dropbox.
- **Zero cost.** Runs entirely within Cloudflare's free tier (10 GB storage, 100k requests/day).
- **No server to manage.** No VPS, no Docker, no SSH. Everything runs on Cloudflare's edge network.
- **Access from anywhere.** Web UI works on desktop and mobile. Protected by your API key.
- **Tag-based organization.** Find documents instantly with tags instead of nested folders.

## Features

- Upload, download, delete files via web UI
- Tag-based organization with search
- Image thumbnails (generated client-side, stored in R2)
- Image viewer with pinch-to-zoom
- Mobile-friendly responsive design
- Single API key authentication
- Everything hosted on Cloudflare (Workers + R2 + D1)

## Stack

| Component | Service | Free Tier |
|-----------|---------|-----------|
| Backend API | Cloudflare Worker | 100k req/day |
| File storage | Cloudflare R2 | 10 GB |
| Metadata & tags | Cloudflare D1 | 5 GB |
| Frontend | Worker Assets | included |

## Quick Start

### Prerequisites

- Free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- For local setup only: [Node.js](https://nodejs.org/) 18+

### Create R2 API Token

Before deploying, create an R2 API token in the Cloudflare dashboard:

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → R2 Object Storage → **Manage R2 API Tokens**
2. Click **Create API token**
3. Permissions: **Object Read & Write**
4. Specify bucket: **r2-storage**
5. Copy the **Access Key ID** and **Secret Access Key**

### Option A: Deploy with GitHub Actions (recommended)

No Node.js, no terminal, no local install. Fork the repo and run the workflow.

1. Click **Use this template** or fork this repository to your own GitHub account.
2. In your fork, go to **Settings → Secrets and variables → Actions** and add:
   - `CF_API_TOKEN` — a Cloudflare API token with these permissions:
     - Account > Cloudflare Workers
     - Account > R2
     - Account > D1
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
3. Go to **Actions → Deploy to Cloudflare** and click **Run workflow**.
4. When the run finishes, copy the API key shown in the workflow logs.

The workflow creates the R2 bucket, D1 database, initializes the schema, sets all Worker secrets, and deploys the app.

Your app will be available at `https://r2-storage-manager.<your-subdomain>.workers.dev`.

### Option B: Local setup

```bash
git clone git@github.com:ai-eu/r2-storage-manager.git
cd r2-storage-manager
npm install
npm run setup
```

The setup wizard will:
1. Log you in to Cloudflare (opens browser, skips if already logged in)
2. Create an R2 bucket
3. Create a D1 database
4. Initialize the database schema (tables and indexes)
5. Ask for the R2 API Token keys you created above
6. Set all secrets
7. Generate an API key for web access
8. Deploy the app automatically

### Deploy

Setup runs deploy automatically. To redeploy after changes:

```bash
npm run deploy
```

Your app will be available at `https://r2-storage-manager.<your-subdomain>.workers.dev`

### Login

Open the URL and enter the API key that was shown during setup.

## Local Development

```bash
npm run dev
```

## Project Structure

```
r2-storage-manager/
├── .github/
│   └── workflows/
│       └── deploy.yml  # One-click GitHub Actions deploy
├── public/             # Frontend (served by Worker)
│   ├── index.html      # Login page
│   ├── app.html        # Main app
│   ├── app.js          # Vue.js app logic
│   └── style.css       # Styles
├── src/
│   └── worker.js       # Cloudflare Worker (API)
├── scripts/
│   ├── setup.js        # Interactive setup wizard
│   └── r2-cors.json    # R2 bucket CORS config
├── schema.sql          # D1 database schema
├── wrangler.toml       # Cloudflare config
└── package.json
```

## License

MIT
