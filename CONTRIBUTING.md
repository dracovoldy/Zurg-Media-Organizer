Contributing & Local DB helpers

This project uses Prisma with a SQLite file at `prisma/dev.db` for local development. The repository includes helper scripts to safely backup, reset, and seed the local database.

Helpful npm scripts

- `npm run db:backup` — create timestamped backups of `prisma/dev.db` and `prisma/test.db`.
- `npm run db:generate` — generate the Prisma client.
- `npm run db:reset` — run `prisma migrate reset --force --skip-seed` to wipe and reapply migrations (no seed).
- `npm run db:reset:seed` — run `prisma migrate reset --force` and then run the seed script.
- `npm run seed` — run `node prisma/seed.js` (seed script is tolerant to errors).

Shell helper

- `scripts/db-reset.sh [--seed]` — wrapper that performs backups, runs `prisma generate`, and resets the DB. Use `--seed` to run the seed script after reset.

Notes & cautions

- These commands are intended for **local development** only. Do NOT run `migrate reset` against production databases — use proper DB backups and safer migration workflows for production (dump/restore for Postgres, etc.).
- The seed file inserts a single minimal Directory and a File to make local testing easier. Edit `prisma/seed.js` as needed.
