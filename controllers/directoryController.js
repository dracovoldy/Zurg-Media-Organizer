const express = require('express');
const path = require('path');
const { parseTitle } = require('../utils/parser');
const { processMovieDirectory, getSymlinkTargetPath, createDirectoryIfNotExists, processShowDirectory } = require('../utils/library');
const { searchTmdb, getTmdbDetails } = require('../utils/tmdb');
const fsp = require('fs').promises;

// Helpers to handle metadata stored as String (JSON)
function parseMetadataField(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try { return JSON.parse(metadata); } catch { return {}; }
  }
  if (typeof metadata === 'object') return { ...metadata };
  return {};
}
function serializeMetadata(metadataObj) {
  if (!metadataObj) return null;
  try { return JSON.stringify(metadataObj); } catch { return null; }
}

const PAGE_SIZE = 25;

module.exports = function (prisma) {
  // All route handlers use the passed-in prisma instance

  async function listDirectories(req, res) {
    try {

      let page = parseInt(req.query.page, 10) || 1;
      if (page < 1) page = 1;
      const limit = PAGE_SIZE;
      const skip = (page - 1) * limit;
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
      if (req.query.type && req.query.type.trim() !== "") {
        if (req.query.type === 'shows') filters.parsedType = "shows";
        else if (req.query.type === 'collection') filters.parsedType = "collection";
        else if (req.query.type === 'movies') filters.parsedType = "movies";
        else if (req.query.type === 'unknown') filters.parsedType = null;
      }
      if (req.query.tmdbId && !isNaN(Number(req.query.tmdbId))) {
        filters.tmdbId = Number(req.query.tmdbId);
      }
      if (req.query.libraryStatus && req.query.libraryStatus.trim() !== "") {
        if (req.query.libraryStatus === 'added') filters.libraryAdded = true;
        else if (req.query.libraryStatus === 'notAdded') filters.libraryAdded = false;
      }
      const validSortFields = ['name', 'parsedName', 'parsedYear', 'specialName', 'tmdbId', 'createdAt'];
      let orderBy = {};
      if (req.query.sortBy && validSortFields.includes(req.query.sortBy)) {
        orderBy[req.query.sortBy] = req.query.sortOrder && req.query.sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc';
      } else {
        orderBy.createdAt = 'desc';
      }
      // If library filtering requested, only show directories associated with that library or all if not provided
      let whereClause = filters;
      if (req.query.libraryId && req.query.libraryId.trim() !== '') {
        const libId = req.query.libraryId;
        // Show directories that belong to the selected library OR are not yet added to any library
        whereClause = {
          AND: [filters, { OR: [{ libraryId: libId }, { libraryAdded: false }] }]
        };
      }

      const directories = await prisma.directory.findMany({
        where: whereClause,
        include: { files: true },
        orderBy,
        skip,
        take: limit
      });
      const total = await prisma.directory.count({ where: filters });
      const totalPages = Math.ceil(total / limit);
      const enrichedDirectories = await Promise.all(directories.map(async (dir) => {
        if (dir.tmdbStatus === "MATCH_FOUND" && dir.tmdbId) {
          const mediaType = (dir.parsedType && dir.parsedType.toLowerCase() === 'shows') ? 'shows' : 'movie';
          const tmdbInfo = await getTmdbDetails(dir.tmdbId, mediaType);
          return { ...dir, tmdbInfo };
        }
        return { ...dir, tmdbInfo: null };
      }));
      // Fetch libraries to populate selector on UI
      let libraries = [];
      try { libraries = await require('../utils/library').getLibraries(prisma); } catch (e) { libraries = []; }

      // If client prefers JSON (or requests ?format=json), return JSON for API consumers
      if ((req.headers.accept && req.headers.accept.includes('application/json')) || req.query.format === 'json') {
        // Fix BigInt serialization
        const replacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;
        res.setHeader('Content-Type', 'application/json');
        return res.send(JSON.stringify({ enrichedDirectories, page, totalPages, query: req.query, validSortFields, libraries }, replacer));
      }

      res.render("index", {
        enrichedDirectories,
        page,
        totalPages,
        query: req.query,
        validSortFields,
        libraries
      });
    } catch (error) {
      console.error("Error fetching directories from DB:", error);
      res.status(500).send("An error occurred while retrieving data.");
    }
  }

  async function parseAllDirectories(req, res) {
    try {

      const directories = await prisma.directory.findMany({
        where: { parsedName: null },
        orderBy: { createdAt: 'desc' }
      });
      const updatedDirectories = await Promise.all(directories.map(async (dir) => {
        const { parsed_name, parsed_year, type, specialName, metadata } = parseTitle(dir.name);
        const parsedYearConverted = parsed_year && !isNaN(Number(parsed_year)) ? Number(parsed_year) : null;
        return prisma.directory.update({
          where: { id: dir.id },
          data: {
            parsedName: parsed_name,
            parsedYear: parsedYearConverted,
            parsedType: type,
            specialName: specialName,
            metadata: { set: serializeMetadata(metadata) }
          },
          include: { files: true }
        });
      }));
      const replacer = (key, value) => typeof value === "bigint" ? value.toString() : value;
      res.setHeader("Content-Type", "application/json");
      res.send(JSON.stringify(updatedDirectories, replacer));
    } catch (error) {
      console.error("Error updating directories:", error);
      res.status(500).send("An error occurred while parsing directories.");
    }
  }

  async function updateAllTmdb(req, res) {
    try {

      const mode = req.query.mode;
      let directories;
      if (mode === 'full') {
        directories = await prisma.directory.findMany();
      } else {
        directories = await prisma.directory.findMany({ where: { tmdbId: null } });
      }
      const updatePromises = directories.map(async (dir) => {
        let updateData = {};
        if ((!dir.parsedName) && (!dir.specialName)) {
          updateData.tmdbStatus = "SKIPPED_NO_PARSED_NAME";
        } else {
          const queryName = (dir.specialName && dir.specialName.trim() !== "") ? dir.specialName : dir.parsedName;
          try {
            const foundTmdbId = await searchTmdb(queryName, dir.parsedType, dir.parsedYear);
            if (foundTmdbId !== null) {
              updateData.tmdbId = foundTmdbId;
              updateData.tmdbStatus = "MATCH_FOUND";
            } else {
              updateData.tmdbStatus = "NO_MATCH_FOUND";
            }
          } catch (error) {
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
      const replacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(results, replacer));
    } catch (error) {
      console.error("Error during TMDB update:", error);
      res.status(500).send("An error occurred while updating TMDB info.");
    }
  }

  async function manualSync(req, res) {
    const dirPath = req.body.dirPath ? req.body.dirPath : process.env.ZURG_ALL_PATH;
    if (!dirPath) {
      return res.status(400).json({ error: 'Directory path ("dirPath") is required in the request body.' });
    }
    try {
      await syncDirectory(dirPath);
      return res.status(200).json({ message: `Successfully synced directory ${dirPath}` });
    } catch (error) {
      console.error(`Manual sync error for ${dirPath}:`, error);
      return res.status(500).json({ error: 'Failed to sync directory' });
    }
  }

  async function addToLibrarySingle(req, res) {
    try {
      // Resolve optional target library from query param
      const targetLibraryId = req.query.libraryId || null;
      let targetLibrary = null;
      if (targetLibraryId) {
        targetLibrary = await prisma.library.findUnique({ where: { id: targetLibraryId } });
      } else {
        // pick default library if exists
        targetLibrary = await prisma.library.findFirst({ where: { isDefault: true } });
      }
      const libraryRoot = require('../utils/library').resolveLibraryRoot(targetLibrary);

      const override = req.query.override === 'true';
      const directory = await prisma.directory.findUnique({
        where: { id: req.params.id },
        include: { files: true }
      });
      if (!directory) return res.status(404).json({ error: 'Directory not found' });
      let existingDirectory = null;
      if (!override) {
        existingDirectory = await prisma.directory.findFirst({
          where: { tmdbId: directory.tmdbId, libraryAdded: true, parsedType: directory.parsedType }
        });
      }
      const dirMeta = parseMetadataField(directory.metadata);
      let targetLibPath;
      if (directory.parsedType === 'movies') {
        if (!(directory.tmdbStatus === 'MATCH_FOUND' && directory.tmdbId)) {
          return res.status(400).json({ error: 'TMDB details missing for movies' });
        }
        const mediaType = 'movie';
        const tmdbInfo = await getTmdbDetails(directory.tmdbId, mediaType);
        if (!tmdbInfo) return res.status(400).json({ error: 'Could not fetch TMDB details' });
        // If unrated, always use <libraryRoot>/unrated
        if (dirMeta && dirMeta.unrated === true) {
          const unratedFolder = path.join(libraryRoot, 'unrated');
          const mediaTitle = (tmdbInfo.title || tmdbInfo.name || directory.name).replace(/\//g, " ");
          const releaseDate = tmdbInfo.release_date || tmdbInfo.first_air_date || "";
          const releaseYear = releaseDate ? releaseDate.substring(0, 4) : "Unknown";
          const newFolderName = `${mediaTitle} (${releaseYear}) [tmdbid-${directory.tmdbId}]`;
          targetLibPath = path.join(unratedFolder, newFolderName);
          await createDirectoryIfNotExists(targetLibPath);
          // Move any existing symlinks to unrated folder
          if (directory.libraryAdded && directory.libraryPath && directory.libraryPath !== targetLibPath) {
            try {
              await fsp.rename(directory.libraryPath, targetLibPath);
            } catch (e) {
              // If rename fails, fallback to re-symlink
            }
          }
          await processMovieDirectory(directory, tmdbInfo, targetLibPath);
          } else if (existingDirectory) {
            targetLibPath = await processMovieDirectory(directory, tmdbInfo, existingDirectory.libraryPath, libraryRoot);
          } else {
            // Use selected/default library root when creating new target
            targetLibPath = await processMovieDirectory(directory, tmdbInfo, null, libraryRoot);
          }
        const updatedDir = await prisma.directory.update({
          where: { id: directory.id },
          data: { libraryAdded: true, libraryPath: targetLibPath, libraryId: targetLibrary ? targetLibrary.id : null },
          include: { files: true }
        });
        // Fix BigInt serialization for JSON response
        function replacer(key, value) {
          return typeof value === 'bigint' ? value.toString() : value;
        }
        return res.status(200).json(JSON.parse(JSON.stringify({ message: 'Added to library', directory: updatedDir }, replacer)));
      } else if (directory.parsedType === 'shows') {
        if (!(directory.tmdbStatus === 'MATCH_FOUND' && directory.tmdbId)) {
          return res.status(400).json({ error: 'TMDB details missing for shows' });
        }
        const tmdbInfo = await getTmdbDetails(directory.tmdbId, 'shows');
        if (!tmdbInfo) return res.status(400).json({ error: 'Could not fetch TMDB details' });
        if (existingDirectory) {
          targetLibPath = await processShowDirectory(directory, tmdbInfo, existingDirectory.libraryPath, libraryRoot);
        } else {
          targetLibPath = await processShowDirectory(directory, tmdbInfo, null, libraryRoot);
        }
        const updatedDir = await prisma.directory.update({
          where: { id: directory.id },
          data: { libraryAdded: true, libraryPath: targetLibPath, libraryId: targetLibrary ? targetLibrary.id : null },
          include: { files: true }
        });
        function replacer(key, value) { return typeof value === 'bigint' ? value.toString() : value; }
        return res.status(200).json(JSON.parse(JSON.stringify({ message: 'Added show to library', directory: updatedDir }, replacer)));
      } else if (directory.parsedType === 'collection') {
        return res.status(501).json({ error: 'Adding collections to library not implemented yet' });
      } else {
        return res.status(400).json({ error: 'Unsupported directory type' });
      }
    } catch (error) {
      console.error('Error in Add-to-Library (single):', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  async function addToLibraryMass(req, res) {
    try {
      // Resolve optional target library from query param
      const targetLibraryId = req.query.libraryId || null;
      let targetLibrary = null;
      if (targetLibraryId) {
        targetLibrary = await prisma.library.findUnique({ where: { id: targetLibraryId } });
      } else {
        targetLibrary = await prisma.library.findFirst({ where: { isDefault: true } });
      }
      const libraryRoot = require('../utils/library').resolveLibraryRoot(targetLibrary);

      const override = req.query.override === 'true';
      const directories = await prisma.directory.findMany({
        where: {
          AND: [
            { tmdbStatus: 'MATCH_FOUND' },
            { tmdbId: { not: null } },
            { parsedType: 'movies' }, // Safety: bulk add only for movies
            { OR: [{ libraryAdded: false }, override ? {} : {}] }
          ]
        },
        include: { files: true }
      });
      const results = await Promise.all(directories.map(async (dir) => {
        let existingDirectory = null;
        if (!override) {
          existingDirectory = await prisma.directory.findFirst({
            where: { tmdbId: dir.tmdbId, libraryAdded: true, parsedType: dir.parsedType }
          });
        }
        const dirMeta = parseMetadataField(dir.metadata);
        if (dir.parsedType !== 'movies') {
          return { id: dir.id, error: 'Bulk adding shows is disabled' };
        }
        if (dir.parsedType === 'movies') {
          const tmdbInfo = await getTmdbDetails(dir.tmdbId, 'movie');
          if (!tmdbInfo) {
            return { id: dir.id, error: 'TMDB details missing' };
          }
          try {
            let targetLibPath;
            // If unrated, always use <libraryRoot>/unrated
            if (dirMeta && dirMeta.unrated === true) {
              const unratedFolder = path.join(libraryRoot, 'unrated');
              const mediaTitle = (tmdbInfo.title || tmdbInfo.name || dir.name).replace(/\//g, " ");
              const releaseDate = tmdbInfo.release_date || tmdbInfo.first_air_date || "";
              const releaseYear = releaseDate ? releaseDate.substring(0, 4) : "Unknown";
              const newFolderName = `${mediaTitle} (${releaseYear}) [tmdbid-${dir.tmdbId}]`;
              targetLibPath = path.join(unratedFolder, newFolderName);
              await createDirectoryIfNotExists(targetLibPath);
              // Move any existing symlinks to unrated folder
              if (dir.libraryAdded && dir.libraryPath && dir.libraryPath !== targetLibPath) {
                try {
                  await fsp.rename(dir.libraryPath, targetLibPath);
                } catch (e) {
                  // If rename fails, fallback to re-symlink
                }
              }
              await processMovieDirectory(dir, tmdbInfo, targetLibPath);
            } else {
              if (existingDirectory) {
                targetLibPath = await processMovieDirectory(dir, tmdbInfo, existingDirectory.libraryPath, libraryRoot);
              } else {
                targetLibPath = await processMovieDirectory(dir, tmdbInfo, null, libraryRoot);
              }
            }
            const updated = await prisma.directory.update({
              where: { id: dir.id },
              data: { libraryAdded: true, libraryPath: targetLibPath, libraryId: targetLibrary ? targetLibrary.id : null },
              include: { files: true }
            });
            return { id: dir.id, status: 'added', libraryPath: targetLibPath };
          } catch (error) {
            return { id: dir.id, error: error.message };
          }
        } else if (dir.parsedType === 'collection') {
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
  }

  async function renderEditPage(req, res) {
    const id = req.params.id;
    try {
      const directory = await prisma.directory.findUnique({ where: { id } });
      if (!directory) return res.status(404).send('Directory not found');
      const libraries = await require('../utils/library').getLibraries(prisma);
      return res.render('edit', { directory, libraries }); // directory now includes metadata
    } catch (error) {
      console.error("Error fetching directory:", error);
      return res.status(500).send("Internal Server Error");
    }
  }

  async function updateDirectory(req, res) {
    const id = req.params.id;
    const data = {
      parsedName: req.body.parsedName || null,
      parsedYear: req.body.parsedYear ? parseInt(req.body.parsedYear, 10) : null,
      parsedType: req.body.parsedType || null,
      specialName: req.body.specialName || null,
      tmdbId: req.body.tmdbId ? parseInt(req.body.tmdbId, 10) : null,
      tmdbStatus: req.body.tmdbStatus || null,
      libraryAdded: req.body.libraryAdded === "true" ? true : (req.body.libraryAdded === "false" ? false : null),
      libraryPath: req.body.libraryPath || null,
    };
    try {
      await prisma.directory.update({ where: { id }, data });
      const updated = await prisma.directory.findUnique({ where: { id } });
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json(updated);
      }
      // Fallback for normal form POSTs
      // return res.redirect('/directory/' + id + '/edit');
    } catch (error) {
      console.error("Error updating directory:", error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  async function parseSingleDirectory(req, res) {
    const id = req.params.id;
    try {
      const directory = await prisma.directory.findUnique({ where: { id } });
      if (!directory) return res.status(404).send('Directory not found');
      const { parsed_name, parsed_year, type, specialName, metadata } = parseTitle(directory.name);
      const parsedYearConverted = parsed_year && !isNaN(Number(parsed_year)) ? Number(parsed_year) : null;
      await prisma.directory.update({
        where: { id },
        data: {
          parsedName: parsed_name,
          parsedYear: parsedYearConverted,
          parsedType: type,
          specialName: specialName,
          metadata: { set: serializeMetadata(metadata) }
        }
      });
      const updated = await prisma.directory.findUnique({ where: { id } });
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json(updated);
      }
      // Fallback for normal form POSTs
      // return res.redirect('/directory/' + id + '/edit');
    } catch (error) {
      console.error("Error parsing directory:", error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  async function updateSingleTmdb(req, res) {
    const id = req.params.id;
    try {
      const directory = await prisma.directory.findUnique({ where: { id } });
      if (!directory) return res.status(404).send('Directory not found');
      let updateData = {};
      if ((!directory.parsedName) && (!directory.specialName)) {
        updateData.tmdbStatus = "SKIPPED_NO_PARSED_NAME";
      } else {
        const queryName = (directory.specialName && directory.specialName.trim() !== "") ? directory.specialName : directory.parsedName;
        try {
          const foundTmdbId = await searchTmdb(queryName, directory.parsedType, directory.parsedYear);
          if (foundTmdbId !== null) {
            updateData.tmdbId = foundTmdbId;
            updateData.tmdbStatus = "MATCH_FOUND";
          } else {
            updateData.tmdbStatus = "NO_MATCH_FOUND";
          }
        } catch (e) {
          if (e.message === 'API_DOWN') {
            updateData.tmdbStatus = "API_DOWN";
          } else {
            updateData.tmdbStatus = "NETWORK_ERROR";
          }
        }
      }
      await prisma.directory.update({ where: { id }, data: updateData });
      // Fetch the updated directory
      const updated = await prisma.directory.findUnique({ where: { id } });
      // Always return JSON for AJAX/fetch
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json(updated);
      }
      // Fallback for normal form POSTs
      // return res.redirect('/directory/' + id + '/edit');
    } catch (error) {
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  return {
    listDirectories,
    parseAllDirectories,
    updateAllTmdb,
    manualSync,
    addToLibrarySingle,
    addToLibraryMass,
    renderEditPage,
    updateDirectory,
    parseSingleDirectory,
    updateSingleTmdb,
    checkExplicitContent: async function (req, res) {
      try {
        const directory = await prisma.directory.findUnique({
          where: { id: req.params.id },
          include: { files: true }
        });
        if (!directory || directory.parsedType !== 'movies' || !directory.tmdbId) {
          return res.status(400).json({ error: 'Explicit check only allowed for movies with TMDB ID.' });
        }
        const tmdbInfo = await getTmdbDetails(directory.tmdbId, 'movie');
        if (!tmdbInfo) {
          return res.status(500).json({ error: 'Could not fetch TMDB details.' });
        }

        // Use TMDB adult flag as the explicit determination
        const isAdult = Boolean(tmdbInfo.adult);
        const jsonResult = {
          sexual_content: null,
          nudity: null,
          violence: null,
          drug_reference: null,
          adult: isAdult,
          source: 'tmdb',
        };

        let newMetadata = parseMetadataField(directory.metadata);
        newMetadata.unrated_check = jsonResult;
        newMetadata.unrated = isAdult;

        // Update siblings with same tmdbId (replace metadata blob as we use String field)
        await prisma.directory.updateMany({
          where: {
            tmdbId: directory.tmdbId,
            parsedType: 'movies',
            NOT: { id: directory.id }
          },
          data: {
            metadata: { set: serializeMetadata(newMetadata) }
          }
        });

        const updated = await prisma.directory.update({
          where: { id: directory.id },
          data: { metadata: { set: serializeMetadata(newMetadata) } },
        });
        res.json({ ...updated, unrated_check: jsonResult });
      } catch (error) {
        console.error('Explicit content check error:', error);
        res.status(500).json({ error: 'Failed to check explicit content.' });
      }
    },
    markExplicit: async function (req, res) {
      try {
        const directory = await prisma.directory.findUnique({ where: { id: req.params.id }, include: { files: true } });
        if (!directory || directory.parsedType !== 'movies' || !directory.tmdbId) {
          return res.status(400).json({ error: 'Manual explicit override only allowed for movies with TMDB ID.' });
        }
        let meta = parseMetadataField(directory.metadata);
        meta.unrated = true;
        meta.unrated_check = { ...(meta.unrated_check || {}), manual_override: true, adult: true };

        // Update siblings with same tmdbId
        await prisma.directory.updateMany({
          where: { tmdbId: directory.tmdbId, parsedType: 'movies', NOT: { id: directory.id } },
          data: { metadata: { set: serializeMetadata(meta) } }
        });
        const updated = await prisma.directory.update({ where: { id: directory.id }, data: { metadata: { set: serializeMetadata(meta) } } });
        return res.json(updated);
      } catch (error) {
        console.error('Manual markExplicit error:', error);
        return res.status(500).json({ error: 'Failed to mark explicit.' });
      }
    },
    clearExplicit: async function (req, res) {
      try {
        const directory = await prisma.directory.findUnique({ where: { id: req.params.id }, include: { files: true } });
        if (!directory || directory.parsedType !== 'movies' || !directory.tmdbId) {
          return res.status(400).json({ error: 'Manual explicit override only allowed for movies with TMDB ID.' });
        }
        let meta = parseMetadataField(directory.metadata);
        meta.unrated = false;
        meta.unrated_check = { ...(meta.unrated_check || {}), manual_override: true, adult: false };

        await prisma.directory.updateMany({
          where: { tmdbId: directory.tmdbId, parsedType: 'movies', NOT: { id: directory.id } },
          data: { metadata: { set: serializeMetadata(meta) } }
        });
        const updated = await prisma.directory.update({ where: { id: directory.id }, data: { metadata: { set: serializeMetadata(meta) } } });
        return res.json(updated);
      } catch (error) {
        console.error('Manual clearExplicit error:', error);
        return res.status(500).json({ error: 'Failed to clear explicit.' });
      }
    },
    deleteDirectory: async function (req, res) {
      const id = req.params.id;
      const { libraryPath } = req.body;
      try {
        // Delete symlink if exists
        if (libraryPath) {
          const fs = require('fs');
          if (fs.existsSync(libraryPath) && fs.lstatSync(libraryPath).isSymbolicLink()) {
            fs.unlinkSync(libraryPath);
          }
        }
        // Delete files first, then directory to avoid FK/unique leftovers
        await prisma.$transaction([
          prisma.file.deleteMany({ where: { directoryId: id } }),
          prisma.directory.delete({ where: { id } })
        ]);
        res.json({ message: 'Directory and files deleted.' });
      } catch (err) {
        res.status(500).json({ message: 'Delete failed', error: err.message });
      }
    },
  };
};
