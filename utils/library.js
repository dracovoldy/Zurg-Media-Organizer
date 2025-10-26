// --- New file: utils/library.js ---
// Functions to calculate target library folder and process a movie directory.
'use strict';

const fs = require('fs').promises;
const path = require('path');
const isTestEnv = process.env.TESTING === 'true';

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
        if (lang === 'mr') return 'marathi-movies';
        else if (indianLanguages.has(lang)) return 'desi-movies';
        else return 'movies';
        // else return 'unrated';
    } else if (type === 'shows') {
        // Safety: Any Indian language should go to 'desi-shows'; others go to 'shows'
        if (indianLanguages.has(lang) || lang === 'bn') return 'desi-shows';
        return 'shows';
    }
    return '';
}

// Ensure directory exists
async function createDirectoryIfNotExists(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}

// Function to determine version name based on directory name
function getVersionName(directoryName) {
    const dn = directoryName.toLowerCase();
    // More specific checks first (e.g. 1080p + 10bit/hindi) before generic ones
    if (dn.includes('yts') && dn.includes('2160p')) return 'YTS 4K';
    if (dn.includes('yts') && dn.includes('720p')) return 'YTS 720p';
    if (dn.includes('yts') && dn.includes('1080p')) return 'YTS 1080p';

    // Specific combos
    if (dn.includes('1080p') && dn.includes('10bit')) return '1080p HDR10';
    if (dn.includes('1080p') && dn.includes('hindi')) return '1080p Hindi';
    if ((dn.includes('2160p') || dn.includes('4k')) && dn.includes('hindi')) return '4K Hindi';

    // Generic resolution checks
    if (dn.includes('2160p') || dn.includes('4k')) return '4K';
    if (dn.includes('1080p')) return '1080p';
    if (dn.includes('720p')) return '720p';

    return null;
}

// Get next available versioned file path for media file symlink
async function getNextVersionedFilePath(targetDir, baseName, ext, versionName) {
    // Ensure target directory exists before scanning
    await createDirectoryIfNotExists(targetDir);

    const mainFileName = `${baseName}${ext}`;
    const mainFilePath = path.join(targetDir, mainFileName);

    // Read existing files that start with baseName and end with the extension
    const files = await fs.readdir(targetDir);
    const matches = files.filter(f => f.startsWith(baseName) && f.toLowerCase().endsWith(ext.toLowerCase()));

    // If there are no files that match baseName, create the main file (no version)
    if (matches.length === 0) {
        return mainFilePath;
    }

    // Helper to check existence in matches
    const existsInMatches = (name) => matches.includes(name);

    // If a version name is provided, prefer a resolution-based label
    if (versionName) {
        // Candidate like: Base - [1080p].ext
        let candidate = `${baseName} - [${versionName}]${ext}`;
        if (!existsInMatches(candidate)) return path.join(targetDir, candidate);

        // If exact resolution candidate exists, try numeric suffixes: [1080p 2], [1080p 3], ...
        let idx = 2;
        while (true) {
            const tryName = `${baseName} - [${versionName} ${idx}]${ext}`;
            if (!existsInMatches(tryName)) return path.join(targetDir, tryName);
            idx += 1;
            // safety cap
            if (idx > 1000) break;
        }
    }

    // Fallback to V# style versioning
    const vRegex = new RegExp(`^${escapeRegex(baseName)} - \[V(\\d+)\]${escapeRegex(ext)}$`, 'i');
    let maxV = 0;
    for (const f of matches) {
        const m = f.match(vRegex);
        if (m && m[1]) {
            const n = parseInt(m[1], 10);
            if (!isNaN(n) && n > maxV) maxV = n;
        }
    }
    const nextV = maxV + 1 || 1;
    const newFileName = `${baseName} - [V${nextV}]${ext}`;
    return path.join(targetDir, newFileName);
}

// Simple regex escape helper
function escapeRegex(s) {
    return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

// Create a symlink from src to dest
async function createSymlinkForFile(srcFilePath, destFilePath) {
    try {
        // Check if symlink already exists and points to the same source
        try {
            const existing = await fs.lstat(destFilePath);
            if (existing.isSymbolicLink()) {
                const target = await fs.readlink(destFilePath);
                if (target === srcFilePath) {
                    // Symlink already exists, skip
                    return;
                }
            }
            // If file exists and is not the correct symlink, skip or handle as needed
            return;
        } catch (err) {
            // File does not exist, proceed to create symlink
        }
        await fs.symlink(srcFilePath, destFilePath);
    } catch (error) {
        console.error(`Symlink error: ${srcFilePath} -> ${destFilePath}:`, error.message);
        throw error;
    }
}

function getSymlinkTargetPath(originalPath) {
  if (isTestEnv && process.env.TESTING_SYMLINK_PATH) {
    return path.join(process.env.TESTING_SYMLINK_PATH, path.basename(originalPath));
  }
  return originalPath;
}

// --- Show helpers ---
// Replace brittle patterns with a robust parser that finds SxxEyy anywhere
function parseShowFilename(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    if (!allowedMediaExtensions.has(ext)) return null;
    const base = fileName.slice(0, -ext.length);

    // Match ... S01E02 / S01 E02 / S01.E02 ... (spaces/dots/underscores/hyphens allowed around and between)
    let m = base.match(/(?:^|[\s._\-\)\]])[Ss](\d{1,2})[\s._\-]*[Ee](\d{1,2})(?:[\s._\-\(\[]*)(.*)$/);
    if (m) {
        const season = parseInt(m[1], 10);
        const episode = parseInt(m[2], 10);
        const leftover = (m[3] || '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
        return { season, episode, leftover, ext };
    }
    // Fallback: 1x02 pattern
    m = base.match(/(?:^|[\s._\-\)\]])(\d{1,2})x(\d{1,2})(?:[\s._\-\(\[]*)(.*)$/i);
    if (m) {
        const season = parseInt(m[1], 10);
        const episode = parseInt(m[2], 10);
        const leftover = (m[3] || '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
        return { season, episode, leftover, ext };
    }
    return null;
}

/**
 * Process a movie directory:
 * - Creates a library folder named "<tmdb title> (<year>) [tmdbid-<tmdbid>]"
 * - Symlinks all files from the original directory into the new folder.
 *   * Media files are renamed with a version suffix.
 */
async function processMovieDirectory(directory, tmdbInfo, existingLibraryPath = null, baseLibraryRoot = null) {
    if (!tmdbInfo) throw new Error("TMDB details missing");

    // HOTFIX: fix non unix compatible file names
    const mediaTitle = (tmdbInfo.title || tmdbInfo.name || directory.name).replace(/\//g, " ");
    const releaseDate = tmdbInfo.release_date || tmdbInfo.first_air_date || "";
    const releaseYear = releaseDate ? releaseDate.substring(0, 4) : "Unknown";
    const categoryFolder = getTargetCategoryFolder('movies', tmdbInfo);
    const newFolderName = `${mediaTitle} (${releaseYear}) [tmdbid-${directory.tmdbId}]`;

    let targetDir;
    const root = baseLibraryRoot || LIBRARY_BASE_PATH;
    const expectedCategoryDir = path.join(root, categoryFolder);
    // If existingLibraryPath points to the category root (e.g. '/mnt/library/movies')
    // then ignore it and create a per-movie folder instead. This avoids symlinking
    // all files directly into the category folder when older DB rows only stored
    // the category path.
    if (existingLibraryPath && existingLibraryPath !== expectedCategoryDir) {
        targetDir = existingLibraryPath;
    } else {
        targetDir = path.join(root, categoryFolder, newFolderName);
    }
    // Ensure directory exists whether provided or newly constructed
    await createDirectoryIfNotExists(targetDir);

    // Filter out media files among all files based on allowed extensions.
    const mediaFiles = directory.files.filter(file => allowedMediaExtensions.has(path.extname(file.name).toLowerCase()));
    let largestMediaFile = null;
    if (mediaFiles.length > 0) {
        largestMediaFile = mediaFiles.reduce((prev, curr) => (prev.size > curr.size ? prev : curr));
    }

    // Determine version name
    const versionName = getVersionName(directory.name);

    // Process each file in the directory.
    for (const file of directory.files) {
        const srcFilePath = file.path;
        const fileExt = path.extname(file.name).toLowerCase();
        let destFilePath;
        if (allowedMediaExtensions.has(fileExt)) {
            if (largestMediaFile && file.id === largestMediaFile.id) {
                // For the largest (main) media file, apply versioning.
                // const baseName = `${mediaTitle} (${releaseYear})`;
                const baseName = newFolderName;
                destFilePath = await getNextVersionedFilePath(targetDir, baseName, fileExt, versionName);
            } else {
                // For extra media files, append "-extra" and do NOT version.
                destFilePath = path.join(targetDir, `${mediaTitle} (${releaseYear}) [tmdbid-${directory.tmdbId}]-extra${fileExt}`);
            }
        } else {
            // For non-media files, just preserve the original file name.
            destFilePath = path.join(targetDir, file.name);
        }
        // Use getSymlinkTargetPath for symlink creation
        const targetPath = getSymlinkTargetPath(destFilePath);
        await createSymlinkForFile(srcFilePath, targetPath);
    }
    return targetDir;
}

/**
 * Process a show directory:
 * - Creates base folder "<show title> [tmdbid-<tmdbid>]" in category (language-based)
 * - For each media file that matches SxxEyy pattern, creates Season NN folder and a symlink:
 *   "<Show Title> - SxxExx - <leftover>.ext" (leftover optional)
 */
async function processShowDirectory(directory, tmdbInfo, existingLibraryPath = null, baseLibraryRoot = null) {
    if (!tmdbInfo) throw new Error('TMDB details missing');

    const showTitle = (tmdbInfo.name || tmdbInfo.title || directory.parsedName || directory.name).replace(/\//g, ' ');
    const categoryFolder = getTargetCategoryFolder('shows', tmdbInfo);
    const baseFolderName = `${showTitle} [tmdbid-${directory.tmdbId}]`;

    const root = baseLibraryRoot || LIBRARY_BASE_PATH;
    const expectedBaseDir = path.join(root, categoryFolder, baseFolderName);
    const expectedCategoryDir = path.join(root, categoryFolder);

    let baseDir;
    // Only reuse existing path if it points to a specific show folder (not the category root)
    if (existingLibraryPath && existingLibraryPath !== expectedCategoryDir && existingLibraryPath.startsWith(path.join(root, categoryFolder))) {
        baseDir = existingLibraryPath;
    } else {
        baseDir = expectedBaseDir;
    }
    // Ensure baseDir exists
    await createDirectoryIfNotExists(baseDir);

    for (const file of directory.files) {
        const ext = path.extname(file.name).toLowerCase();
        if (!allowedMediaExtensions.has(ext)) continue;

        const parsed = parseShowFilename(file.name);
        if (!parsed) {
            // Skip files that don't parse as episodes
            continue;
        }
        const seasonPadded = String(parsed.season).padStart(2, '0');
        const episodePadded = String(parsed.episode).padStart(2, '0');
        const leftoverClean = (parsed.leftover || '').replace(/\./g, ' ').trim();
        const seasonFolder = path.join(baseDir, `Season ${seasonPadded}`);
        await createDirectoryIfNotExists(seasonFolder);

        const linkName = leftoverClean
            ? `${showTitle} - S${seasonPadded}E${episodePadded} - ${leftoverClean}${parsed.ext}`
            : `${showTitle} - S${seasonPadded}E${episodePadded}${parsed.ext}`;
        const destPath = path.join(seasonFolder, linkName);

        const targetPath = getSymlinkTargetPath(destPath);
        await createSymlinkForFile(file.path, targetPath);
    }

    return baseDir;
}

module.exports = {
    getTargetCategoryFolder,
    processMovieDirectory,
    processShowDirectory,
    getSymlinkTargetPath, // Export for use in controller
    createDirectoryIfNotExists // Export for use in controller
};

// Export helpers for testing and external use
module.exports.getVersionName = getVersionName;
module.exports.getNextVersionedFilePath = getNextVersionedFilePath;

// Additional helpers for multi-library support
module.exports.getLibraries = async function(prisma) {
    // Return libraries ordered with default first
    if (!prisma || !prisma.library) return [];
    return prisma.library.findMany({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
};

module.exports.resolveLibraryRoot = function(library) {
    // Accept either a library object { rootPath } or a raw path
    if (!library) return LIBRARY_BASE_PATH;
    if (typeof library === 'string') return library;
    if (library.rootPath) return library.rootPath;
    return LIBRARY_BASE_PATH;
};

// Ensure standard subfolders exist under a library root
module.exports.ensureLibraryStructure = async function(libraryRoot) {
    if (!libraryRoot) throw new Error('libraryRoot required');
    const movieDir = path.join(libraryRoot, 'movies');
    const showDir = path.join(libraryRoot, 'shows');
    const unratedDir = path.join(libraryRoot, 'unrated');
    await createDirectoryIfNotExists(movieDir);
    await createDirectoryIfNotExists(showDir);
    await createDirectoryIfNotExists(unratedDir);
    return { movies: movieDir, shows: showDir, unrated: unratedDir };
};

// Validate a library root path: exists and writable
module.exports.validateLibraryPath = async function(p) {
    try {
        // check existence
        await fs.access(p);
    } catch (e) {
        return { ok: false, reason: 'PATH_NOT_FOUND' };
    }
    try {
        // check write access by attempting to write a temp file
        const tmpPath = path.join(p, `.zurg_test_${Date.now()}`);
        await fs.writeFile(tmpPath, 'ok');
        await fs.unlink(tmpPath);
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: 'NOT_WRITABLE' };
    }
};