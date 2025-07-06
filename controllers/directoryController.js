const express = require('express');
const { parseTitle } = require('../utils/parser');
const { processMovieDirectory, getSymlinkTargetPath } = require('../utils/library');
const { searchTmdb, getTmdbDetails } = require('../utils/tmdb');

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
      const directories = await prisma.directory.findMany({
        where: filters,
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
            metadata: metadata || null
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
      const override = req.query.override === 'true';
      const directory = await prisma.directory.findUnique({
        where: { id: req.params.id },
        include: { files: true }
      });
      if (!directory) return res.status(404).json({ error: 'Directory not found' });
      let existingDirectory = null;
      if (!override) {
        existingDirectory = await prisma.directory.findFirst({
          where: { tmdbId: directory.tmdbId, libraryAdded: true }
        });
      }
      let targetLibPath;
      if (directory.parsedType === 'movies') {
        if (!(directory.tmdbStatus === 'MATCH_FOUND' && directory.tmdbId)) {
          return res.status(400).json({ error: 'TMDB details missing for movies' });
        }
        const mediaType = 'movie';
        const tmdbInfo = await getTmdbDetails(directory.tmdbId, mediaType);
        if (!tmdbInfo) return res.status(400).json({ error: 'Could not fetch TMDB details' });
        if (existingDirectory) {
          targetLibPath = await processMovieDirectory(directory, tmdbInfo, existingDirectory.libraryPath);
        } else {
          targetLibPath = await processMovieDirectory(directory, tmdbInfo);
        }
        const updatedDir = await prisma.directory.update({
          where: { id: directory.id },
          data: { libraryAdded: true, libraryPath: targetLibPath },
          include: { files: true }
        });
        return res.status(200).json({ message: 'Added to library', directory: updatedDir });
      } else if (directory.parsedType === 'shows') {
        return res.status(501).json({ error: 'Adding shows to library not implemented yet' });
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
      const override = req.query.override === 'true';
      const directories = await prisma.directory.findMany({
        where: {
          AND: [
            { tmdbStatus: 'MATCH_FOUND' },
            { tmdbId: { not: null } },
            { OR: [{ libraryAdded: false }, override ? {} : {}] }
          ]
        },
        include: { files: true }
      });
      const results = await Promise.all(directories.map(async (dir) => {
        let existingDirectory = null;
        if (!override) {
          existingDirectory = await prisma.directory.findFirst({
            where: { tmdbId: dir.tmdbId, libraryAdded: true }
          });
        }
        if (dir.parsedType === 'movies') {
          const tmdbInfo = await getTmdbDetails(dir.tmdbId, 'movie');
          if (!tmdbInfo) {
            return { id: dir.id, error: 'TMDB details missing' };
          }
          try {
            let targetLibPath;
            if (existingDirectory) {
              targetLibPath = await processMovieDirectory(dir, tmdbInfo, existingDirectory.libraryPath);
            } else {
              targetLibPath = await processMovieDirectory(dir, tmdbInfo);
            }
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
      return res.render('edit', { directory }); // directory now includes metadata
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
          metadata: metadata || null
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
    updateSingleTmdb
  };
};
