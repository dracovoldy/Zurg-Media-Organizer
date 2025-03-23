// --- New file: utils/library.js ---
// Functions to calculate target library folder and process a movie directory.
'use strict';

const fs = require('fs').promises;
const path = require('path');

const LIBRARY_BASE_PATH = process.env.LIBRARY_BASE_PATH || '/mnt/library';
const allowedMediaExtensions = new Set([".mkv", ".mp4", ".avi", ".ts"]);
const indianLanguages = new Set(["hi", "ta", "te", "kn", "ml", "mr", "gu", "pa"]);

// Determine target folder based on type and TMDB language
function getTargetCategoryFolder(type, tmdbInfo) {
    if (!tmdbInfo || !tmdbInfo.original_language) {
        return type === 'movies' ? 'movies' : 'shows';
    }
    const lang = tmdbInfo.original_language;
    if (type === 'movies') {
        if (lang === 'bn') return 'bengali-movies';
        else if (indianLanguages.has(lang)) return 'desi-movies';
        else return 'movies';
    } else if (type === 'shows') {
        if (lang === 'bn') return 'bengali-shows';
        else if (indianLanguages.has(lang)) return 'desi-shows';
        else return 'shows';
    }
    return '';
}

// Ensure directory exists
async function createDirectoryIfNotExists(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}

// Get next available versioned file path for media file symlink
async function getNextVersionedFilePath(targetDir, baseName, ext) {
    let version = 1;
    while (true) {
        const newFileName = `${baseName} - [V${version}]${ext}`;
        const fullPath = path.join(targetDir, newFileName);
        try {
            await fs.access(fullPath);
            version++;
        } catch (error) {
            return fullPath;
        }
    }
}

// Create a symlink from src to dest
async function createSymlinkForFile(srcFilePath, destFilePath) {
    try {
        await fs.symlink(srcFilePath, destFilePath);
    } catch (error) {
        console.error(`Symlink error: ${srcFilePath} -> ${destFilePath}:`, error.message);
        throw error;
    }
}

/**
 * Process a movie directory:
 * - Creates a library folder named "<tmdb title> (<year>) [tmdbid-<tmdbid>]"
 * - Symlinks all files from the original directory into the new folder.
 *   * Media files are renamed with a version suffix.
 */
async function processMovieDirectory(directory, tmdbInfo) {
    if (!tmdbInfo) throw new Error("TMDB details missing");



    // HOTFIX: fix non unix compatible file names
    const mediaTitle = (tmdbInfo.title || tmdbInfo.name || directory.name).replace(/\//g, " ");
    const releaseDate = tmdbInfo.release_date || tmdbInfo.first_air_date || "";
    const releaseYear = releaseDate ? releaseDate.substring(0, 4) : "Unknown";
    const categoryFolder = getTargetCategoryFolder('movies', tmdbInfo);
    const newFolderName = `${mediaTitle} (${releaseYear}) [tmdbid-${directory.tmdbId}]`;
    const targetDir = path.join(LIBRARY_BASE_PATH, categoryFolder, newFolderName);

    await createDirectoryIfNotExists(targetDir);

    // Filter out media files among all files based on allowed extensions.
    const mediaFiles = directory.files.filter(file => allowedMediaExtensions.has(path.extname(file.name).toLowerCase()));
    let largestMediaFile = null;
    if (mediaFiles.length > 0) {
        largestMediaFile = mediaFiles.reduce((prev, curr) => (prev.size > curr.size ? prev : curr));
    }

    // Process each file in the directory.
    for (const file of directory.files) {
        const srcFilePath = file.path;
        const fileExt = path.extname(file.name).toLowerCase();
        let destFilePath;
        if (allowedMediaExtensions.has(fileExt)) {
            if (largestMediaFile && file.id === largestMediaFile.id) {
                // For the largest (main) media file, apply versioning.
                const baseName = `${mediaTitle} (${releaseYear})`;
                destFilePath = await getNextVersionedFilePath(targetDir, baseName, fileExt);
            } else {
                // For extra media files, append "-extra" and do NOT version.
                destFilePath = path.join(targetDir, `${mediaTitle} (${releaseYear}) [tmdbid-${directory.tmdbId}]-extra${fileExt}`);
            }
        } else {
            // For non-media files, just preserve the original file name.
            destFilePath = path.join(targetDir, file.name);
        }
        await createSymlinkForFile(srcFilePath, destFilePath);
    }
    return targetDir;
}

module.exports = {
    getTargetCategoryFolder,
    processMovieDirectory
};