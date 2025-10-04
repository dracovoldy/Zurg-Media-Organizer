# Goal of this project

## Write an app with minimalistic UI to perform the following

### Syncing zurg directory to DB
- Watch linux directory '/mnt/zurg/all/'.
- Write event handler to handle new directory added within it.
- Auto sync the directory and its contents to the SQLite DB.
- Search tmdb and indentify the tmdb ID and other attributes
- Generate good code comments and make it easily extensible.

### Update media library that is made up of directories and symlinks to original zurg directory



# Docs

## How to setup Prisma?

1. Generate the Prisma client:

```
npx prisma generate
```
2. Apply initial migrations:

```
npx prisma migrate dev --name init
```
3. Apply new migrations for metadata support:

```
npx prisma migrate dev --name add-metadata-to-directory

## Resetting the database (wipe & start fresh)

If you need to delete all application data and recreate the database schema from migrations, follow these safe steps.

1) Create backups of the SQLite files (keeps a timestamped copy in `prisma/`):

```bash
timestamp=$(date +%Y%m%d%H%M%S)
cp prisma/dev.db prisma/dev.$timestamp.db.bak
cp prisma/test.db prisma/test.$timestamp.db.bak
ls -l prisma
```

2) Reset the database and reapply migrations (non-interactive):

```bash
npx prisma generate
npx prisma migrate reset --force --skip-seed
npx prisma migrate status
```

Notes:
- `migrate reset` will drop all data and reapply your migrations. Use `--skip-seed` if you don't want any seed step to run automatically.
- If you don't have a seed script, there's no data population step after the reset. You can write a small `prisma/seed.js` or a script in `package.json` to re-populate default data.
- For production or non-SQLite databases (Postgres/MySQL) prefer safer migration workflows and backups specific to the DB engine.

```

# Changelog

## Recent Changes

- **Formula 1 (F1) Support:**  
  Added detection and parsing for Formula 1 file naming patterns (e.g., `Formula.1.2025x10.Canada.Qualifying`).  
  - Type is set to `sports-f1` when such patterns are detected.
  - Season (year) and race number are extracted and stored in a new `metadata` JSON field.

- **Prisma Schema Update:**  
  - Added a `metadata` column of type `Json?` to the `Directory` model to store arbitrary metadata (e.g., F1 season/race info).

- **API & Controller Updates:**  
  - The `metadata` field is now persisted to the database and returned in API responses.
  - The UI (edit page) displays the metadata with a show/hide toggle for easy inspection.

- **README Update:**  
  - Added migration instructions for the new `metadata` field:
    ```
    npx prisma migrate dev --name add-metadata-to-directory
    ```
