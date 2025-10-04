const express = require('express');
const directoryControllerFactory = require('../controllers/directoryController');

module.exports = function(prisma) {
  const router = express.Router();
  const controller = directoryControllerFactory(prisma);

  // List directories (main page)
  router.get('/', controller.listDirectories);

  // Parse all directories
  router.get('/parse-all', controller.parseAllDirectories);

  // Update TMDB information for all directories
  router.get('/update-all-tmdb', controller.updateAllTmdb);

  // Manual sync for directories
  router.post('/manual-sync', controller.manualSync);

  // Add a single directory to the library
  router.post('/add-to-library/:id', controller.addToLibrarySingle);

  // Add multiple directories to the library
  router.post('/add-to-library-mass', controller.addToLibraryMass);

  // Render the edit page for a directory
  router.get('/directory/:id/edit', controller.renderEditPage);

  // Update a directory's information
  router.post('/directory/:id/edit', controller.updateDirectory);

  // Parse a single directory
  router.post('/directory/:id/parse', controller.parseSingleDirectory);

  // Update TMDB information for a single directory
  router.post('/directory/:id/update-tmdb', controller.updateSingleTmdb);

  // Explicit content check for movies
  router.post('/directory/:id/check-explicit', controller.checkExplicitContent);

  // Manual explicit override routes
  router.post('/directory/:id/mark-explicit', controller.markExplicit);
  router.post('/directory/:id/clear-explicit', controller.clearExplicit);

  // Delete a directory and its symlink
  router.post('/directory/:id/delete', controller.deleteDirectory);

  return router;
};
