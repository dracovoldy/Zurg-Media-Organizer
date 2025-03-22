'use strict';

require('@dotenvx/dotenvx').config();

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const chokidar = require('chokidar');
const fs = require('fs').promises;
const path = require('path');
// Added dependency for HTTP calls to TMDB API
// const fetch = require('node-fetch');

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

// ---------------------------------------------------------------------------
// Function: searchTmdb
// Description: Searches the TMDB API using the provided query (parsedName)
//              prioritizing Indian language (hi-IN) followed by English (en-US).
//              Uses TMDB_MOVIE_SEARCH_URL or TMDB_TV_SEARCH_URL based on mediaType.
//              If parsedYear is provided, it will add a year filter to the search.
// Returns: TMDB id if a match is found; otherwise returns null.
// Throws: Errors for network issues or non-200 HTTP responses (e.g., API_DOWN).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Function: getTmdbDetails
// Description: Given a TMDB id and media type, fetches detailed info (including poster)
//              from the TMDB API.
// Returns: TMDB details object or null if request fails.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Function: syncDirectory
// Description: Reads new directory contents and adds both the directory and its
//              file entries to the SQLite database using Prisma.
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

// ---------------------------------------------------------------------------
// Express Route: Enhanced UI - Displays synced directories with TMDB info (poster and details)
// ---------------------------------------------------------------------------
app.get('/', async (req, res) => {
    try {
        const directories = await prisma.directory.findMany({
            include: { files: true },
            orderBy: { createdAt: 'desc' }
        });

        // Enrich each directory with TMDB details if a match was found.
        const enrichedDirectories = await Promise.all(directories.map(async (dir) => {
            if (dir.tmdbStatus === "MATCH_FOUND" && dir.tmdbId) {
                const mediaType = (dir.parsedType && dir.parsedType.toLowerCase() === 'shows') ? 'shows' : 'movie';
                const tmdbInfo = await getTmdbDetails(dir.tmdbId, mediaType);
                return { ...dir, tmdbInfo };
            }
            return { ...dir, tmdbInfo: null };
        }));

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
           .tmdb { margin-top: 10px; display: flex; }
           .tmdb img { max-width: 150px; }
           .tmdb-details { margin-left: 20px; }
           .tmdb-status { color: red; margin-top: 10px; }
         </style>
       </head>
       <body>
         <h1>Synced Directories</h1>
         ${enrichedDirectories.map(dir => `
             <div class="directory">
                 <h2>${dir.name}</h2>
                 <div><strong>Path:</strong> ${dir.path}</div>
                 <div><strong>Parsed Name:</strong> ${dir.parsedName || 'N/A'}</div>
                 <div><strong>Parsed Year:</strong> ${dir.parsedYear ? dir.parsedYear : 'N/A'}</div>
                 <div><strong>Parsed Type:</strong> ${dir.parsedType || 'N/A'}</div>
                 <div><strong>Special Name:</strong> ${dir.specialName || 'N/A'}</div>
                 ${dir.tmdbInfo ? `
                     <div class="tmdb">
                         <img src="https://image.tmdb.org/t/p/w200/${dir.tmdbInfo.poster_path}" alt="Poster">
                         <div class="tmdb-details">
                             <div><strong>TMDB Title:</strong> ${dir.tmdbInfo.title || dir.tmdbInfo.name}</div>
                             <div><strong>Release Date:</strong> ${dir.tmdbInfo.release_date || dir.tmdbInfo.first_air_date}</div>
                             <div><strong>Overview:</strong> ${dir.tmdbInfo.overview || 'N/A'}</div>
                         </div>
                     </div>
                 ` : `
                     <div class="tmdb-status"><strong>TMDB Status:</strong> ${dir.tmdbStatus || 'N/A'}</div>
                 `}
                 <div>
                     <strong>Files:</strong>
                     <ul>
                         ${dir.files.map(file => `<li class="filename">${file.name} – ${file.size} bytes</li>`).join('')}
                     </ul>
                 </div>
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

// ---------------------------------------------------------------------------
// Express Route: Update TMDB Info for each directory using parsedName
// Description: For every directory in the DB, if a parsedName exists, the endpoint
//              queries TMDB (first with Indian language then English) and updates the
//              directory record with tmdbId and a corresponding tmdbStatus.  
// Possible tmdbStatus values:
// - MATCH_FOUND
// - NO_MATCH_FOUND
// - SKIPPED_NO_PARSED_NAME
// - API_DOWN         (if the TMDB API returned a 502)
// - HTTP_ERROR_xxx   (for non-200 HTTP responses)
// - NETWORK_ERROR    (for network issues)
// ---------------------------------------------------------------------------
app.get('/update-tmdb', async (req, res) => {
    try {
        const directories = await prisma.directory.findMany();
        const results = [];

        // Process directories sequentially. (You could add concurrency control if needed.)
        for (const dir of directories) {
            let updateData = {};

            if (!dir.parsedName) {
                updateData.tmdbStatus = "SKIPPED_NO_PARSED_NAME";
            } else {
                try {
                    const foundTmdbId = await searchTmdb(dir.parsedName, dir.parsedType, dir.parsedYear);
                    if (foundTmdbId !== null) {
                        updateData.tmdbId = foundTmdbId;
                        updateData.tmdbStatus = "MATCH_FOUND";
                    } else {
                        updateData.tmdbStatus = "NO_MATCH_FOUND";
                    }
                } catch (error) {

                    console.log('TMDB matcher error: ', error)
                    if (error.message === "API_DOWN") {
                        updateData.tmdbStatus = "API_DOWN";
                    } else if (error.message && error.message.startsWith("HTTP_ERROR_")) {
                        updateData.tmdbStatus = error.message;
                    } else {
                        updateData.tmdbStatus = "NETWORK_ERROR";
                    }
                }
            }

            const updatedDir = await prisma.directory.update({
                where: { id: dir.id },
                data: updateData,
                include: { files: true }
            });
            results.push(updatedDir);
        }
        // res.json(results);
        // Create a replacer function to serialize BigInt values to string
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

// ---------------------------------------------------------------------------
// Graceful Shutdown: Disconnect Prisma when terminating the application.
// ---------------------------------------------------------------------------
process.on('SIGINT', async () => {
    console.log("Shutting down gracefully...");
    await prisma.$disconnect();
    process.exit();
});