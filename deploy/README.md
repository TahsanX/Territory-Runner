# Deploying Territory Runner on Render (free tier)

Written for: the project owner deploying this for the first time.

## Why Render, and how the free tier is made to work

Two earlier plans are dead ends: DigitalOcean left the GitHub Student Pack, and
Heroku's student credit cannot be activated without a card it will accept.
Render needs **no card at all**, and its free tier includes the two things that
usually cost money: **custom domains and managed TLS**.

The one real problem is that a free web service **spins down after 15 minutes**
without traffic, and the next visitor then waits about a minute for it to boot.
That is fixed by pinging it — and the arithmetic works out:

| | |
| --- | --- |
| Free allowance | **750 instance hours / month, per workspace** |
| Staying awake 24/7 costs | ~730 hours (24 x 30.4) |
| Headroom | ~20 hours |

So a continuous keep-warm ping fits inside the free allowance — **provided this
is the only free web service in the workspace.** Hours are shared across the
whole workspace, and when they run out Render suspends every free service until
the next month.

Two honest caveats:

- Render's own docs say *"do not use free instances for production."* For a
  hackathon project, a portfolio piece or a demo this is fine; for real users
  depending on it, budget for the $7/mo Starter instance.
- The ping keeps the service from idling, which is the behaviour the free tier
  is designed around. It is widely done and not blocked, but it is not something
  Render promises to keep working.

Postgres stays on Supabase, so Render runs **only the Node app**.

---

## 1. Supabase setup (once)

1. Create the project at <https://supabase.com>.
2. **Database → Extensions → enable `postgis`.** Nothing works without this.
3. **Authentication → Providers → Google:** paste the client ID and secret from
   the Google Cloud console, and add Supabase's callback URL
   (`https://<ref>.supabase.co/auth/v1/callback`) to the Google OAuth client's
   authorised redirect URIs.
4. **Authentication → URL Configuration:** set the Site URL to your domain and
   add `https://territoryrunner.me/login` as a redirect URL.
5. Copy the connection strings and API keys into your local `.env`
   (`.env.example` says exactly which value goes where).

Apply the schema from your own machine — it uses `DIRECT_URL`, port 5432:

```bash
npm install
npm run init-db
```

> **Supabase also sleeps:** a free project **pauses after 7 days of
> inactivity**. The keep-warm ping in step 4 hits `/api/health`, which touches
> the database, so the same ping prevents this too.

Facebook stays off until your app clears Business verification — enable the
provider in the Supabase dashboard and set `ENABLE_FACEBOOK_OAUTH=true`. No code
change needed.

## 2. Create the Render service

The repo contains `render.yaml`, so Render can configure everything itself:

1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → select the repo.
3. Render reads `render.yaml` and prompts for each secret marked `sync: false`.
   Paste the values from your local `.env`:
   `APP_URL`, `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `MAPTILER_KEY`,
   `GEOAPIFY_KEY`, `GEOCODER_USER_AGENT`.
4. Apply. The first build runs `npm ci --include=dev && npm run build:css`.

Never set `PORT` — Render injects it and `server.js` already reads
`process.env.PORT`.

Then check:

```bash
curl -s https://territoryrunner.me/api/health
# expect {"status":"ok","database":"up"}
```

If `"database":"down"`, the app is up but Supabase is not reachable: make sure
`DATABASE_URL` is the **pooled** connection string (port **6543**), not the
direct one.

## 3. Custom domain + HTTPS

Buy the domain (Namecheap, or the free `.me` in the GitHub Student Pack), then:

1. Render → your service → **Settings → Custom Domains → Add**. Add both
   `territoryrunner.me` and `www.territoryrunner.me`. Render shows the DNS record each
   one needs.
2. Namecheap → **Domain List → Manage → Advanced DNS**:

   | Type | Host | Value |
   | --- | --- | --- |
   | CNAME | `www` | the target Render shows (e.g. `territory-runner.onrender.com`) |
   | ALIAS | `@` | the same target |

   Namecheap supports ALIAS on the apex domain. If it is unavailable, add a
   permanent **URL Redirect** from `@` to `https://www.territoryrunner.me` instead.
3. Render issues the certificate automatically once DNS resolves — allow up to
   an hour.
4. Point the app at the real domain and update Supabase:

   ```bash
   # Render dashboard -> Environment
   APP_URL=https://territoryrunner.me
   ```

   Then set the same URL in Supabase → **Authentication → URL Configuration**,
   and add `https://territoryrunner.me/login` as a redirect URL. Skipping this is
   the usual cause of Google sign-in bouncing back to `/login`.

## 4. Keep it awake (the important part)

Use **two** layers, because neither is perfectly reliable alone.

### Primary: an external cron (recommended)

**cron-job.org** — free, no card, minute-level scheduling:

1. Sign up at <https://cron-job.org>.
2. **Create cronjob** → URL: `https://territoryrunner.me/api/health`
3. Schedule: **every 10 minutes**.
4. Enable failure notifications so you hear about real outages.

(UptimeRobot works equally well; its free plan polls every 5 minutes and adds
email alerting.)

Ten minutes is deliberate: it is comfortably inside the 15-minute idle window,
so a single missed ping does not let the service fall asleep.

### Backup: the GitHub Actions workflow

`.github/workflows/keep-warm.yml` pings on the same 10-minute schedule.

1. Repo → **Settings → Secrets and variables → Actions → Variables → New**.
2. Name `KEEP_WARM_URL`, value `https://territoryrunner.me/api/health`.

> **Minutes warning:** Actions minutes are unlimited on a **public** repo. On a
> **private** repo this schedule would burn through the monthly allowance — so
> if the repo is private, delete this workflow and rely on the external cron.

GitHub's scheduled runs are best-effort and are often delayed past 15 minutes
under load, which is exactly why this is the backup and not the primary.

## 5. Ongoing deploys

`.github/workflows/deploy.yml` runs the tests, then triggers Render — so a push
with failing tests cannot ship.

1. Render → your service → **Settings → Build & Deploy**: set **Auto-Deploy** to
   **No**.
2. Same page → **Deploy Hook**: copy the URL.
3. Repo → **Settings → Secrets and variables → Actions → Secrets → New**:
   name `RENDER_DEPLOY_HOOK`, value that URL.

Now `git push origin main` runs CI and deploys only if it passes. Without the
secret set, the workflow skips the deploy step and you can leave Render's
auto-deploy on instead.

After a schema change, run the migration from your machine against `DIRECT_URL`:

```bash
npm run init-db
```

## 6. If you outgrow the free tier

- **$7/mo Starter instance** — no spin-down, no ping needed, no hour cap. This
  is the one upgrade worth paying for first.
- **Supabase Pro** — only once real users' territories are data you cannot lose.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| First visit takes ~1 minute | The service slept — the ping is missing or misconfigured |
| Every free service suspended | The 750 workspace hours ran out; keep only one free web service |
| Build fails on `tailwindcss: not found` | `buildCommand` must keep `--include=dev` |
| `"database":"down"` | `DATABASE_URL` must be the pooled string (port 6543) |
| `init-db` fails on `CREATE EXTENSION` | PostGIS not enabled in Supabase |
| Google sign-in returns to `/login` | Redirect URL missing in Supabase URL Config or the Google client |
| Login loops / cookies not set | Must be on HTTPS; `trust proxy` is already set in `server.js` |
| Unstyled pages | `build:css` did not run — check the build log |

---

### Files left over from the droplet plan

`deploy/nginx-territory-runner.conf`, `Dockerfile`, `docker-compose.yml` and the
`Procfile` are unused by Render. They are kept so a move to a VPS or to Heroku
does not start from scratch.
