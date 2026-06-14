# Territory Runner — mobile

Written for: whoever develops and builds the app (you, or a teammate picking it up).

React Native via Expo, sharing the Phase 1 API, database and GPS filter.

## Why this app exists

The web app has one limitation it cannot engineer around: **browsers suspend
geolocation when a tab is hidden or the screen locks.** For a running app that
means the route stops recording the moment a runner pockets their phone — which
is what runners do — and the territory is lost with it.

Native background location fixes exactly that, and everything else here follows
from it:

| Feature | Why it matters |
| --- | --- |
| Background tracking | The route keeps recording with the screen locked |
| Offline queue in SQLite | A dead zone cannot cost you a territory |
| Vector tiles | Sharper at every zoom, cheaper on mobile data |
| Push notifications | "Your territory was taken" closes the game loop |

## Setup

```bash
cd mobile
npm install
cp .env.example .env     # set your LAN IP, Supabase and MapTiler values
npx expo start
```

**`EXPO_PUBLIC_API_URL` must be your machine's LAN IP, not `localhost`** —
on a phone, `localhost` is the phone itself. Find it with `ipconfig` (Windows)
or `ifconfig | grep inet` (macOS/Linux), and make sure the web server is
listening on all interfaces.

### Expo Go will not be enough

**Expo Go cannot run background location.** It lacks the native background
modes and the foreground-service entitlement, so the headline feature simply
does not work there. You need a development build from the start:

```bash
npx eas build --profile development --platform android   # or ios
```

Install that build once, then `npx expo start --dev-client` for normal
development. This surprises people mid-project, so it is worth doing first.

## Architecture

```text
lib/
  location-task.ts   Background task. Runs in its OWN JS context — it cannot
                     share React state with the UI, which is why everything
                     goes through SQLite.
  queue.ts           Durable fix queue + the active_run row that survives the
                     app being killed mid-run.
  sync.ts            Drains the queue to the server. Marks a batch sent only
                     after the server acknowledges it.
  supabase.ts        Auth. Sessions in SecureStore (Keychain/Keystore), never
                     AsyncStorage.
  api.ts             The same Express endpoints the web app calls, with Bearer
                     auth instead of a cookie.
  theme.ts           Design tokens mirroring tailwind.config.js.
  format.ts          Formatters mirroring public/js/ui.js.
app/
  _layout.tsx        Auth gate; registers the background task at module scope.
  index.tsx          Dashboard, streak calendar, run recovery.
  run.tsx            Live run. Reads the queue for display, so it shows what
                     was ACTUALLY recorded, including while locked.
  login.tsx          Google OAuth and email/password.
  leaderboard.tsx    Both metrics.
  summary.tsx        Monthly and yearly.
components/
  RunMap.tsx         MapLibre, territory layers, own-only name labels.
  StreakCalendar.tsx The web calendar's intensity ramp.
../shared/
  gps-filter.js      Imported by BOTH clients. One implementation, so the two
                     can never disagree about a run's distance.
```

### Two rules worth not breaking

**1. The background task must not throw.** An unhandled error gets the task
killed by the OS and the run ends silently. Everything inside it is wrapped.

**2. A batch is marked sent only after the server acknowledges it.** The
`(running_session_id, seq)` unique constraint from `config/schema.sql` makes a
replayed batch a no-op, so retrying is always safe and discarding is never
necessary. A run must never be lost to an optimistic delete.

## Permissions

Requested in order, foreground first, with an explanation before escalating to
background. Asking for "always allow" cold is the most common reason it gets
denied outright.

If background is refused the app **degrades rather than breaking**: it records
while open and says so. iOS App Review rejects vague background-location
justifications, so the strings in `app.config.ts` are specific on purpose.

## Testing

```bash
npm test          # parity with the web GPS filter
npm run typecheck
```

The checks that need a real device and a real run:

1. **Background tracking** — start a run, lock the screen, run 10+ minutes,
   come back. The track must have no gap. Repeat with the app force-backgrounded,
   on both platforms. This is the test the whole phase exists for.
2. **Offline** — airplane mode mid-run, keep running, re-enable. Every queued
   fix must arrive exactly once. Then record a complete run offline and confirm
   it reconciles.
3. **Idempotency** — replay a synced batch; no duplicate coordinates, no
   inflated distance.
4. **Battery** — measure drain over a 60-minute run in both modes and write the
   number down.
5. **Cross-platform parity** — the same run must show identical distance, area,
   calories, streak and rank on web and mobile.

## Before release

- Replace the placeholder assets in `assets/` (see `assets/README.md`).
- A **privacy policy URL** — required by both stores, and it also unblocks
  Facebook OAuth from Phase 1.
- Location-data disclosure in both stores' data-safety forms.
- An explicit written justification for background location.
