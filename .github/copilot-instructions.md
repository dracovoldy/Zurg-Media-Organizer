<!-- Copilot / AI agent instructions for the Zurg-Media-Organizer repo -->

Summary
- Short goal: help an AI agent become productive quickly in this repository by documenting architecture, conventions, important files, env vars, and safe developer workflows.

Key facts (big picture)
- Small Express app that watches a filesystem tree and synchronizes folder metadata into a Prisma/SQLite DB (`prisma/schema.prisma`).
- Main responsibilities:
  - Watch a configured directory (env ZURG_ALL_PATH) and create/maintain Directory and File rows (see `index.js` syncDirectory + chokidar watcher).
  - Parse directory names into parsedName/parsedYear/parsedType using `utils/parser.js`.
  - Match directories to TMDB via `utils/tmdb.js` (uses TMDB_BEARER_TOKEN) and create library symlinks via `utils/library.js`.
  - Admin UI and AJAX endpoints use EJS views in `views/` and routes implemented in `routes/directoryRoutes.js` + `controllers/directoryController.js`.

Architecture specifics
- The source media server is a WebDAV server. In typical deployments the WebDAV source is mounted locally using `rclone` at `/mnt/zurg/__all__/` (this repo's default `ZURG_ALL_PATH`).
- The mount root (`/mnt/zurg/__all__/`) contains only folders (one folder per media item). Media files live inside those folders (movies, series episodes, sports, etc.).
- Because this is an rclone-mounted WebDAV filesystem, inotify events (which chokidar relies on) may not bubble up reliably. The current watcher in `index.js` uses chokidar with polling as a mitigation, but this area is fragile and is the primary operational improvement to make (better event propagation, more robust polling, or a rework to an explicit sync cadence).


Important files and examples
- `index.js` — app bootstrap: Express setup, Prisma client, chokidar watcher, PRAGMA tweaks for SQLite (WAL, busy_timeout). Important: startup sets DATABASE_URL to test DB when TESTING/TESTING_MODE is set.
- `routes/directoryRoutes.js` — wiring; note routes are factories: `createDirectoryRoutes(prisma)` so controllers always receive the same Prisma instance.
- `controllers/directoryController.js` — business endpoints. Examples: `addToLibrarySingle`, `updateAllTmdb`, `manualSync` show how DB + utils are used.
- `utils/parser.js` — canonical parsing logic. Returns { parsed_name, parsed_year, type, specialName, metadata } used widely by controllers.
- `utils/library.js` — library rules: category mapping (Indian languages => `desi-*`), file versioning (`getNextVersionedFilePath`), symlink creation (`createSymlinkForFile`) and helpers `processMovieDirectory` / `processShowDirectory`. Use `getSymlinkTargetPath` to honor test overrides.
- `utils/tmdb.js` — TMDB calls (uses `TMDB_BEARER_TOKEN`) with a Bottleneck rate limiter; errors often surfaced as `API_DOWN` or `HTTP_ERROR_<code>` strings.
- `prisma/schema.prisma` — data model (Directory, File, Library). Note: `metadata` is stored as a stringified JSON blob for SQLite.

Environment & scripts (how to run / safe commands)
- Required env vars commonly used in this repo:
  - DATABASE_URL — Prisma DB connection (default in schema uses sqlite file in `prisma/dev.db`).
  - ZURG_ALL_PATH — path to watch (defaults to `/mnt/zurg/__all__/`).
  - LIBRARY_BASE_PATH — base root for library symlinks (defaults to `/mnt/library`).
  - TMDB_BEARER_TOKEN — TMDB API bearer token used by `utils/tmdb.js`.
  - PORT — server port (default 4004).
  - TESTING, TESTING_MODE, TESTING_LIBRARY_BASE_PATH, TESTING_SYMLINK_PATH — test-mode switches (index.js and utils/library.js honor these to avoid writing to real paths).
- Useful npm scripts from `package.json`:
  - `npm run dev` — start with `nodemon` for development.
  - `npm start` — production start uses `pm2 start index.js --name Zurg-Organizer`.
  - `npm run db:generate` — `npx prisma generate` (regenerate client after schema changes).
  - `npm run db:reset` / `db:reset:seed` — destructive: resets DB; always run backups first. See `scripts/db-backup.sh`.
  - `npm run seed` — run `prisma/seed.js` (safe to run; returns true on error due to `|| true`).

Deploy / host notes
- This app is commonly hosted with `pm2` in production (`npm start` uses `pm2 start index.js --name Zurg-Organizer`). Keep that in mind when adding process-level features (clustering, restarts, env propagation).

Patterns & conventions (what to follow)
- Controllers are factory functions that accept a Prisma instance (do not new-up Prisma inside routes/controllers). Example: `const createDirectoryRoutes = require('./routes/directoryRoutes'); const directoryRoutes = createDirectoryRoutes(prisma);`
- `metadata` column is a stringified JSON blob — read and write carefully using parser helpers in `controllers/directoryController.js` (see `parseMetadataField` / `serializeMetadata`). Do not assume a native JSON column.
- Naming & versioning: `utils/library.getNextVersionedFilePath` defines how media filenames are versioned when symlinked: prefer `[resolution]` labels, fallback to `[V#]`. Use these helpers instead of inventing new filename rules.
- TMDB matching: `searchTmdb` may return null or throw `API_DOWN`/`HTTP_ERROR_<code>`; calling code stores status in `tmdbStatus` (e.g., MATCH_FOUND, NO_MATCH_FOUND, API_DOWN). Preserve these statuses when changing flow.
- Filesystem operations: code prefers symlinks over moving files. Tests and CI should use `TESTING_SYMLINK_PATH`/`TESTING_LIBRARY_BASE_PATH` to avoid touching real mounts.

DB & local dev gotchas
- SQLite is used in local dev; startup sets PRAGMA journal_mode = WAL and busy_timeout via raw PRAGMA calls in `index.js`. If you change DB access patterns, expect concurrency issues when running many deletes (code batches deletes in chunks to avoid P1008 timeouts).
- When changing Prisma schema:
  1. Update `prisma/schema.prisma`.
  2. Run migrations (e.g., `npx prisma migrate dev`) or use existing migrations in `prisma/migrations/`.
  3. Run `npm run db:generate` to regenerate the client.

What to avoid / safety checks for agents
- Don't run destructive DB scripts (e.g., `db:reset`) unless user explicitly requests and they confirm a backup was taken. There are backup scripts in `scripts/` — prefer using `npm run db:backup` first.
- Avoid creating symlinks in production library mounts during experimentation. Use `TESTING` env vars.
- When calling external APIs (TMDB), respect the rate limiting logic in `utils/tmdb.js` (Bottleneck). Prefer using `searchTmdb` and `getTmdbDetails` helpers.

UI & migration plan (developer priority)
- The current EJS-based UI is hard to maintain and the project's immediate roadmap should prioritize a full frontend port to Next.js.
- Recommended stack for the rewrite: Next.js (app router or pages as you prefer), Tailwind CSS for styling, shadcn UI components (which are Tailwind + Radix primitives), and Radix UI for low-level accessible primitives.
- Keep the backend shape (Express + Prisma API surface) but design the Next.js app to talk to the same Express endpoints or migrate endpoints into API routes while preserving Prisma data models.
- Database migration policy: keep current `dev.db` (and production DB) as-is; create and maintain a separate sqlite database file named `dev2.db` for the new UI/feature work to avoid data loss while iterating. Ensure Prisma schema compatibility and use `npm run db:generate` after any schema change. Plan a careful migration/merge when ready to consolidate data.

Notes: attachments and context
- The above guidance is based on repository files (index, routes, controllers, utils, prisma). You don't need to re-scan attachments referenced earlier unless asked for a deeper change; the key architecture facts are now captured here.

Quick examples for edits
- To add a new admin endpoint that needs DB access, add a route in `routes/directoryRoutes.js` and place handler logic in `controllers/directoryController.js` so it can use the injected `prisma` instance.
- To add a new parsing rule, update `utils/parser.js`. Ensure controllers re-run `parseTitle` and persist via `prisma.directory.update` as other endpoints do (see `parseSingleDirectory` / `parseAllDirectories`).

References (files to inspect while editing)
- `index.js`, `routes/directoryRoutes.js`, `controllers/directoryController.js`, `utils/library.js`, `utils/parser.js`, `utils/tmdb.js`, `prisma/schema.prisma`, `prisma/migrations/`, `package.json`, `scripts/db-backup.sh`, `prisma/seed.js`, `views/*.ejs`.

If anything is unclear or you want examples added (e.g., how to write a unit test or a safe integration test that uses TESTING env vars), tell me which area and I'll iterate.
