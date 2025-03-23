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

// Directory to watch on the Linux system.
const watchedDirectory = process.env.ZURG_ALL_PATH || '/mnt/zurg/__all__/';

// TMDB API configuration Constants – ensure your .env file contains TMDB_BEARER_TOKEN
const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const TMDB_MOVIE_SEARCH_URL = 'https://api.themoviedb.org/3/search/movie';
const TMDB_TV_SEARCH_URL = 'https://api.themoviedb.org/3/search/tv';

// Initialize Express and Prisma.
const app = express();
const prisma = new PrismaClient();

async function searchTmdb(query, mediaType, year) {
    const languages = ['hi-IN', 'en-US'];
    for (const lang of languages) {
        let baseUrl = mediaType === 'shows' ? TMDB_TV_SEARCH_URL : TMDB_MOVIE_SEARCH_URL;
        const urlObj = new URL(baseUrl);
        urlObj.searchParams.append('query', query);
        urlObj.searchParams.append('language', lang);
        urlObj.searchParams.append('include_adult', 'false');
        if (year) {
            if (mediaType === 'shows') {
                urlObj.searchParams.append('first_air_date_year', year.toString());
            } else {
                urlObj.searchParams.append('year', year.toString());
            }
        }
        try {
            const response = await fetch(urlObj.href, {
                headers: {
                    'Authorization': `Bearer ${TMDB_BEARER_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            if (response.status === 502) {
                throw new Error("API_DOWN");
            }
            if (!response.ok) {
                throw new Error("HTTP_ERROR_" + response.status);
            }
            const data = await response.json();
            if (data.results && data.results.length > 0) {
                let results = data.results;
                if (year) {
                    // For movies, check 'release_date'; For TV shows, check 'first_air_date'
                    results = results.filter(item => {
                        const dateField = mediaType === 'shows' ? item.first_air_date : item.release_date;
                        return dateField && dateField.startsWith(year.toString());
                    });
                }
                if (results.length > 0) {
                    return results[0].id;
                } else if (data.results.length > 0) {
                    // Fallback: return the first result from the unfiltered list
                    return data.results[0].id;
                }
            }
        } catch (error) {
            // Propagate error to allow the caller to update status accordingly.
            throw error;
        }
    }
    return null;
}

async function getTmdbDetails(tmdbId, mediaType) {
    let baseUrl;
    if (mediaType === 'shows') {
        baseUrl = `https://api.themoviedb.org/3/tv/${tmdbId}`;
    } else {
        baseUrl = `https://api.themoviedb.org/3/movie/${tmdbId}`;
    }
    try {
        const response = await fetch(baseUrl, {
            headers: {
                'Authorization': `Bearer ${TMDB_BEARER_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        if (!response.ok) {
            console.error(`Failed to fetch TMDB details for id ${tmdbId} with status ${response.status}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error(`Error fetching TMDB details for id ${tmdbId}:`, error);
        return null;
    }
}

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

        res.json(updatedDirectories);
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

        // Set up a rate limiter to allow max 50 requests per second.
        const limiter = new Bottleneck({
            maxConcurrent: 50,
            minTime: 20
        });

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
                    const foundTmdbId = await limiter.schedule(() => searchTmdb(queryName, dir.parsedType, dir.parsedYear));
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