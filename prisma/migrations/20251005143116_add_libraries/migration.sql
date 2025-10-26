-- CreateTable
CREATE TABLE "Library" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Directory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "libraryId" TEXT,
    "parsedName" TEXT,
    "parsedYear" INTEGER,
    "parsedType" TEXT,
    "specialName" TEXT,
    "tmdbId" INTEGER,
    "tmdbStatus" TEXT,
    "libraryAdded" BOOLEAN NOT NULL DEFAULT false,
    "libraryPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" TEXT,
    CONSTRAINT "Directory_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Directory" ("createdAt", "id", "libraryAdded", "libraryPath", "metadata", "name", "parsedName", "parsedType", "parsedYear", "path", "specialName", "tmdbId", "tmdbStatus") SELECT "createdAt", "id", "libraryAdded", "libraryPath", "metadata", "name", "parsedName", "parsedType", "parsedYear", "path", "specialName", "tmdbId", "tmdbStatus" FROM "Directory";
DROP TABLE "Directory";
ALTER TABLE "new_Directory" RENAME TO "Directory";
CREATE UNIQUE INDEX "Directory_path_key" ON "Directory"("path");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Library_rootPath_key" ON "Library"("rootPath");
