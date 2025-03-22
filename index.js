'use strict';

require('@dotenvx/dotenvx').config()

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const chokidar = require('chokidar');
const fs = require('fs').promises;
const path = require('path');

// My modules
const { parseTitle } = require('./utils/parser');

// Directory to watch on the Linux system.
const watchedDirectory = process.env.ZURG_ALL_PATH || '/mnt/zurg/__all__/';

// Initialize Express and Prisma.
const app = express();
const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Function: syncDirectory
// Description: Reads new directory contents and adds both the directory and its
// file entries to the SQLite database using Prisma.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Initialize Chokidar: Watch for newly added directories.
// ---------------------------------------------------------------------------
const watcher = chokidar.watch(watchedDirectory, {
    persistent: true,
    depth: 1,           // Only immediate children directories.
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

// ---------------------------------------------------------------------------
// Express Route: Simple UI to display synced directories and files
// ---------------------------------------------------------------------------
app.get('/', async (req, res) => {
    try {
        const directories = await prisma.directory.findMany({
            include: { files: true },
            orderBy: { createdAt: 'desc' }
        });

        let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Directory Sync Status</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          h1 { color: #333; }
          .directory { border: 1px solid #ccc; padding: 10px; border-radius: 4px; margin-bottom: 15px; }
          .filename { margin-left: 20px; }
        </style>
      </head>
      <body>
        <h1>Synced Directories</h1>
        ${directories.map(dir => `
            <div class="directory">
                <strong>${dir.name}</strong><br>
                <small>Path: ${dir.path}</small><br>
                <small>Parsed Name: ${dir.parsedName || 'N/A'}</small><br>
                <small>Parsed Year: ${dir.parsedYear ? dir.parsedYear : 'N/A'}</small><br>
                <small>Parsed Type: ${dir.parsedType || 'N/A'}</small><br>
                <small>Special Name: ${dir.specialName || 'N/A'}</small>
                <ul>
                ${dir.files.map(file => `<li class="filename">${file.name} – ${file.size} bytes</li>`).join('')}
                </ul>
            </div>
        `).join('')}
      </body>
      </html>
    `;
        res.send(html);
    } catch (error) {
        console.error("Error fetching directories from DB:", error);
        res.status(500).send("An error occurred while retrieving data.");
    }
});

// ---------------------------------------------------------------------------
// Express Route: DirectoryName to Original Title and Year parser
// ---------------------------------------------------------------------------
app.get('/parse', async (req, res) => {
    try {
        const directories = await prisma.directory.findMany({
            orderBy: { createdAt: 'desc' }
        });

        // Update each directory entry with parsed properties.
        // Convert parsed_year to an integer (if available) to ensure valid type.
        const updatedDirectories = await Promise.all(directories.map(async (dir) => {
            const { parsed_name, parsed_year, type, specialName } = parseTitle(dir.name);
            const parsedYearConverted = parsed_year && !isNaN(Number(parsed_year))
                ? Number(parsed_year)
                : null;

            return prisma.directory.update({
                where: { id: dir.id },
                data: {
                    parsedName: parsed_name,
                    parsedYear: parsedYearConverted,
                    parsedType: type,
                    specialName: specialName
                },
                include: { files: true }
            });
        }));

        res.json(updatedDirectories);
    } catch (error) {
        console.error("Error updating directories:", error);
        res.status(500).send("An error occurred while parsing directories.");
    }
});

// Start the Express server on port.
const PORT = process.env.PORT || 4004;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}. Visit http://localhost:${PORT}/`);
});

// ---------------------------------------------------------------------------
// Graceful Shutdown: Disconnect Prisma when terminating the application.
// ---------------------------------------------------------------------------
process.on('SIGINT', async () => {
    console.log("Shutting down gracefully...");
    await prisma.$disconnect();
    process.exit();
});