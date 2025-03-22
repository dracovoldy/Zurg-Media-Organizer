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
                 /* Search form styling */
                 .search-form { margin-bottom: 20px; }
                 .search-form input, .search-form select {
                     margin-right: 10px;
                     padding: 5px;
                 }
                 .search-form button {
                     padding: 5px 10px;
                 }
                 /* Pagination Floating Pill Styling */
                .pagination-container {
                position: fixed;
                bottom: 0;
                right: 20px;
                background: rgba(50, 50, 50, 0.8);
                border-radius: 50px;
                padding: 5px 10px;
                transform: translateY(90%);
                transition: transform 0.3s ease;
                z-index: 1000;
                display: flex;
                align-items: center;
                justify-content: center;
                }
                .pagination-container:hover {
                transform: translateY(0);
                }
                .pagination-container a.page-link {
                margin: 0 5px;
                padding: 8px 12px;
                text-decoration: none;
                background-color: #f0f0f0;
                color: #333;
                border-radius: 4px;
                transition: background-color 0.3s;
                }
                .pagination-container a.page-link:hover {
                background-color: #ccc;
                }
                .pagination-container a.page-link.active {
                font-weight: bold;
                background-color: #333;
                color: #fff;
                }
                
                 /* File list collapse styling */
                 .files { margin-top: 10px; }
                 .toggle-btn {
                   margin-top: 10px;
                   padding: 5px 10px;
                   background-color: #007BFF;
                   color: #fff;
                   border: none;
                   border-radius: 4px;
                   cursor: pointer;
                 }
               </style>
             </head>
             <body>
               <h1>Synced Directories</h1>
               <!-- Search Form -->
               <form class="search-form" method="GET" action="/">
                   <input type="text" name="name" placeholder="Directory Name" value="${req.query.name || ''}" />
                   <input type="text" name="parsedName" placeholder="Parsed Name" value="${req.query.parsedName || ''}" />
                   <input type="number" name="year" placeholder="Year" value="${req.query.year || ''}" />
                   <input type="text" name="specialName" placeholder="Special Name" value="${req.query.specialName || ''}" />
                   <input type="text" name="tmdbId" placeholder="TMDB ID" value="${req.query.tmdbId || ''}" />
                   <select name="sortBy">
                     <option value="">Sort By</option>
                     ${validSortFields.map(field => `<option value="${field}" ${req.query.sortBy === field ? 'selected' : ''}>${field}</option>`).join('')}
                   </select>
                   <select name="sortOrder">
                     <option value="desc" ${req.query.sortOrder === 'desc' ? 'selected' : ''}>Descending</option>
                     <option value="asc" ${req.query.sortOrder === 'asc' ? 'selected' : ''}>Ascending</option>
                   </select>
                   <button type="submit">Search</button>
               </form>

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

                       <!-- Toggle Files Button -->
                       <button class="toggle-btn" data-target="files-${dir.id}">Show Files</button>
                       <div id="files-${dir.id}" class="files" style="display:none;">
                           <strong>Files:</strong>
                           <ul>
                               ${dir.files.map(file => `<li class="filename">${file.name} – ${file.size} bytes</li>`).join('')}
                           </ul>
                       </div>
                   </div>
               `).join('')}

               <!-- Pagination Controls -->
               <div class="pagination-container">
                    ${page > 1 ? `<a class="page-link" href="/?page=${page - 1}">Previous</a>` : ''}
                    ${Array.from({ length: totalPages }, (_, i) => {
            const p = i + 1;
            return `<a class="page-link ${p === page ? 'active' : ''}" href="/?page=${p}">${p}</a>`;
        }).join('')}
                    ${page < totalPages ? `<a class="page-link" href="/?page=${page + 1}">Next</a>` : ''}
                </div>

               <!-- JS for toggling file visibility -->
               <script>
                 document.addEventListener("DOMContentLoaded", function(){
                   document.querySelectorAll('.toggle-btn').forEach(button => {
                     button.addEventListener('click', function(){
                       var targetId = this.getAttribute("data-target");
                       var fileContainer = document.getElementById(targetId);
                       if (fileContainer.style.display === "none") {
                         fileContainer.style.display = "block";
                         this.textContent = "Hide Files";
                       } else {
                         fileContainer.style.display = "none";
                         this.textContent = "Show Files";
                       }
                     });
                   });
                 });
               </script>
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

// ---------------------------------------------------------------------------
// Graceful Shutdown: Disconnect Prisma when terminating the application.
// ---------------------------------------------------------------------------
process.on('SIGINT', async () => {
    console.log("Shutting down gracefully...");
    await prisma.$disconnect();
    process.exit();
});