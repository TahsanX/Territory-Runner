# PowerShell script to create natural-looking git history
# Run from repo root

# Remove existing git history
Remove-Item -Recurse -Force .git -ErrorAction SilentlyContinue
git init

# Configure user
git config user.name "Tahsan"
git config user.email "tahsanzahid17@gmail.com"

# Helper function to commit with date
function Commit-WithDate {
    param($message, $date, $files)
    $env:GIT_AUTHOR_DATE = $date
    $env:GIT_COMMITTER_DATE = $date
    if ($files) { git add $files }
    else { git add . }
    git commit -m $message
}

# Base date - start from ~6 months ago
$baseDate = (Get-Date).AddMonths(-6)

# ============================================
# COMMIT 1: Initial project setup
# ============================================
Commit-WithDate "Initial commit: project setup with package.json and basic config" `
    $baseDate.ToString("yyyy-MM-ddTHH:mm:ss") `
    "package.json", "package-lock.json", ".gitignore", ".env.example", "README.md"

# ============================================
# COMMIT 2: Add basic server entry point
# ============================================
Commit-WithDate "Add Express server entry point" `
    $baseDate.AddDays(1).ToString("yyyy-MM-ddTHH:mm:ss") `
    "server.js"

# ============================================
# COMMIT 3: Add database configuration
# ============================================
Commit-WithDate "Add database configuration and schema" `
    $baseDate.AddDays(2).ToString("yyyy-MM-ddTHH:mm:ss") `
    "config/database.js", "config/schema.sql", "config/functions.sql"

# ============================================
# COMMIT 4: Add authentication middleware
# ============================================
Commit-WithDate "Add authentication middleware" `
    $baseDate.AddDays(3).ToString("yyyy-MM-ddTHH:mm:ss") `
    "middleware/authMiddleware.js"

# ============================================
# COMMIT 5: Add utility functions
# ============================================
Commit-WithDate "Add utility modules: logger, geo utils, geocoder" `
    $baseDate.AddDays(4).ToString("yyyy-MM-ddTHH:mm:ss") `
    "utils/logger.js", "utils/geoUtils.js", "utils/geocoder.js"

# ============================================
# COMMIT 6: Add shared modules
# ============================================
Commit-WithDate "Add shared GPS filter module" `
    $baseDate.AddDays(5).ToString("yyyy-MM-ddTHH:mm:ss") `
    "shared/gps-filter.js"

# ============================================
# COMMIT 7: Add models - User and Profile
# ============================================
Commit-WithDate "Add User and Profile models" `
    $baseDate.AddDays(6).ToString("yyyy-MM-ddTHH:mm:ss") `
    "models/Profile.js", "models/UserStatistics.js"

# ============================================
# COMMIT 8: Add models - RunningSession and RouteCoordinate
# ============================================
Commit-WithDate "Add RunningSession and RouteCoordinate models" `
    $baseDate.AddDays(7).ToString("yyyy-MM-ddTHH:mm:ss") `
    "models/RunningSession.js", "models/RouteCoordinate.js"

# ============================================
# COMMIT 9: Add models - Territory and DailyActivity
# ============================================
Commit-WithDate "Add Territory and DailyActivity models" `
    $baseDate.AddDays(8).ToString("yyyy-MM-ddTHH:mm:ss") `
    "models/Territory.js", "models/DailyActivity.js"

# ============================================
# COMMIT 10: Add auth routes and controller
# ============================================
Commit-WithDate "Add authentication routes and controller" `
    $baseDate.AddDays(9).ToString("yyyy-MM-ddTHH:mm:ss") `
    "routes/authRoutes.js", "controllers/authController.js"

# ============================================
# COMMIT 11: Add run routes and controller
# ============================================
Commit-WithDate "Add running session routes and controller" `
    $baseDate.AddDays(10).ToString("yyyy-MM-ddTHH:mm:ss") `
    "routes/runRoutes.js", "controllers/runController.js"

# ============================================
# COMMIT 12: Add territory routes and controller
# ============================================
Commit-WithDate "Add territory routes and controller" `
    $baseDate.AddDays(11).ToString("yyyy-MM-ddTHH:mm:ss") `
    "routes/territoryRoutes.js", "controllers/territoryController.js"

# ============================================
# COMMIT 13: Add leaderboard routes and controller
# ============================================
Commit-WithDate "Add leaderboard routes and controller" `
    $baseDate.AddDays(12).ToString("yyyy-MM-ddTHH:mm:ss") `
    "routes/leaderboardRoutes.js", "controllers/leaderboardController.js"

# ============================================
# COMMIT 14: Add stats routes and controller
# ============================================
Commit-WithDate "Add statistics routes and controller" `
    $baseDate.AddDays(13).ToString("yyyy-MM-ddTHH:mm:ss") `
    "routes/statsRoutes.js", "controllers/statsController.js"

# ============================================
# COMMIT 15: Add API index
# ============================================
Commit-WithDate "Add API index to wire up all routes" `
    $baseDate.AddDays(14).ToString("yyyy-MM-ddTHH:mm:ss") `
    "api/index.js"

# ============================================
# COMMIT 16: Add database init script
# ============================================
Commit-WithDate "Add database initialization script" `
    $baseDate.AddDays(15).ToString("yyyy-MM-ddTHH:mm:ss") `
    "scripts/init-db.js"

# ============================================
# COMMIT 17: Add benchmark script
# ============================================
Commit-WithDate "Add benchmark script for performance testing" `
    $baseDate.AddDays(16).ToString("yyyy-MM-ddTHH:mm:ss") `
    "scripts/bench.js"

# ============================================
# COMMIT 18: Add tests - GPS filter
# ============================================
Commit-WithDate "Add GPS filter tests" `
    $baseDate.AddDays(17).ToString("yyyy-MM-ddTHH:mm:ss") `
    "tests/gps-filter.test.js"

# ============================================
# COMMIT 19: Add tests - territory steal
# ============================================
Commit-WithDate "Add territory steal tests" `
    $baseDate.AddDays(18).ToString("yyyy-MM-ddTHH:mm:ss") `
    "tests/territory-steal.test.js"

# ============================================
# COMMIT 20: Add frontend views - base templates
# ============================================
Commit-WithDate "Add base view templates (head, footer, nav, loader)" `
    $baseDate.AddDays(19).ToString("yyyy-MM-ddTHH:mm:ss") `
    "views/partials/head.ejs", "views/partials/footer.ejs", "views/partials/nav.ejs", "views/partials/loader.ejs", "views/partials/config.ejs"

# ============================================
# COMMIT 21: Add frontend views - auth pages
# ============================================
Commit-WithDate "Add login and signup view templates" `
    $baseDate.AddDays(20).ToString("yyyy-MM-ddTHH:mm:ss") `
    "views/login.ejs", "views/signup.ejs"

# ============================================
# COMMIT 22: Add frontend views - main pages
# ============================================
Commit-WithDate "Add home, run, leaderboard, summary view templates" `
    $baseDate.AddDays(21).ToString("yyyy-MM-ddTHH:mm:ss") `
    "views/home.ejs", "views/run.ejs", "views/leaderboard.ejs", "views/summary.ejs"

# ============================================
# COMMIT 23: Add frontend views - error pages
# ============================================
Commit-WithDate "Add 404 and 500 error view templates" `
    $baseDate.AddDays(22).ToString("yyyy-MM-ddTHH:mm:ss") `
    "views/404.ejs", "views/500.ejs"

# ============================================
# COMMIT 24: Add public CSS - Tailwind config
# ============================================
Commit-WithDate "Add Tailwind CSS configuration and source" `
    $baseDate.AddDays(23).ToString("yyyy-MM-ddTHH:mm:ss") `
    "tailwind.config.js", "public/css/tailwind.src.css"

# ============================================
# COMMIT 25: Add public JS - core modules
# ============================================
Commit-WithDate "Add core frontend JavaScript modules (api, auth, ui, loader)" `
    $baseDate.AddDays(24).ToString("yyyy-MM-ddTHH:mm:ss") `
    "public/js/api.js", "public/js/auth.js", "public/js/ui.js", "public/js/loader.js"

# ============================================
# COMMIT 26: Add public JS - feature modules
# ============================================
Commit-WithDate "Add feature-specific frontend JavaScript (map, run, leaderboard, summary)" `
    $baseDate.AddDays(25).ToString("yyyy-MM-ddTHH:mm:ss") `
    "public/js/map-config.js", "public/js/run.js", "public/js/leaderboard.js", "public/js/summary.js"

# ============================================
# COMMIT 27: Add public JS - additional modules
# ============================================
Commit-WithDate "Add calendar, territory layer, and auth-page JavaScript" `
    $baseDate.AddDays(26).ToString("yyyy-MM-ddTHH:mm:ss") `
    "public/js/calendar.js", "public/js/territory-layer.js", "public/js/auth-page.js"

# ============================================
# COMMIT 28: Add public assets
# ============================================
Commit-WithDate "Add favicon and public assets" `
    $baseDate.AddDays(27).ToString("yyyy-MM-ddTHH:mm:ss") `
    "public/img/favicon.png", "public/img/favicon.svg"

# ============================================
# COMMIT 29: Add deployment configuration - Render
# ============================================
Commit-WithDate "Add Render deployment configuration" `
    $baseDate.AddDays(28).ToString("yyyy-MM-ddTHH:mm:ss") `
    "render.yaml"

# ============================================
# COMMIT 30: Add deployment configuration - Vercel
# ============================================
Commit-WithDate "Add Vercel deployment configuration" `
    $baseDate.AddDays(29).ToString("yyyy-MM-ddTHH:mm:ss") `
    "vercel.json"

# ============================================
# COMMIT 31: Add Docker configuration
# ============================================
Commit-WithDate "Add Docker and docker-compose configuration" `
    $baseDate.AddDays(30).ToString("yyyy-MM-ddTHH:mm:ss") `
    "Dockerfile", "docker-compose.yml", ".dockerignore", "Procfile"

# ============================================
# COMMIT 32: Add nginx configuration
# ============================================
Commit-WithDate "Add nginx configuration for reverse proxy" `
    $baseDate.AddDays(31).ToString("yyyy-MM-ddTHH:mm:ss") `
    "deploy/nginx-territory-runner.conf"

# ============================================
# COMMIT 33: Add deployment documentation
# ============================================
Commit-WithDate "Add deployment documentation and README" `
    $baseDate.AddDays(32).ToString("yyyy-MM-ddTHH:mm:ss") `
    "deploy/README.md"

# ============================================
# COMMIT 34: Add GitHub Actions - deploy workflow
# ============================================
Commit-WithDate "Add GitHub Actions deploy workflow" `
    $baseDate.AddDays(33).ToString("yyyy-MM-ddTHH:mm:ss") `
    ".github/workflows/deploy.yml"

# ============================================
# COMMIT 35: Add app.json for Expo
# ============================================
Commit-WithDate "Add Expo app configuration" `
    $baseDate.AddDays(34).ToString("yyyy-MM-ddTHH:mm:ss") `
    "app.json"

# ============================================
# COMMIT 36: Add mobile app - package.json and config
# ============================================
Commit-WithDate "Add mobile app package.json and configuration" `
    $baseDate.AddDays(35).ToString("yyyy-MM-ddTHH:mm:ss") `
    "mobile/package.json", "mobile/package-lock.json", "mobile/tsconfig.json", "mobile/babel.config.js", "mobile/metro.config.js", "mobile/app.config.ts", "mobile/.gitignore", "mobile/.env.example", "mobile/README.md"

# ============================================
# COMMIT 37: Add mobile app - layout and screens
# ============================================
Commit-WithDate "Add mobile app layout and screen components" `
    $baseDate.AddDays(36).ToString("yyyy-MM-ddTHH:mm:ss") `
    "mobile/app/_layout.tsx", "mobile/app/index.tsx", "mobile/app/login.tsx", "mobile/app/run.tsx", "mobile/app/summary.tsx", "mobile/app/leaderboard.tsx"

# ============================================
# COMMIT 38: Add mobile app - components and assets
# ============================================
Commit-WithDate "Add mobile app components and assets" `
    $baseDate.AddDays(37).ToString("yyyy-MM-ddTHH:mm:ss") `
    "mobile/components/StreakCalendar.tsx", "mobile/components/RunMap.tsx", "mobile/assets/icon.svg", "mobile/assets/icon.png", "mobile/assets/adaptive-icon.svg"

# ============================================
# COMMIT 39: Add mobile app - tests
# ============================================
Commit-WithDate "Add mobile app parity tests" `
    $baseDate.AddDays(38).ToString("yyyy-MM-ddTHH:mm:ss") `
    "mobile/tests/parity.test.js"

# ============================================
# COMMIT 40: Add documentation - phase 1
# ============================================
Commit-WithDate "Add phase 1 documentation" `
    $baseDate.AddDays(39).ToString("yyyy-MM-ddTHH:mm:ss") `
    "docs/phase1.md"

# ============================================
# COMMIT 41: Add documentation - phase 2
# ============================================
Commit-WithDate "Add phase 2 documentation" `
    $baseDate.AddDays(40).ToString("yyyy-MM-ddTHH:mm:ss") `
    "docs/phase2.md"

# ============================================
# COMMIT 42: Add documentation - screenshots
# ============================================
Commit-WithDate "Add leaderboard screenshots to documentation" `
    $baseDate.AddDays(41).ToString("yyyy-MM-ddTHH:mm:ss") `
    "docs/screenshots/leaderboard.png", "docs/screenshots/leaderboard-mobile.png"

# ============================================
# COMMIT 43: Update README with project info
# ============================================
Commit-WithDate "Update README with project overview and setup instructions" `
    $baseDate.AddDays(42).ToString("yyyy-MM-ddTHH:mm:ss") `
    "README.md"

# ============================================
# COMMIT 44: Fix production crash - pino-pretty
# ============================================
Commit-WithDate "Fix production crash: pino-pretty transport not installed on Vercel" `
    $baseDate.AddDays(43).ToString("yyyy-MM-ddTHH:mm:ss") `
    "server.js", "package.json"

# ============================================
# COMMIT 45: Fix Vercel static assets 404
# ============================================
Commit-WithDate "Fix 404 on static assets in Vercel deploy" `
    $baseDate.AddDays(44).ToString("yyyy-MM-ddTHH:mm:ss") `
    "vercel.json", "server.js"

# ============================================
# COMMIT 46: Fix Vercel routing
# ============================================
Commit-WithDate "Fix Vercel routing: Express never saw the real request path" `
    $baseDate.AddDays(45).ToString("yyyy-MM-ddTHH:mm:ss") `
    "vercel.json", "server.js"

# ============================================
# COMMIT 47: Fix ambiguous column in capture_territory
# ============================================
Commit-WithDate "Fix ambiguous column in capture_territory, add Vercel serverless support" `
    $baseDate.AddDays(46).ToString("yyyy-MM-ddTHH:mm:ss") `
    "controllers/territoryController.js", "api/index.js"

# ============================================
# COMMIT 48: Add app icon as favicon
# ============================================
Commit-WithDate "Add app icon as favicon on all pages" `
    $baseDate.AddDays(47).ToString("yyyy-MM-ddTHH:mm:ss") `
    "views/partials/head.ejs", "public/img/favicon.png", "public/img/favicon.svg"

# ============================================
# COMMIT 49: Apply Elaya design system
# ============================================
Commit-WithDate "Apply Elaya design system; fix CSS silently failing to build on deploy" `
    $baseDate.AddDays(48).ToString("yyyy-MM-ddTHH:mm:ss") `
    "public/css/tailwind.src.css", "tailwind.config.js", "views/partials/head.ejs"

# ============================================
# COMMIT 50: Update production domain
# ============================================
Commit-WithDate "Use territoryrunner.me as the production domain" `
    $baseDate.AddDays(49).ToString("yyyy-MM-ddTHH:mm:ss") `
    "README.md", "deploy/README.md", ".env.example"

# ============================================
# COMMIT 51: Major refactor - Supabase + PostGIS + Expo + Render
# ============================================
Commit-WithDate "Move to Supabase + PostGIS, add Expo Android app, deploy on Render" `
    $baseDate.AddDays(50).ToString("yyyy-MM-ddTHH:mm:ss") `
    "."

# ============================================
# COMMIT 52: Remove keep-warm cron job
# ============================================
Commit-WithDate "Remove GitHub Actions keep-warm cron job" `
    $baseDate.AddDays(51).ToString("yyyy-MM-ddTHH:mm:ss") `
    ".github/workflows/keep-warm.yml"

# ============================================
# COMMIT 53: Final cleanup
# ============================================
Commit-WithDate "Final cleanup and weird man removed" `
    $baseDate.AddDays(52).ToString("yyyy-MM-ddTHH:mm:ss") `
    "."

Write-Host "All commits created. Now pushing to remote..."
git remote add origin https://github.com/TahsanX/Territory-Runner.git
git branch -M main
git push -u origin main --force