'use strict';

require('@dotenvx/dotenvx').config();

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const chokidar = require('chokidar');
const fs = require('fs').promises;
const path = require('path');
const Bottleneck = require('bottleneck');

// My modules
const { parseTitle } = require('./utils/parser');
const { processMovieDirectory } = require('./utils/library');
const { searchTmdb, getTmdbDetails } = require('./utils/tmdb');

// Directory to watch on the Linux system.
const watchedDirectory = process.env.ZURG_ALL_PATH ? process.env.ZURG_ALL_PATH : '/mnt/zurg/__all__/';

// TMDB API configuration Constants – ensure your .env file contains TMDB_BEARER_TOKEN
const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const TMDB_MOVIE_SEARCH_URL = 'https://api.themoviedb.org/3/search/movie';
const TMDB_TV_SEARCH_URL = 'https://api.themoviedb.org/3/search/tv';

// Initialize Express and Prisma.
const app = express();
const prisma = new PrismaClient();

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
    persistent: true,
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

// Routes
app.get('/', async (req, res) => {
    try {
        // --- Pagination logic ---
        let page = parseInt(req.query.page, 10) || 1;
        if (page < 1) page = 1;
        const limit = 50;
        const skip = (page - 1) * limit;

        // --- Build filtering conditions from query parameters ---
        const filters = {};
        if (req.query.name && req.query.name.trim() !== "") {
            filters.name = { contains: req.query.name };
        }
        if (req.query.parsedName && req.query.parsedName.trim() !== "") {
            filters.parsedName = { contains: req.query.parsedName };
        }
        if (req.query.year && !isNaN(Number(req.query.year))) {
            filters.parsedYear = Number(req.query.year);
        }
        if (req.query.specialName && req.query.specialName.trim() !== "") {
            filters.specialName = { contains: req.query.specialName };
        }
        // --- New: Add Type Filter ---
        if (req.query.type && req.query.type.trim() !== "") {
            if (req.query.type === 'shows') {
                filters.parsedType = "shows";
            } else if (req.query.type === 'collection') {
                filters.parsedType = "collection";
            } else if (req.query.type === 'movies') {
                filters.parsedType = "movies";
            } else if (req.query.type === 'unknown') {
                filters.parsedType = null;
            }
        }
        if (req.query.tmdbId && !isNaN(Number(req.query.tmdbId))) {
            filters.tmdbId = Number(req.query.tmdbId);
        }

        // New: Filter by library status (added or not added)
        if (req.query.libraryStatus && req.query.libraryStatus.trim() !== "") {
            if (req.query.libraryStatus === 'added') {
                filters.libraryAdded = true;
            } else if (req.query.libraryStatus === 'notAdded') {
                filters.libraryAdded = false;
            }
        }

        // --- Build sorting options ---
        const validSortFields = ['name', 'parsedName', 'parsedYear', 'specialName', 'tmdbId', 'createdAt'];
        let orderBy = {};
        if (req.query.sortBy && validSortFields.includes(req.query.sortBy)) {
            orderBy[req.query.sortBy] = req.query.sortOrder && req.query.sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc';
        } else {
            orderBy.createdAt = 'desc';
        }

        // Fetch only the needed page with filters and sorting
        const directories = await prisma.directory.findMany({
            where: filters,
            include: { files: true },
            orderBy,
            skip,
            take: limit
        });
        const total = await prisma.directory.count({ where: filters });
        const totalPages = Math.ceil(total / limit);

        // Enrich directories with TMDB details if available
        const enrichedDirectories = await Promise.all(directories.map(async (dir) => {
            if (dir.tmdbStatus === "MATCH_FOUND" && dir.tmdbId) {
                const mediaType = (dir.parsedType && dir.parsedType.toLowerCase() === 'shows') ? 'shows' : 'movie';
                const tmdbInfo = await getTmdbDetails(dir.tmdbId, mediaType);
                return { ...dir, tmdbInfo };
            }
            return { ...dir, tmdbInfo: null };
        }));

        res.render("index", {
            enrichedDirectories,
            page,
            totalPages,
            query: req.query,
            validSortFields
        });

    } catch (error) {
        console.error("Error fetching directories from DB:", error);
        res.status(500).send("An error occurred while retrieving data.");
    }
});

app.get('/parse', async (req, res) => {
    try {
        const directories = await prisma.directory.findMany({
            where: { parsedName: null },
            orderBy: { createdAt: 'desc' }
        });

        // Update each directory entry with parsed properties.
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

      // Use a replacer function to serialize BigInt values as strings
      const replacer = (key, value) => typeof value === "bigint" ? value.toString() : value;
      res.setHeader("Content-Type", "application/json");
      res.send(JSON.stringify(updatedDirectories, replacer));
      
    } catch (error) {
        console.error("Error updating directories:", error);
        res.status(500).send("An error occurred while parsing directories.");
    }
});

app.get('/update-tmdb', async (req, res) => {
    try {
        // Choose whether to scan all directories or only those missing a tmdbId.
        const mode = req.query.mode;
        let directories;
        if (mode === 'full') {
            directories = await prisma.directory.findMany();
        } else {
            directories = await prisma.directory.findMany({
                where: { tmdbId: null }
            });
        }

        // Process directories concurrently using Promise.all.
        const updatePromises = directories.map(async (dir) => {
            let updateData = {};

            // Choose queryName: if specialName is provided and not empty use it; otherwise use parsedName.
            if ((!dir.parsedName) && (!dir.specialName)) {
                updateData.tmdbStatus = "SKIPPED_NO_PARSED_NAME";
            } else {
                const queryName = (dir.specialName && dir.specialName.trim() !== "")
                    ? dir.specialName
                    : dir.parsedName;

                try {
                    const foundTmdbId = await searchTmdb(queryName, dir.parsedType, dir.parsedYear);

                    if (foundTmdbId !== null) {
                        updateData.tmdbId = foundTmdbId;
                        updateData.tmdbStatus = "MATCH_FOUND";
                    } else {
                        updateData.tmdbStatus = "NO_MATCH_FOUND";
                    }

                } catch (error) {

                    console.log('TMDB matcher error: ', error);
                    if (error.message === "API_DOWN") {
                        updateData.tmdbStatus = "API_DOWN";
                    } else if (error.message && error.message.startsWith("HTTP_ERROR_")) {
                        updateData.tmdbStatus = error.message;
                    } else {
                        updateData.tmdbStatus = "NETWORK_ERROR";
                    }

                }
            }

            return prisma.directory.update({
                where: { id: dir.id },
                data: updateData,
                include: { files: true }
            });
        });

        const results = await Promise.all(updatePromises);
        // Serialize BigInt values (if any) to strings.
        const replacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(results, replacer));

    } catch (error) {
        console.error("Error during TMDB update:", error);
        res.status(500).send("An error occurred while updating TMDB info.");
    }
});

app.post('/add-to-library/:id', async (req, res) => {
    try {
        const override = req.query.override === 'true';
        const directory = await prisma.directory.findUnique({
            where: { id: req.params.id },
            include: { files: true }
        });
        if (!directory) return res.status(404).json({ error: 'Directory not found' });

        // Skip if already added unless override is true
        if (directory.libraryAdded && !override) {
            return res.status(200).json({ message: 'Directory already added', libraryPath: directory.libraryPath });
        }

        // Process based on parsedType; currently only "movies" is implemented.
        if (directory.parsedType === 'movies') {
            // Ensure TMDB details are available (tmdbStatus MATCH_FOUND and tmdbId exists)
            if (!(directory.tmdbStatus === 'MATCH_FOUND' && directory.tmdbId)) {
                return res.status(400).json({ error: 'TMDB details missing for movies' });
            }
            // Fetch TMDB details if not already enriched.
            const mediaType = 'movie';
            const tmdbInfo = await getTmdbDetails(directory.tmdbId, mediaType);
            if (!tmdbInfo) return res.status(400).json({ error: 'Could not fetch TMDB details' });

            // Process the movie directory and create symlinks.
            const targetLibPath = await processMovieDirectory(directory, tmdbInfo);

            // Update DB record with library info.
            const updatedDir = await prisma.directory.update({
                where: { id: directory.id },
                data: { libraryAdded: true, libraryPath: targetLibPath },
                include: { files: true }
            });
            return res.status(200).json({ message: 'Added to library', directory: updatedDir });
        } else if (directory.parsedType === 'shows') {
            // Placeholder for shows: To be implemented.
            return res.status(501).json({ error: 'Adding shows to library not implemented yet' });
        } else if (directory.parsedType === 'collection') {
            // Placeholder for collections: To be implemented.
            return res.status(501).json({ error: 'Adding collections to library not implemented yet' });
        } else {
            return res.status(400).json({ error: 'Unsupported directory type' });
        }
    } catch (error) {
        console.error('Error in Add-to-Library (single):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Mass add "Add to Media Library" endpoint
app.post('/add-to-library', async (req, res) => {
    try {
        const override = req.query.override === 'true';
        // Find directories with TMDB details that haven't been added or if override is set.
        const directories = await prisma.directory.findMany({
            where: {
                AND: [
                    { tmdbStatus: 'MATCH_FOUND' },
                    { tmdbId: { not: null } },
                    { OR: [{ libraryAdded: false }, override ? {} : {}] } // override flag; use proper filtering as needed
                ]
            },
            include: { files: true }
        });

        const results = await Promise.all(directories.map(async (dir) => {
            if (dir.parsedType === 'movies') {
                const tmdbInfo = await getTmdbDetails(dir.tmdbId, 'movie');
                if (!tmdbInfo) {
                    return { id: dir.id, error: 'TMDB details missing' };
                }
                try {
                    const targetLibPath = await processMovieDirectory(dir, tmdbInfo);
                    const updated = await prisma.directory.update({
                        where: { id: dir.id },
                        data: { libraryAdded: true, libraryPath: targetLibPath },
                        include: { files: true }
                    });
                    return { id: dir.id, status: 'added', libraryPath: targetLibPath };
                } catch (error) {
                    return { id: dir.id, error: error.message };
                }
            } else if (dir.parsedType === 'shows' || dir.parsedType === 'collection') {
                // Placeholders for unimplemented types
                return { id: dir.id, error: `Adding type '${dir.parsedType}' not implemented` };
            } else {
                return { id: dir.id, error: 'Unsupported type' };
            }
        }));

        res.status(200).json({ results });
    } catch (error) {
        console.error('Error in mass Add-to-Library:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

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