-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Directory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "parsedName" TEXT,
    "parsedYear" INTEGER,
    "parsedType" TEXT,
    "specialName" TEXT,
    "tmdbId" INTEGER,
    "tmdbStatus" TEXT,
    "libraryAdded" BOOLEAN NOT NULL DEFAULT false,
    "libraryPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Directory" ("createdAt", "id", "name", "parsedName", "parsedType", "parsedYear", "path", "specialName", "tmdbId", "tmdbStatus") SELECT "createdAt", "id", "name", "parsedName", "parsedType", "parsedYear", "path", "specialName", "tmdbId", "tmdbStatus" FROM "Directory";
DROP TABLE "Directory";
ALTER TABLE "new_Directory" RENAME TO "Directory";
CREATE UNIQUE INDEX "Directory_path_key" ON "Directory"("path");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
