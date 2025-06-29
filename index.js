'use strict';

require('@dotenvx/dotenvx').config();

const express = require('express');
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
app.use(express.static(path.join(__dirname, 'public')));

async function syncDirectory(dirPath) {
    // Prevent syncing if the directory already exists in the DB.
    const existingDir = await prisma.directory.findUnique({
        where: { path: dirPath }
    });
    if (existingDir) {
        console.log(`Directory ${dirPath} already exists in DB; skipping sync.`);
        return;
    }

    const dirName = path.basename(dirPath);
    const filesData = [];

    try {
        // Read contents, expecting files within the directory.
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                const filePath = path.join(dirPath, entry.name);
                const stats = await fs.stat(filePath);
                filesData.push({
                    name: entry.name,
                    path: filePath,
                    size: stats.size
                });
            }
        }
    } catch (error) {
        console.error(`Error reading contents of ${dirPath}:`, error);
        throw error;
    }

    // Insert the directory and its files into the database.
    await prisma.directory.create({
        data: {
            name: dirName,
            path: dirPath,
            files: {
                create: filesData
            }
        }
    });
    console.log(`Synchronized directory ${dirPath} with ${filesData.length} file(s).`);
}

const watcher = chokidar.watch(watchedDirectory, {
    // usePolling: true,
    persistent: true,
    followSymlinks: true,
    waitWriteFinish: true, // emit single event when chunked writes are completed
    atomic: true, // emit proper events when "atomic writes" (mv _tmp file) are used
    depth: 1,            // Only immediate children directories.
    ignoreInitial: false // Ignore existing directories on start.
});

watcher.on('addDir', async (dirPath) => {
    // Ignore the root watched directory itself.
    if (dirPath === watchedDirectory) return;

    console.log(`New directory detected: ${dirPath}`);
    try {
        await syncDirectory(dirPath);
    } catch (error) {
        console.error(`Failed to sync directory ${dirPath}:`, error);
    }
});

// Configure Express to use EJS as the view engine and set the views directory.
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Use directory routes for main and related endpoints
const createDirectoryRoutes = require('./routes/directoryRoutes');
const directoryRoutes = createDirectoryRoutes(prisma);
app.use('/', directoryRoutes);


// Start the Express server on port.
const PORT = process.env.PORT || 4004;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}. Visit http://localhost:${PORT}/`);
});

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