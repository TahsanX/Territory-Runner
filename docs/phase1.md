# Territory Runner — Phase 1 (Web) Implementation Plan

## Context

Territory Runner is a gamified running app where a closed GPS loop captures a map
territory. It works, but four structural problems block it from being demo-ready:

1. **The stack is half-migrated, in the opposite direction from what was assumed.**
   The live code runs on **MongoDB/Mongoose** — `server.js:10` requires
   `config/mongodb.js`, all five files in `models/` are Mongoose schemas, and commit
   `d0863e3 final` added `mongoose` and deleted `render.yaml`. The **Postgres layer is
   the dead leftover**: `config/database.js`, `config/database.sql`, `init-db.js`,
   `setup-db.js` and the `pg` dependency are never imported by anything that executes.
   Both halves exist; only one runs. Decision: **finish the migration to Postgres +
   PostGIS**, because territory stealing is fundamentally a geometry-difference problem
   that the database should solve, not hand-written Turf JS.

2. **Territory stealing is written but broken.** `utils/territoryOverlapHandler.js`
   genuinely calls `turf.difference`, so the intent is there. It fails because it reads
   only `coordinates[0]` of the result (line 60) — so a territory cut in half or turned
   into a donut silently loses geometry — decrements the victim's stats by the wrong
   number (line 78 uses `overlapArea`, not the real polygon delta), and is wrapped in a
   swallowed `try/catch` at `runController.js:233` so every failure is invisible while
   the area stays double-counted.

3. **It is slow, and the cause is measurable.** `runController.js:38-74` performs a
   `findById` + an insert + a synchronous `console.log` **per GPS fix**. With
   `watchPosition({enableHighAccuracy: true})` firing ~1×/second, a 30-minute run is
   ~1,800 HTTP round trips and ~3,600 DB queries. Full list in §4.

4. **GPS accuracy is unfiltered.** `position.coords.accuracy` is never read anywhere.
   Every fix — including a 2 km urban-canyon spike — is recorded, drawn and POSTed. This
   is the real "map accuracy" problem; the tile provider is secondary.

Phase 1 outcome: a fast, correct, professional-looking web app on Postgres+PostGIS with
working territory stealing, Google OAuth, a streak calendar, monthly/yearly summaries,
and an animated loader — deployed to the existing DigitalOcean droplet behind nginx on a
real domain.

### Decisions already locked
| Question | Decision |
| --- | --- |
| Database | **Supabase** (managed Postgres) + PostGIS extension, raw SQL via `pg` pool (no ORM) |
| Auth | **Supabase Auth** — native Google provider; Facebook configured but flagged off |
| Steal rule | Full steal, always — newest valid loop takes 100% of the overlap |
| Map | Fix GPS filtering **and** swap basemap; MapTiler, keep Leaflet |
| Place names | Reverse-geocode once on run finish, cache the string on the row |
| Territory labels | Only your own territories are named; others coloured but unlabeled |
| Hosting | App on the DigitalOcean droplet + nginx; database on Supabase (see §10) |

**Why Supabase is the right call here:** it is plain Postgres, so §1 and §2 work
unchanged — PostGIS is a one-click extension. It also deletes work: managed backups
(most of §10's backup section), Supavisor connection pooling, and native OAuth providers
that remove `passport`, `express-session` and `connect-pg-simple` from §6 entirely.
One caveat to plan around: the **free tier pauses a project after 7 days of
inactivity** — the same trap as Render's sleeping tier. A live app on a real domain
needs the Pro tier or a keep-warm ping.

### First action on approval
Write `docs/phase1.md` (this plan) and `docs/phase2.md` (the §11 outline) into the repo,
then execute Phase 1 top to bottom, then Phase 2.

---

## 1. Supabase Postgres + PostGIS migration

### Supabase project setup (your part — I'll provide exact steps)
- Create the project; enable the **PostGIS** extension from Database → Extensions.
- Enable the **Google** provider under Authentication → Providers; paste the Google
  client ID/secret and add the Supabase callback URL to the Google console.
- Give me: `DATABASE_URL` (the **pooled** Supavisor connection string, port 6543, not
  the direct 5432 one — direct connections are capped low on Supabase),
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.
  The service-role key must stay server-side only — it bypasses every RLS policy.
- Keep the **direct** connection string too; migrations should run on it, not the pooler.

### Schema — `config/schema.sql` (replaces `config/database.sql`)
Keep the existing table and column names from `database.sql` so the shape is familiar,
but make three changes:

- `CREATE EXTENSION IF NOT EXISTS postgis;`
- `territories.polygon_coords TEXT` → **`territories.geom geometry(Polygon, 4326)`**,
  plus `GIST (geom)` index. This is the change that makes stealing correct and fast.
  Keep a generated `area_m2 double precision` column written on insert (not computed per
  query) so the leaderboard never calls `ST_Area`.
- New columns and tables for the new features:

**Identity change — `users` becomes a profile table.** Supabase Auth owns identity in
`auth.users` with a **UUID** primary key, so every `user_id` in this schema becomes
`UUID REFERENCES auth.users(id) ON DELETE CASCADE` instead of `BIGSERIAL`. Our own
`public.profiles` holds only app data; password/oauth columns disappear because Supabase
stores credentials and linked providers itself.

```sql
CREATE TABLE profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username    VARCHAR(255) UNIQUE NOT NULL,
  avatar_url  TEXT NULL,
  weight_kg   NUMERIC(5,2) DEFAULT 70,   -- kills the hardcoded 70 in geoUtils
  created_at  TIMESTAMPTZ DEFAULT now()
);
-- Trigger on auth.users INSERT auto-creates the profile + user_statistics row,
-- which also fixes the current non-atomic signup in authController.js:6-58.

-- running_sessions: place caching + local-day streak math
  place_name        TEXT NULL,                -- reverse-geocoded once, cached
  place_locality    TEXT NULL,
  local_date        DATE NULL,                -- client's local day, for streaks
  tz_offset_minutes INTEGER NULL

CREATE TABLE territory_events (                -- replaces unused territory_conflicts
  id BIGSERIAL PRIMARY KEY,
  territory_id BIGINT, attacker_user_id UUID, defender_user_id UUID,
  area_transferred_m2 DOUBLE PRECISION,
  outcome TEXT,                                -- 'trimmed' | 'consumed'
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE user_daily_activity (             -- one row per user per local day
  user_id UUID, local_date DATE,
  runs INT, distance_km DOUBLE PRECISION, calories INT,
  area_gained_m2 DOUBLE PRECISION, area_lost_m2 DOUBLE PRECISION,
  PRIMARY KEY (user_id, local_date)
);
```

`user_daily_activity` is the single source for the calendar **and** both summaries —
written once per finished run, so the calendar is one indexed range query instead of
aggregating raw sessions on every page load.

Indexes to create: `territories USING GIST (geom)`, `territories (user_id)`,
`route_coordinates (running_session_id, recorded_at)`,
`running_sessions (user_id, local_date DESC)`,
`user_statistics (total_territory_area DESC)`, `user_statistics (total_distance DESC)`,
`user_daily_activity (user_id, local_date)`.

### Code changes
- **Keep** `config/database.js` — the existing `pg` Pool is fine. Point it at the
  Supabase pooled `DATABASE_URL`, add `max`, `idleTimeoutMillis`,
  `connectionTimeoutMillis`, and `ssl: { rejectUnauthorized: false }` (Supabase requires
  TLS; the existing auto-SSL check at `config/database.js` only triggers on
  `render.com`). Keep `max` modest — the pooler is shared.
- **Row Level Security:** enable RLS on every table. The Express app uses the
  service-role key and enforces ownership in SQL (§3), but RLS is the backstop that
  makes a leaked anon key harmless — and Phase 2's mobile app may query Supabase
  directly, where RLS becomes the *only* protection. Policies: a user reads/writes only
  their own `profiles`, `running_sessions`, `route_coordinates`,
  `user_daily_activity`; `territories` are world-readable (the map needs them) but
  writable only by the owner.
- **Rewrite** all five `models/*.js` from Mongoose schemas into thin raw-SQL repository
  modules exporting functions (`findById`, `create`, …) over the shared pool. Same
  filenames so controller imports barely change.
- **Update** the four controllers: `_id` → `id`, `$inc` → `SET x = x + $n`,
  `$gte/$lte` → `BETWEEN`, `findOneAndUpdate` → `INSERT … ON CONFLICT … DO UPDATE`.
  Affected: `authController.js` (8 `_id` sites), `runController.js` (4),
  `territoryController.js` (2), `leaderboardController.js`, `territoryOverlapHandler.js`
  (7). `authController.js` shrinks drastically — register/login move to Supabase (§6).
- **Delete**: `config/mongodb.js`, `setup-db.js` (it does `DROP DATABASE` — dangerous,
  and meaningless against a managed DB), `public/_redirects` (stray Netlify rule), and
  the `mongoose` and `bcryptjs` dependencies (Supabase hashes passwords now).
- **Rewrite** `init-db.js` to run `schema.sql` idempotently against the **direct**
  connection string; keep `npm run init-db`.
- Add a migration file set under `supabase/migrations/` using the Supabase CLI
  convention, so schema changes are versioned and replayable rather than one big
  `schema.sql` re-run.
- `.env.example`: replace with the actual required set — `DATABASE_URL` (pooled),
  `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_JWT_SECRET`, `MAPTILER_KEY`, `GEOCODER_PROVIDER`, `APP_URL`. Note the old
  `DB_HOST`/`DB_USER`/`JWT_SECRET`/`SESSION_SECRET` set is gone.
- `package.json`: add `"engines": { "node": ">=20" }`; drop `mongoose`; drop the unused
  `express-validator` **or** actually use it in §3 (prefer using it).

---

## 2. Territory stealing — correct, atomic, indexed

Replace the body of `utils/territoryOverlapHandler.js` with a single transactional SQL
routine. PostGIS does the geometry; no Turf, no full table scan, no lost rings.

```sql
BEGIN;
-- 1. Lock only the territories that actually intersect (GiST index used)
SELECT id, user_id, area_m2, geom
  FROM territories
 WHERE user_id <> $attacker
   AND geom && $new_geom                      -- bbox prefilter via index
   AND ST_Intersects(geom, $new_geom)
   FOR UPDATE;

-- 2. Per victim, compute the exact remainder (handles MultiPolygon + holes)
--    ST_Multi keeps a split-in-two territory as ONE valid multipolygon
UPDATE territories
   SET geom   = ST_Multi(ST_CollectionExtract(
                  ST_Difference(geom, $new_geom), 3)),
       area_m2 = ST_Area(ST_Difference(geom, $new_geom)::geography)
 WHERE id = $victim_id;

-- 3. Delete only if nothing meaningful remains (sliver guard)
DELETE FROM territories WHERE id = $victim_id AND area_m2 < 50;

-- 4. Stats delta is the REAL polygon difference, not the intersection area
UPDATE user_statistics
   SET total_territory_area = GREATEST(0, total_territory_area - $actual_delta)
 WHERE user_id = $victim_user;

INSERT INTO territory_events (...);
COMMIT;
```

Key corrections over the current implementation:
- `territories.geom` column type becomes `geometry(MultiPolygon, 4326)` so a territory
  split in two by a run straight through the middle survives intact — the current
  `coordinates[0]` read at line 60 discards the second half.
- `ST_CollectionExtract(..., 3)` drops degenerate line/point artifacts that
  `ST_Difference` can emit, which currently become invalid polygons.
- Stats are decremented by `old_area - new_area` (the measured delta), not by
  `overlapArea`. These differ whenever the result isn't a clean single polygon, and the
  current code's drift is permanent.
- Attacker's own overlapping territories get **merged** (`ST_Union`) rather than skipped,
  fixing the existing double-count where one user's two runs overlap each other.
- `ST_Area(geom::geography)` gives true m² on the spheroid, matching `turf.area`.
- Called **inside** the finish transaction, not fire-and-forget. A failure now rolls the
  whole finish back instead of leaving double-counted area.
- Incoming polygons validated with `ST_IsValid` / repaired with `ST_MakeValid` before
  insert — self-intersecting GPS loops currently throw inside
  `geoUtils.coordinatesToPolygon` and silently abort territory creation.

`utils/geoUtils.js`: keep `isClosedLoop`, `calculateRunningStats`; delete
`checkOverlap`, `calculateOverlappingArea`, `subtractPolygon` (now PostGIS). Fix the two
silent-failure bugs flagged during exploration: `calculateCenterPoint` falling back to
`{lat:0,lon:0}` (null island) and `subtractPolygon` returning the input unchanged on
error. Replace the monolithic `require('@turf/turf')` with scoped
`@turf/distance` + `@turf/boolean-*` imports (§4).

---

## 3. Security fixes (must ship with Phase 1)

These are small but currently exploitable:

- **Session hijacking:** no route in `routes/runRoutes.js` checks ownership.
  `addCoordinate`, `pauseSession`, `finishSession`, `getSession` all look up by
  `sessionId` alone, and `runController.js:208` assigns the territory to `req.user.id` —
  so any logged-in user can finish someone else's run and claim their territory. Add
  `AND user_id = $me` to every session lookup.
- `middleware/authMiddleware.js:4` and `server.js:45` read `req.cookies`, but
  `cookie-parser` is not installed — always `undefined`. Install and register it (needed
  for OAuth anyway).
- `server.js:44-50` defines `checkAuth` and never applies it; `/`, `/run`,
  `/leaderboard` are fully public. Apply it to the page routes.
- `authController.js:103` — `expiresIn: process.env.JWT_EXPIRE`; if unset the token
  **never expires**. Moot once Supabase issues tokens (§6), but validate
  `SUPABASE_JWT_SECRET` at boot the same way — a missing secret currently turns every
  request into a confusing 401 instead of a startup error.
- `config/mongodb.js:20` deliberately does not exit on DB failure, so the server reports
  healthy with a dead database. New `/api/health` must actually check the pool and return
  503 when it's down — doubly important on Supabase, whose free tier pauses the project.
- Add `helmet` and use the already-installed `express-validator` on all request bodies.
  (Auth-route rate limiting comes from Supabase — §6.)
- RLS policies on every table as the defence-in-depth backstop (§1).

---

## 4. Performance — the latency work

Ordered by measured impact.

**P1 — Coordinate batching (the big one).** `runController.js:38-74` is one
round trip per GPS fix. Change to:
- Client buffers fixes and flushes every ~10 s or 20 points to a new
  `POST /api/run/:id/coordinates` (plural) taking an array.
- Server does **one** multi-row `INSERT … SELECT * FROM unnest($1::float[], $2::float[])`
  — a single query for the whole batch, with the ownership check done once.
- `navigator.sendBeacon` on `pagehide` so the final buffer isn't lost.
- Expected: ~1,800 requests → ~180 for a 30-minute run, and ~3,600 queries → ~180.

**P2 — Kill the per-request logging.** ~40 `console.log` calls sit in hot paths
(`runController.js:44,67`, a `📄 Rendering…` line per page route, etc.). `stdout` writes
are synchronous and block the event loop. Replace with `pino` at `info` in prod, and
delete the decorative emoji banner at `server.js:111-120`.

**P3 — Overlap no longer scans the table.** `territoryOverlapHandler.js:19-21` loads
*every* territory in the database and reparses each into a Turf polygon, per finished
run — O(n) and unbounded. §2's `geom && $new_geom` uses the GiST index instead.

**P4 — Territory list is unbounded.** `territoryController.js:10` returns every
territory with full coordinate arrays, and `home.js` draws them all. Fix:
- Make `/api/territory/all` viewport-driven (reuse the existing `/bounds` endpoint,
  called on Leaflet `moveend`), hard `LIMIT`, and simplify server-side with
  `ST_SimplifyPreserveTopology(geom, tolerance_from_zoom)`.
- Return GeoJSON directly from `ST_AsGeoJSON` — no JS re-mapping of coordinate pairs.
- Same unbounded problem in `leaderboardController.js:11,40` (`UserStatistics.find()`
  with no limit) — add `LIMIT`/pagination.

**P5 — Double write on finish.** `runController.js:202` and `:221` both call
`userStats.save()`. Collapse into one `UPDATE … SET a=a+$1, b=b+$2` inside the
transaction.

**P6 — Client render cost.** `run.js` calls `polylineLayer.setLatLngs(routeSegments)` on
every fix, re-rendering the entire growing path (O(n) per fix, so O(n²) per run). Use
`polyline.addLatLng()` to append. Also remove `map.setView([lat,lon], 15)` per fix — it
forces tile re-render *and* locks the user out of panning; recenter only when the marker
leaves the viewport, behind a "follow me" toggle.

**P7 — Bundle and transport.** `require('@turf/turf')` pulls the whole library (~500 KB)
for six functions → scoped packages. Add `compression` middleware, and
`express.static(..., { maxAge: '1y', etag: true, immutable: true })` with hashed asset
filenames (`server.js:28` is currently bare).

**P8 — Drop the `[999, 999]` sentinel.** Pause is encoded as a fake coordinate pushed to
the server (`run.js:194-205`) and filtered in four separate places in `geoUtils.js`.
Replace with a real `session_segments` table or an `is_pause_marker` boolean. Note
`pauseSession` (`runController.js:77-97`) is currently a pure no-op that still costs a
`findById` round trip — make it actually record the pause.

**Verification:** add `npm run bench` — a script that seeds N territories and M
coordinates and times `finish` + `/api/territory/bounds`, so the before/after is a
number, not a feeling.

---

## 5. GPS accuracy + basemap

**Filtering** — new `public/js/gps-filter.js`, shared later with the mobile app:
- Reject any fix with `coords.accuracy > 25` m (currently `accuracy` is never read).
- Reject implied speed > 7 m/s between consecutive fixes (sprint ceiling) — kills jumps.
- Minimum 5 m displacement before recording, so standing still doesn't accumulate drift
  distance.
- Discard the first 2–3 fixes after start (cold-start fixes are the worst).
- Light smoothing (exponential moving average or a 1-D Kalman on lat/lon).
- Show live GPS quality in the run UI so the user knows why points are being dropped.

**Basemap** — keep Leaflet (MapLibre is deferred to Phase 2 where the mobile app needs
vector tiles anyway; swapping now would rewrite all map code for little Phase 1 gain):
- Replace the raw `https://{s}.tile.openstreetmap.org/...` layer with MapTiler. The
  current URL hotlinks OSM's tile servers against their usage policy and uses the
  deprecated `{s}` subdomain pattern.
- Put the tile URL + key behind **one** config constant in a new `public/js/map-config.js`
  so changing provider is a one-line edit.
- Use a light/minimal MapTiler style so the coloured territory polygons actually read
  against the basemap.
- Fix the inconsistent default centres — `run.js:20` starts on New York, `home.js:71` on
  Dhaka. Use the user's last known position, falling back to one shared constant.
- Remove the twice-hardcoded cdnjs marker-icon workaround (`run.js:48-53`, `:90-95`).

**Place names:** on finish, one reverse-geocode of the territory centre →
`place_name` / `place_locality` on the session row. Cached forever, so summaries are a
`GROUP BY` on a stored string. Rate-limited, failure-tolerant (a null place name must
never fail a run).

---

## 6. Auth via Supabase (Google live, Facebook flagged)

Supabase Auth replaces the hand-rolled JWT layer. This is a net **deletion** of code:
no `passport`, no `passport-google-oauth20`, no `express-session`, no
`connect-pg-simple`, no `config/passport.js`, no `/auth/*/callback` routes, no bcrypt,
and no hand-written register/login handlers.

- Add `@supabase/supabase-js`. Keep `cookie-parser` (still needed, and still missing
  despite `authMiddleware.js:4` and `server.js:45` reading `req.cookies`).
- **Client:** `supabase.auth.signInWithOAuth({ provider: 'google' })` and
  `signInWithPassword` for email/password. Facebook is one config toggle in the Supabase
  dashboard plus an `ENABLE_FACEBOOK_OAUTH` flag on the button — zero extra code, which
  it activates the moment your Facebook app clears review.
- **Server:** `middleware/authMiddleware.js` verifies the Supabase JWT (`SUPABASE_JWT_SECRET`,
  HS256) and sets `req.user = { id: claims.sub }` — the same shape controllers already
  expect, so `req.user.id` call sites need no change beyond `_id`→`id`. Keep the
  `Authorization: Bearer` path: Phase 2's mobile app depends on it.
- **Account linking is handled for us** — Supabase matches on verified email, so
  signing in with Google on an existing email links instead of duplicating. This was
  going to be hand-written logic.
- **Token delivery:** the JWT currently sits in `localStorage` (`views/login.ejs:69`),
  XSS-readable. Use `@supabase/ssr` cookie-based sessions (`httpOnly`, `secure`,
  `sameSite=lax`) so the server can read auth during EJS rendering — which is what makes
  `checkAuth` in §3 work at all. Refresh-token rotation comes free; the current token
  never expires if `JWT_EXPIRE` is unset.
- Add "Continue with Google" to `views/login.ejs` and `views/signup.ejs`; delete their
  inline `<script>` blocks in favour of `public/js/auth.js`.
- `authController.js` keeps only `getUserProfile` (now reading `profiles` + stats).
  `register`/`login` are deleted; the signup-not-atomic bug and the
  "register issues no token" bug both disappear with them.
- **Supabase Auth rate-limits login attempts by default**, which also satisfies the
  `express-rate-limit` item in §3 for auth routes.

---

## 7. UI redesign — Tailwind, sectioned, professional

Diagnosis from exploration: the UI is **not** cartoonish — it's generic 2015 Flat-UI
admin with **four unrelated palettes mixed together** (Flat UI `#2c3e50`/`#3498db`,
literal Bootstrap 4 alert colours, Tailwind-ish hexes in `run.css`, Material blue in the
rank box), no shared layout, and — notably — **zero EJS tags in any `.ejs` file**. They
are static HTML with an `.ejs` extension; all data arrives via axios. There is also a
real bug: `views/run.ejs` loads only `run.css`, never `style.css`, so every class it
depends on (`.run-container`, `.btn`, `.control-panel`) is undefined and the run page
falls back to browser defaults.

Approach:
- **Tailwind CSS with a real build step** (`npm run build:css`), not the CDN — the CDN
  script compiles in the browser on every page load, which contradicts §4.
- **shadcn/ui is not usable here** — it generates React components and this is EJS/SSR.
  Instead: define the same design tokens and copy the shadcn *visual* language (neutral
  greys, one restrained accent, `0.5rem` radius, subtle borders over heavy shadows) as
  Tailwind `@apply` component classes. Phase 2's React Native app gets the matching
  token set. *(If a React rewrite of the web UI is acceptable, real shadcn becomes an
  option — flagging the tradeoff, not assuming it.)*
- **Introduce the missing layout system**: `views/partials/head.ejs`, `nav.ejs`,
  `footer.ejs`. The navbar is currently byte-identical copy-paste between
  `home.ejs:11-20` and `leaderboard.ejs:11-20`.
- One token palette: neutral slate base, single accent, semantic
  success/warning/danger. Delete all four existing ad-hoc palettes.
- **Section everything** as requested — each page becomes discrete `<section>` cards with
  clear headers: Home = Hero / Today / Stats / Streak calendar / Territory map /
  Recent runs; Leaderboard = Tabs / Table / Your rank; Run = Map / Live metrics /
  Controls.
- Delete `style.css`, `auth.css`, `run.css`, `leaderboard.css` once ported.
- De-duplicate the frontend JS: `getToken()` is defined identically three times
  (`home.js:2`, `run.js:316`, `leaderboard.js:4`) and `logout()` twice. Extract
  `public/js/api.js` with one axios instance + interceptor; only `run.js:348` currently
  handles a 401 at all. Move the inline `<script>` blocks out of `login.ejs`/`signup.ejs`.
- Replace the three raw `alert()` calls (`run.js:311,350,355`) with real toasts.
- Add a proper HTML 404 page — `server.js:94-96` returns JSON for unknown *page* URLs.

### 7a. Territory name labels — make them actually readable
Currently `home.js:136` drops an `L.divIcon` name pill at each territory centre. It
renders, but it's unreadable: a 10px-radius pill with no contrast guarantee, sitting
directly on top of a `fillOpacity: 0.35` polygon over detailed map tiles, with no
collision handling, and it's drawn for **every** territory so labels pile up on each
other.

Fixes, per your decision that only your own name needs fetching:
- **Only your own territories get a label.** Others stay coloured polygons with no label
  — this removes most of the clutter and shrinks the API payload (`/api/territory/*` no
  longer needs to join or return other users' usernames at all, which also means other
  runners' identities simply aren't sent to the client).
- Readability: solid high-contrast background (not translucent), a subtle white
  halo/outline so it survives over both light roads and dark parks, `font-weight: 600`,
  minimum 12px, and a small drop shadow. Add `paint-order: stroke` text outlining as the
  fallback for any label that must sit on busy tiles.
- **Hide the label below a zoom threshold** and when the territory's on-screen area is
  too small to fit the text — a label narrower than its polygon is worse than none.
- Place at the polygon's **`ST_PointOnSurface`**, not its centroid. A centroid can fall
  *outside* a concave or donut-shaped territory, which is exactly the shape stealing now
  produces (§2). This is a real bug that gets worse once stealing works.
- Non-interactive labels (`interactive: false`) so they don't eat clicks meant for the
  polygon beneath.

### 7b. Running icon — subtler
The current markers are the stock cdnjs Leaflet blue teardrop, hardcoded twice as a
path workaround (`run.js:48-53`, `run.js:90-95`), and the UI's only running-related
glyphs are the `✓`/`✅` checkmarks and `🏃` in server logs.

- Replace with a restrained, purpose-made running mark: a simple monochrome runner
  silhouette in the accent colour at ~70% weight, no gradient, no bounce, no emoji. It
  should read as a quiet position indicator, not a mascot.
- Use the **same silhouette** as the loader in §8 — one coherent visual identity across
  the loading screen, the live-position marker, and the favicon, instead of three
  unrelated icon sources.
- Live marker gets a soft accuracy circle (radius = `coords.accuracy`) rather than a
  hard pin, which is both more honest and visually calmer.
- Same CC0/public-domain licence discipline as §8, recorded in `docs/ASSETS.md`.

---

## 8. Loader screen — 4-stage runner

Requested stages: 25 % stretching → 50 % ready → 75 % set → 100 % run.

**Recommendation: inline SVG + CSS keyframes, not three.js.** A WebGL runtime is
~600 KB and a GPU context *to show a loading screen* — it would make the first paint
slower, directly against §4. An inline SVG figure is ~3 KB, needs zero network requests,
renders instantly, and animates on the compositor.

- Four keyframe poses of a runner silhouette (stretch / ready / set / drive), each a
  small SVG path group, cross-fading as real progress advances.
- **Driven by actual progress**, not a fake timer: stage 1 = HTML parsed, 2 = Tailwind +
  Leaflet loaded, 3 = tiles + user data fetched, 4 = first paint ready. A loader that
  lies is worse than no loader.
- Prefers-reduced-motion: show a static pose + plain progress bar.
- Hard 3-second ceiling — never block the UI on the animation.
- Assets: prefer **CC0/public-domain** sources (openclipart.org, SVG Repo's CC0 filter,
  Font Awesome Free runner glyph under CC-BY-4.0 with attribution). I'll verify the
  licence of anything used and record it in `docs/ASSETS.md`. If nothing suitable and
  cleanly licensed exists, I'll draw the four poses by hand — no licence risk, smaller
  payload. A Lottie/three.js variant can be added later behind a flag if you want more
  spectacle once performance targets are met.

---

## 9. Streak calendar + monthly / yearly summaries

Both read from `user_daily_activity` (§1) — written once per finished run, never
aggregated at request time.

**Streak calendar** (`GET /api/stats/calendar?year=&month=`):
- Month grid, intensity-ramped exactly as requested: more distance that day → deeper,
  bolder cell; light/thin for a short run; empty for a rest day. Four or five buckets
  from quantiles of *that user's own* history, not fixed thresholds, so it stays
  meaningful for a 2 km runner and a 20 km runner alike.
- Must not rely on colour alone (accessibility) — pair depth with border weight, which
  is what you described anyway.
- **Streaks are computed in the user's local date**, which is why `local_date` and
  `tz_offset_minutes` are on the session row. A UTC-based streak breaks for anyone
  running late at night in UTC+6.
- Current streak, longest streak, and longest-streak-this-month.

**Summaries** (`GET /api/stats/summary?period=month|year&date=`), every item requested:
| Metric | Source |
| --- | --- |
| Places visited most | `GROUP BY place_locality ORDER BY count DESC` on cached names |
| Days streak kept | `user_daily_activity` run of consecutive `local_date` |
| Calories burned | `SUM(calories)` |
| New area captured | `SUM(area_gained_m2)` |
| Area lost | `SUM(area_lost_m2)` — from `territory_events` where you were the defender |
| Leaderboard position, both categories | rank over `user_statistics` (both indexes exist) |
| Longest streak in the month | max consecutive run within the month window |

Plus total distance, total runs, active days, best single run. Rendered as a sectioned
report with lightweight inline SVG charts (no charting library — `Chart.js` is ~200 KB
and this needs a bar chart and a ring).

---

## 10. Deployment — DigitalOcean droplet

**Answering your question directly: yes.** One droplet can host many sites, and the
GitHub Student Developer Pack includes **$200 DigitalOcean credit**. On a $6–12/mo
droplet that's ~1.5–3 years of hosting, and it's a better fit than both of your options:
Vercel is serverless and fights a long-lived `pg` pool and GPS sessions with cold starts;
Render's free tier sleeps after 15 minutes, which is exactly the "it's slow" complaint.

Setup:
- **nginx as reverse proxy, one `server` block per domain** → different localhost ports.
  This is the mechanism that lets several unrelated sites share one droplet.
- Territory Runner in Docker Compose: **just the `app` container** — no database
  container, since Postgres lives on Supabase. This removes the PostGIS image, the
  internal network, the volume, and the risk of a droplet rebuild destroying the data.
- `certbot` for Let's Encrypt TLS with auto-renew, covering every domain on the box.
- `pm2` or Docker `restart: unless-stopped`; systemd unit so it survives reboot.
- **Backups come from Supabase** (daily on Pro; 7-day PITR available), so the nightly
  `pg_dump` cron is no longer required. Still add a weekly `pg_dump` to DigitalOcean
  Spaces as an off-provider copy — territories are unrecoverable user achievement data
  and a single vendor holding the only copy is not a backup.
- `ufw`: 22/80/443 only. `fail2ban` on ssh.
- GitHub Actions deploy on push to `main`: build → push image → pull + restart over ssh.
  Supabase migrations run as a separate step against `DIRECT_URL` so a bad migration
  doesn't half-start the app.
- Swap file (1–2 GB) — a 1 GB droplet running Node plus a build will OOM without it.
- Health check that fails when the Supabase pool is unreachable (§3), plus uptime
  monitoring — which **doubles as the keep-warm ping** that stops a free-tier Supabase
  project pausing after 7 days.
- Resource guidance: with Postgres offloaded to Supabase, a **1 GB droplet is now
  sufficient** for the Node app (it was 2 GB minimum with a co-located database), so the
  $200 student credit stretches considerably further.

**Note on the old DB:** the existing connection is irrelevant now — moving to Supabase
means a fresh PostGIS database either way, so there's no need to revive it. If there is
production data in Mongo worth keeping, say so and I'll write a one-off
`scripts/migrate-mongo-to-pg.js` (territories convert cleanly: coordinate array →
`ST_MakePolygon`; users would need Supabase Auth invites since password hashes don't
transfer). Otherwise we start clean.

---

## 11. Phase 2 outline → `docs/phase2.md`

Written as its own document after Phase 1 lands; executed in this session.

React Native + Expo app sharing the Phase 1 API:
- Expo SDK, `expo-router`, TypeScript.
- **`expo-location` with `startLocationUpdatesAsync` + `expo-task-manager`** for
  *background* tracking — the decisive advantage over the web app, which stops recording
  the moment the screen locks. This is the main reason the mobile app is worth building.
- **`@rnmapbox/maps` or MapLibre React Native** for vector tiles (same MapTiler key).
- **`supabase-js` handles auth natively on mobile** — `signInWithOAuth` plus
  `expo-auth-session` for the redirect, with token refresh and secure storage built in.
  Another payoff from the Supabase decision: no custom mobile token flow to write. The
  Bearer path from §6 stays for the Express API calls.
- RLS policies (§1) become load-bearing here if the app queries Supabase directly.
- Port `gps-filter.js` (§5) verbatim — written framework-agnostic for exactly this.
- Offline-first: queue coordinates in SQLite/MMKV and sync on reconnect. A runner in a
  dead zone must not lose a territory.
- Shared design tokens from §7 so web and mobile match.
- `expo-notifications` for streak reminders and "your territory was taken" alerts.
- EAS Build + Expo Go for piloting, then TestFlight / Play internal testing.

---

## Verification

**Per-area checks**
1. **Supabase migration:** `npm run init-db` against the new project → `\dt` shows all
   tables, `SELECT postgis_version()` succeeds, every table reports `rowsecurity = true`.
   Confirm the `auth.users` → `profiles` trigger fires by creating a user in the
   dashboard. Register → login → run → finish → territory appears.
   `grep -ri "mongo\|mongoose" --exclude-dir=node_modules` returns nothing.
   Verify the app connects on the **pooled** port and survives a Supabase restart.
2. **Territory stealing — the cases the current code gets wrong.** Seed two users, then
   verify in SQL after each:
   - Partial overlap → defender trimmed, attacker whole, `SUM(area_m2)` conserved.
   - **Run straight through the middle** → defender becomes a valid 2-part MultiPolygon.
     *This is the case `coordinates[0]` currently breaks.*
   - **Attacker's loop entirely inside defender's** → defender becomes a polygon with a
     hole, `ST_NRings = 2`. *Also currently broken.*
   - Full engulf → defender row deleted, stats hit zero not negative.
   - Self-overlap → own territories union, no double count.
   - Invariant to assert every time:
     `SUM(user_statistics.total_territory_area)` == `SUM(ST_Area(geom::geography))`.
     This is the check that would have caught the existing drift.
3. **Performance — numbers, not impressions.** `npm run bench` before/after:
   - Coordinate writes per 30-min run: expect ~1,800 → ~180.
   - `finish` latency with 1,000 existing territories: expect seconds → <200 ms.
   - `/api/territory/bounds` payload size with simplification on.
   - Lighthouse on `/` and `/run`: target LCP < 2.0 s, TBT < 200 ms.
   - `EXPLAIN ANALYZE` the steal query and **confirm the GiST index is used**, not a seq
     scan.
4. **GPS filter:** unit-test `gps-filter.js` against recorded fixtures — a clean track, a
   track with a 2 km spike, a standing-still track (must accumulate ~0 km), a cold-start
   track. Then one real outdoor run comparing the drawn route against the actual path.
5. **Supabase Auth:** Google sign-up creates an `auth.users` row **and** a matching
   `profiles` + `user_statistics` row via the trigger; signing in with Google on an
   existing email **links** rather than duplicates; session cookie is
   `httpOnly`+`secure`; Bearer header still authenticates (Phase 2 depends on it);
   refresh-token rotation works after the access token expires; logout clears everything.
6. **Security:** confirm user A can no longer finish user B's session (currently
   possible) — expect 403/404. Confirm `/run` redirects when unauthenticated. Confirm a
   missing `SUPABASE_JWT_SECRET` fails at boot instead of 401-ing every request.
   **Test RLS independently** by querying with the anon key directly and confirming you
   cannot read another user's sessions or write their territories.
7. **Calendar/summaries:** seed a known pattern (e.g. 5 consecutive days, gap, 3 days)
   and assert current streak = 3, longest = 5. Verify a late-night run in UTC+6 lands on
   the correct local day. Cross-check summary totals against raw `running_sessions` sums.
8. **Loader:** throttle to Slow 3G and confirm all four stages are visible and advance on
   real progress; confirm reduced-motion fallback; confirm it never blocks past 3 s.
9. **UI:** every page at 360 px / 768 px / 1440 px; confirm `/run` is actually styled
   (it currently isn't); keyboard navigation and focus rings; axe/Lighthouse a11y pass;
   calendar intensity distinguishable without colour.
10. **Labels and icon:** your own territory name legible over a dense city basemap, a
    park, and at the zoom threshold; **label sits inside a donut-shaped territory** after
    being stolen through the middle (the `ST_PointOnSurface` fix — a centroid would place
    it in the hole); no label overlap when three of your territories adjoin; confirm
    other runners' usernames are **absent from the API response**, not merely hidden in
    the UI; runner marker reads clearly at every zoom without looking like a mascot.

**End-to-end smoke test, run as the final gate**
`npm run dev` → sign up with Google → start run → simulate a loop with injected
coordinates → finish → territory on map → second user overlaps it → first user's
territory visibly shrinks on the map and in their stats → calendar marks both days →
monthly summary shows area gained for one user and **area lost** for the other →
leaderboard ranks update → deploy to droplet → repeat against the live domain over HTTPS.
