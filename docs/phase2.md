# Territory Runner — Phase 2 (Mobile) Implementation Plan

## Context

Phase 1 delivers a fast, correct web app on Supabase + PostGIS. Phase 2 adds a
**React Native app driven by Expo**, sharing the same API, database and design tokens.

This is not a port for its own sake. The web app has one unavoidable limitation: a
browser stops `navigator.geolocation.watchPosition` the moment the screen locks or the
tab is backgrounded. For a running app that means **the territory is lost if the runner
pockets their phone** — which is what runners actually do. Native background location is
the single feature that makes the mobile app worth building, and everything else follows
from it.

Prerequisites from Phase 1 (all deliberately built to be reused here):
- `public/js/gps-filter.js` — written framework-agnostic specifically to be ported.
- Supabase Auth with the `Authorization: Bearer` path kept alive — mobile cannot use the
  `httpOnly` cookie the web app uses.
- RLS policies on every table — these become load-bearing if the app talks to Supabase
  directly instead of through Express.
- The design token set from the Tailwind redesign.
- Batched `POST /api/run/:id/coordinates` — mobile needs this even more than web, since
  it will sync a whole backlog at once after a dead zone.

---

## 1. Project setup

- **Expo SDK** (managed workflow), **TypeScript**, **`expo-router`** for file-based
  routing. Managed workflow is the right call: every native module needed below is in
  the Expo ecosystem, so there's no reason to eject.
- Monorepo decision: keep the Expo app in `mobile/` inside this repo rather than a
  separate one, so the shared GPS filter and design tokens live in one place and can't
  drift. A `shared/` directory holds both.
- `app.config.ts` reading from the same `.env` convention as the web app, with
  `EXPO_PUBLIC_` prefixes for the client-exposed values (Supabase URL, anon key,
  MapTiler key). **The service-role key must never appear in the mobile bundle** — it
  bypasses every RLS policy and a mobile app binary is fully readable by anyone.
- Screens mirroring the web routes: Home (stats + streak calendar), Run (live tracking),
  Leaderboard, Summary (monthly/yearly), Profile.

## 2. Background location — the core of this phase

- **`expo-location` + `expo-task-manager`**: `startLocationUpdatesAsync` with a
  registered background task, so tracking survives screen lock and app backgrounding.
- `accuracy: Location.Accuracy.BestForNavigation`, with `distanceInterval` and
  `deferredUpdatesInterval` tuned to trade battery against fidelity.
- **Foreground service notification on Android** — mandatory from Android 8+ for
  background location. It also doubles as a live run display in the notification shade.
- **iOS specifics:** `UIBackgroundModes: ["location"]`, plus
  `NSLocationAlwaysAndWhenInUseUsageDescription` with a clear, honest string. iOS
  rejects apps whose background-location justification is vague, so this copy matters
  for App Store review.
- **Permission flow done properly**: request when-in-use first, explain *why* before
  escalating to always-allow. Asking for always-allow cold is the most common reason
  users deny it outright.
- Battery: document the real cost and offer a battery-saver mode (lower accuracy, larger
  `distanceInterval`) for long runs.
- **Port `gps-filter.js` verbatim** from Phase 1 §5 — accuracy rejection, speed-jump
  rejection, minimum displacement, cold-start discard, smoothing. Native fixes need this
  just as much as browser fixes; `BestForNavigation` is not the same as accurate.

## 3. Offline-first

A runner in a dead zone must not lose a territory. This is the second-biggest reason the
mobile app exists.

- Queue every accepted fix locally in **`expo-sqlite`** (preferred over MMKV here: a run
  is thousands of rows and wants real queries, not a key-value blob).
- Background sync flushes the queue to `POST /api/run/:id/coordinates` on reconnect, in
  batches, idempotently — the server must tolerate a replayed batch without
  double-counting, so include a client-generated monotonic sequence number per fix and
  dedupe on `(session_id, seq)`.
- A run can be **started, recorded and finished entirely offline**, then reconciled.
  `finish` becomes a queued operation too, which means territory capture and the steal
  resolution happen server-side at sync time — and the steal is correctly ordered by
  server receipt, not by client clock.
- Show sync state honestly in the UI: recording / pending upload / synced. Never imply a
  territory is captured before the server has confirmed it.

## 4. Maps — vector tiles

- **MapLibre React Native** (`@maplibre/maplibre-react-native`) or `@rnmapbox/maps`,
  with the **same MapTiler key** from Phase 1. Preference is MapLibre: no Mapbox
  account, no per-MAU pricing, and the Phase 1 map config constant carries over.
- This is where the MapLibre migration deferred in Phase 1 §5 actually pays off: vector
  tiles are sharper at every zoom, rotate with the runner's heading, and cache far better
  on a metered mobile connection.
- Offline tile caching for the user's usual running area — directly useful, and the
  natural companion to offline recording.
- Territory polygons from `ST_AsGeoJSON` render as a native GeoJSON source — no
  coordinate re-mapping, same payload the web app consumes.
- Carry over the Phase 1 §7a label rules: only your own territories labelled, placed at
  `ST_PointOnSurface`, hidden below a zoom threshold.
- Carry over the §7b runner silhouette and accuracy circle, so web and mobile show the
  same mark.

## 5. Auth

- **`supabase-js` + `expo-auth-session`** for the Google OAuth redirect. Supabase handles
  token refresh and secure storage, so there is no custom mobile token flow to write —
  a direct payoff of the Supabase decision in Phase 1.
- Session persisted in **`expo-secure-store`** (Keychain / Keystore), never
  `AsyncStorage` — an auth token in plaintext storage on a rooted device is a real leak.
- Add the mobile `redirectUri` schemes to the Google console and the Supabase allowed
  redirect list.
- API calls use the `Authorization: Bearer` header path kept alive in Phase 1 §6.

## 6. Notifications

- `expo-notifications` for:
  - **Streak reminders** — "you're on day 6, don't break it" late in the day, only if
    no run is recorded yet. Respect quiet hours and make it easy to turn off; a fitness
    app that nags gets uninstalled.
  - **"Your territory was taken"** — fired from the `territory_events` row written by the
    Phase 1 steal transaction. This is the feature that makes stealing feel like a game
    rather than a silent number change, and it closes the motivation loop you described.
  - Weekly/monthly summary ready.
- Push tokens stored per user; send via Expo's push service from the Express app.

## 7. Shared code and design parity

- `shared/gps-filter.js` — one implementation, imported by both web and mobile.
- `shared/tokens.ts` — the Phase 1 palette, radii and type scale, consumed by Tailwind on
  web and by NativeWind (or StyleSheet constants) on mobile, so the two can't drift.
- `shared/stats.ts` — streak and summary calculations where any client-side computation
  is needed, so web and mobile can never disagree about a streak length.
- Reuse the Phase 1 `/api/stats/calendar` and `/api/stats/summary` endpoints as-is; the
  calendar and summary screens are new UI over an existing API.

## 8. Build and piloting

- **Expo Go** for day-to-day development — but note it **cannot run background
  location**, so that work requires a development build from the start. Plan for this;
  it surprises people mid-phase.
- **EAS Build** for development, preview and production profiles.
- **EAS Update** for OTA JS updates without a store round-trip.
- Piloting: development build on your own device for real outdoor runs, then
  **TestFlight** (iOS) and **Play internal testing** (Android).
- Store submission needs, worth starting early because they gate release:
  a privacy policy URL (also unblocks Facebook OAuth from Phase 1 §6), a
  location-data disclosure in both stores' data-safety forms, icons and splash assets,
  and an explicit justification for background location.

---

## Verification

1. **Background tracking, the headline feature:** start a run, lock the screen, run
   10+ minutes, return — the full track must be present with no gap. Repeat with the app
   force-backgrounded, and on both iOS and Android. This is the test the whole phase
   exists for.
2. **Offline:** enable airplane mode mid-run, keep running, re-enable — every queued fix
   arrives exactly once, and the territory resolves correctly. Then run a complete
   session start-to-finish offline and confirm it reconciles on reconnect.
3. **Idempotency:** replay an already-synced batch and confirm no duplicate coordinates
   and no double-counted distance.
4. **GPS filter parity:** the ported filter must produce **identical output** to the web
   version on the same fixture tracks — assert this as a test, don't eyeball it.
5. **Auth:** Google sign-in on device; token in SecureStore not AsyncStorage; refresh
   after expiry; the same account shows the same territories on web and mobile.
6. **RLS:** with only the anon key (as the mobile bundle has), confirm you cannot read
   another user's sessions or write their territories.
7. **Battery:** measure drain over a 60-minute tracked run on both platforms and record
   the number. Compare battery-saver mode against full accuracy.
8. **Permissions:** deny always-allow and confirm the app degrades gracefully with a
   clear explanation rather than breaking or silently recording nothing.
9. **Notifications:** trigger a real steal from the web app and confirm the defender's
   phone receives the alert.
10. **Cross-platform parity:** same run data renders identically on web and mobile —
    distance, area, calories, streak and leaderboard rank must agree to the last digit.

**End-to-end gate**
Sign in with Google on the phone → start a run → lock the screen → complete a loop
outdoors over a territory owned by a web account → unlock → territory captured and the
web user's territory visibly shrinks → the web user receives a "territory taken" push →
both clients show matching stats, streak calendar entries and leaderboard positions.
