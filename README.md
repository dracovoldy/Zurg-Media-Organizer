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
