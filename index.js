'use strict';

require('@dotenvx/dotenvx').config();

const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const chokidar = require('chokidar');
const fs = require('fs').promises;
const path = require('path');

// My modules
const { parseTitle } = require('./utils/parser');
const { processMovieDirectory } = require('./utils/library');
const { searchTmdb, getTmdbDetails } = require('./utils/tmdb');

// Directory to watch on the Linux system.
const watchedDirectory = process.env.ZURG_ALL_PATH ? process.env.ZURG_ALL_PATH : '/mnt/zurg/__all__/';

// Initialize Express and Prisma.
const app = express();

// Helper to determine if running in test mode (support both TESTING and TESTING_MODE)
const isTestEnv = process.env.TESTING === true || process.env.TESTING_MODE === true;
console.log('isTesting: ', isTestEnv);


const testDbPath = path.join(__dirname, 'prisma', 'test.db');

// Force DATABASE_URL to test.db if in test mode
if (isTestEnv) {
  process.env.DATABASE_URL = `file:${testDbPath}`;
}

// Use DATABASE_URL for Prisma
const prisma = new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Allow cross-origin requests from the Next.js dev server (adjust origin as needed)
app.use(cors({ origin: process.env.UI_ORIGIN || 'http://localhost:3000' }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizeDirPath(p) {
  if (!p) return p;
  // Remove trailing slashes to keep a canonical unique key value
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

async function syncDirectory(dirPath) {
    const normalizedPath = normalizeDirPath(dirPath);
    const dirName = path.basename(normalizedPath);
    const filesData = [];

    try {
        // Read contents, expecting files within the directory.
        const entries = await fs.readdir(normalizedPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                const filePath = path.join(normalizedPath, entry.name);
                const stats = await fs.stat(filePath);
                filesData.push({
                    name: entry.name,
                    path: filePath,
                    size: stats.size
                });
            }
        }
    } catch (error) {
        console.error(`Error reading contents of ${normalizedPath}:`, error);
        throw error;
    }

    // Idempotent write:
    // - Clean up any orphan File rows that would conflict on unique path
    // - Upsert Directory by unique path
    // - In update branch, replace files via deleteMany + create
    //
    // NOTE: On SQLite (used in local/small deployments) very large deleteMany
    // in a single transaction can hit a timeout (Prisma P1008) when the DB is
    // busy or the underlying filesystem is slow (e.g. rclone mounts). To make
    // this more robust we perform deletes in small batches with retries.
    const paths = filesData.map(f => f.path);

    // Helper: chunk an array
    function chunkArray(arr, size) {
      const chunks = [];
      for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
      return chunks;
    }

    // Helper: small delay
    function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    if (paths.length > 0) {
      const chunks = chunkArray(paths, 200); // batch size (tunable)
      for (const [idx, chunk] of chunks.entries()) {
        let attempts = 0;
        while (attempts < 3) {
          try {
            await prisma.file.deleteMany({ where: { path: { in: chunk } } });
            break;
          } catch (e) {
            attempts += 1;
            console.error(`deleteMany chunk ${idx + 1}/${chunks.length} failed (attempt ${attempts}):`, e && e.message);
            // On timeout or busy DB, wait and retry
            await wait(500 * attempts);
            if (attempts >= 3) throw e;
          }
        }
        // Short pause between chunks to relieve DB contention
        await wait(50);
      }
    }

    // Finally perform the upsert which replaces the directory files in a safe way
    await prisma.directory.upsert({
      where: { path: normalizedPath },
      update: {
        name: dirName,
        files: {
          deleteMany: {},
          create: filesData
        }
      },
      create: {
        name: dirName,
        path: normalizedPath,
        files: { create: filesData }
      }
    });

    console.log(`Synchronized directory ${normalizedPath} with ${filesData.length} file(s).`);
}

// We'll create the watcher after ensuring the DB is prepared (WAL, busy_timeout)
// in the async `init()` function further below.

// Configure Express to use EJS as the view engine and set the views directory.
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Use directory routes for main and related endpoints
const createDirectoryRoutes = require('./routes/directoryRoutes');
const directoryRoutes = createDirectoryRoutes(prisma);
app.use('/', directoryRoutes);

// Start-up sequence: prepare DB (enable WAL, set busy timeout), then start watcher and server
async function prepareDatabase() {
  try {
    // Enable WAL journal mode
    const res = await prisma.$executeRawUnsafe("PRAGMA journal_mode = WAL;");
    console.log('PRAGMA journal_mode result:', res);
  } catch (e) {
    console.error('Failed to set PRAGMA journal_mode=WAL:', e && e.message);
  }
  try {
    // Reduce lock contention by allowing a busy timeout (ms)
    await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000;');
    // Use NORMAL synchronous mode to balance durability and performance on local dev
    await prisma.$executeRawUnsafe("PRAGMA synchronous = NORMAL;");
  } catch (e) {
    console.error('Failed to set PRAGMA busy_timeout/synchronous:', e && e.message);
  }
}

async function init() {
  await prepareDatabase();

  // Create watcher after DB prepared
  const watcher = chokidar.watch(watchedDirectory, {
    usePolling: true,
    interval: 10000,
    binaryInterval: 3000,
    persistent: true,
    followSymlinks: true,
    waitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    },
    atomic: true,
    depth: 1,
    ignoreInitial: false
  });

  watcher.on('addDir', async (dirPath) => {
    if (normalizeDirPath(dirPath) === normalizeDirPath(watchedDirectory)) return;
    const normalized = normalizeDirPath(dirPath);
    console.log(`New directory detected: ${normalized}`);
    try {
      await syncDirectory(normalized);
    } catch (error) {
      console.error(`Failed to sync directory ${normalized}:`, error);
    }
  });

  // Start the Express server on port.
  const PORT = process.env.PORT || 4004;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}. Visit http://localhost:${PORT}/`);
  });
}

// Kick off init but don't crash the process for PRAGMA failures
init().catch(e => console.error('Startup init failed:', e && e.message));

// Graceful Shutdown: Disconnect Prisma when terminating the application.
process.on('SIGINT', async () => {
    console.log("Shutting down gracefully...");
    await prisma.$disconnect();
    process.exit();
});

// Helper to get symlink target path based on env
function getSymlinkTargetPath(originalPath) {
  if (isTestEnv && process.env.TESTING_LIBRARY_BASE_PATH) {
    return path.join(process.env.TESTING_LIBRARY_BASE_PATH, path.basename(originalPath));
  }
  if (process.env.LIBRARY_BASE_PATH) {
    return path.join(process.env.LIBRARY_BASE_PATH, path.basename(originalPath));
  }
  return originalPath;
}

// In processMovieDirectory and any symlink creation logic, use getSymlinkTargetPath to determine the target path.