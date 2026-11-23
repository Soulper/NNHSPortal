# Research Student Portal — Node.js edition

A faithful port of the PHP portal to **Node.js + Express + SQLite**, restructured
for deployment on **Vercel**. Same URLs, same pages, same behavior — the
frontend (`style.css`, `script.js`, `theme.js`) is unchanged from the PHP
original, and the same database schema/seed runs on both.

> **Security note (inherited from the PHP original):** the database auto-seeds
> demo accounts with the password `password123` on first run. That is fine
> locally — **change the passwords immediately after deploying** (Profile →
> Change Password for each account, or delete the accounts in Admin → Users).
> This is a research/coursework project, not a production SIS: do not load
> real student data into a public deployment (RA 10173, Data Privacy Act).

## Stack

| Piece | Choice | Why |
|---|---|---|
| Server | **Express** (Node 20+) | serves the exact same URLs as PHP (`/login.php`, `/dashboard.php`, …), so no frontend change was needed |
| Database | **SQLite via `@libsql/client`** | same schema + SQL as the PHP app; runs on a local file in dev and on **Turso** (hosted SQLite) in production |
| Sessions | **cookie-session** (signed cookies) | survives Vercel's serverless model, where PHP-style server sessions die |
| Views | **EJS** | server-rendered HTML identical to the PHP output |
| Uploads | **Vercel Blob** (prod) / local `data/uploads` (dev) | Vercel has no writable disk |
| Excel | **exceljs** | PhpSpreadsheet replacement (SF9 export, gradebook import/export) |
| Passwords | **bcryptjs** | same bcrypt hashes the PHP app stored |

## Run locally

```bash
npm install
npm run dev          # → http://localhost:8000
```

## Deploy to Cloudflare Workers (free)

The Node edition runs on **Cloudflare Workers** — always-on (no cold starts for visitors),
no credit card, 100k requests/day on the free plan — with the database on **Turso**'s free
tier. Static files (`style.css`, `script.js`, `theme.js`, `logo.ico`) are served by
Cloudflare's assets feature; uploaded files are stored inside the database (`files` table),
so they survive restarts and redeploys.

1. **Turso** (database, free, no card): create a database at
   <https://platform.turso.tech>, copy its URL (`libsql://…turso.io`) and create an auth
   token for it.
2. **Cloudflare** (hosting, free, no card): create an account at
   <https://dash.cloudflare.com/sign-up>.
3. Deploy from this folder:
   ```bash
   npx wrangler login
   npx wrangler secret put DATABASE_URL      # libsql://your-db.turso.io
   npx wrangler secret put DATABASE_TOKEN    # the Turso token
   npx wrangler secret put SESSION_SECRET    # any long random string
   npx wrangler deploy
   ```
4. Open the printed `https://research-student-portal.<you>.workers.dev`.

The first request creates the schema and seeds the demo accounts — **change or delete
them immediately** (Admin → Users, Profile → Change Password). If you edit any template
(`src/views/**`), regenerate the bundle with `npm run build:views` before deploying.

No database setup is needed: `data/school_portal.db` is created and seeded on
first request (demo accounts + classes, all with password `password123`).

| Email | Role |
|---|---|
| `admin@school.com` | Teacher + full admin panel |
| `teacher@school.com` | Teacher (owns all demo classes) |
| `student@school.com` … `student4@school.com` | Students (STU-001 … STU-004) |

## Tests

Five ported suites (271 assertions — the PHP original had 237), plus a live
HTTP smoke test:

```bash
npm test             # runs every suite on its own scratch database
node tests/engine_test.js        # 126  descriptors, validation, NULL handling, concurrency
node tests/report_card_test.js   #  50  report-card maths, banding, release privacy
node tests/submission_test.js    #  13  assignment submission policy, upload limits
node tests/teacher_grid_test.js  #  50  gradebook markup, progress strip, publish gating
node tests/sf9_test.js           #  32  SF9 export: release privacy, template fill, no formulas

# live HTTP smoke test (server must be running: npm run dev)
RUN_SMOKE=1 npm test
# or: node tests/smoke_test.js
```

Each suite creates its own scratch database and cleans up after itself, so
they never touch `data/school_portal.db`. The smoke test drives the real
server (login, gradebook autosave, admin panel, upload → download) and should
point `SMOKE_URL` at a scratch deployment — it writes data.

## Deploy to Vercel (free)

### 1. Create the database (Turso)

Turso is hosted SQLite — the app's SQL is unchanged.

```bash
# install the CLI: https://docs.turso.tech/cli/introduction
turso db create student-portal
turso db show student-portal --url          # → DATABASE_URL
turso db tokens create student-portal       # → DATABASE_TOKEN
```

### 2. Push the project to a GitHub repo

Commit the `portal-node/` folder (or the repo root if that is all there is).
`node_modules/` and `data/` are git-ignored.

### 3. Import to Vercel

1. <https://vercel.com/new> → import the repo.
2. **Root directory**: `portal-node` (if the repo also contains the PHP app).
3. Add the environment variables:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | `libsql://…` from step 1 |
   | `DATABASE_TOKEN` | the Turso token |
   | `SESSION_SECRET` | long random string |

4. Deploy. Vercel serves `public/` statically and runs the Express app from
   `api/index.js` (routing is configured in `vercel.json`).

### 4. File uploads (Vercel Blob)

For assignment/announcement/profile uploads to work in production:

1. In the Vercel dashboard → your project → **Storage** → **Create Database → Blob**.
2. Connect it to the project — Vercel adds `BLOB_READ_WRITE_TOKEN` automatically.
3. Redeploy. Without the token, text-only features still work; file uploads
   are rejected with a clear error.

Uploads are capped at **4 MB** on Vercel (serverless request limit; the PHP
original allowed 10 MB). Change with `UPLOAD_MAX_MB` if you self-host.

### 5. First-run hardening

On the first visit the production database seeds itself with the demo
accounts. Immediately:

1. Log in as `admin@school.com` / `password123`.
2. Change the password (Profile → Change Password).
3. Delete or change the passwords of every other demo account (Admin → Users).
4. Optionally set *Admin → Settings → Registration* to approval mode.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `file:./data/school_portal.db` | SQLite file (dev) or `libsql://…` (prod) |
| `DATABASE_TOKEN` | — | Turso auth token (prod only) |
| `SESSION_SECRET` | insecure dev default | cookie-signing key — **always set in production** |
| `BLOB_READ_WRITE_TOKEN` | — | enables Vercel Blob uploads |
| `UPLOAD_MAX_MB` | `4` on Vercel, `10` locally | upload size cap |
| `UPLOAD_DIR` | `./data/uploads` | local upload folder (dev) |
| `APP_URL` | — | absolute base URL, if you need absolute links |

## Backups

With Turso the database is managed for you (point-in-time restore on paid
tiers; `turso db dump` for snapshots). Locally, back up the file:

```bash
copy data\school_portal.db data\school_portal.backup.db
```

## Project layout

```
portal-node/
├── api/index.js            Express app (Vercel entry point)
├── server.js               local dev server (node server.js)
├── vercel.json             routes everything to the app; static from public/
├── public/                 style.css, script.js, theme.js, logo.ico (unchanged from PHP)
├── src/
│   ├── db.js               schema + seed + migrations (port of db.php)
│   ├── config.js           sessions/CSRF/flash/audit/rc_* helpers (port of config.php)
│   ├── grade-engine.js     Term Grades + DO 015 descriptors (port of grade_engine.php)
│   ├── storage.js          upload policy + Vercel Blob / disk storage
│   ├── routes/             auth, dashboard, grades_api, admin, download
│   ├── actions/            teacher/student page renderers + POST actions
│   ├── sf9_export.js       SF9 report card .xlsx (exceljs port of sf9_export.php)
│   └── views/              EJS templates (auth, teacher, student, admin, partials)
├── tests/                  ported PHP test suites + runner
└── PORTING.md              conventions used during the PHP → Node port
```
