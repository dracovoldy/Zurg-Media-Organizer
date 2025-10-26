const express = require('express');
const directoryControllerFactory = require('../controllers/directoryController');

module.exports = function(prisma) {
  const router = express.Router();
  const controller = directoryControllerFactory(prisma);

  // List directories (main page)
  router.get('/', controller.listDirectories);

  // JSON API: list directories (for external frontends like Next.js)
  router.get('/api/directories', async function(req, res) {
    try {
      const page = parseInt(req.query.page, 10) || 1;
      const limit = 100; // reasonable default for UI list
      const skip = (page - 1) * limit;
      const dirs = await prisma.directory.findMany({ include: { files: true }, orderBy: { createdAt: 'desc' }, skip, take: limit });
      res.json(dirs);
    } catch (e) {
      console.error('Failed to list directories (API):', e && e.message);
      res.status(500).json({ error: 'Failed to list directories' });
    }
  });

  // JSON API: get a single directory by id
  router.get('/api/directory/:id', async function(req, res) {
    try {
      const id = req.params.id;
      const dir = await prisma.directory.findUnique({ where: { id }, include: { files: true } });
      if (!dir) return res.status(404).json({ error: 'Directory not found' });
      res.json(dir);
    } catch (e) {
      console.error('Failed to fetch directory (API):', e && e.message);
      res.status(500).json({ error: 'Failed to fetch directory' });
    }
  });

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

  // Library management endpoints (basic)
  router.get('/libraries', async function(req, res) {
    try {
      const libs = await require('../utils/library').getLibraries(prisma);
      res.json(libs);
    } catch (e) { res.status(500).json({ error: 'Failed to list libraries' }); }
  });

  router.post('/libraries', async function(req, res) {
    try {
      const { name, rootPath, isDefault } = req.body;
      if (!name || !rootPath) return res.status(400).json({ error: 'name and rootPath required' });
      // Defensive: ensure Prisma client has the library model (you may need to run `npx prisma generate` after schema changes)
      if (!prisma.library) {
        return res.status(500).json({ error: 'Prisma client missing `library` model. Run `npx prisma generate` and apply migrations (e.g. `npx prisma migrate dev`) then restart the app.' });
      }
      const libUtils = require('../utils/library');
      const valid = await libUtils.validateLibraryPath(rootPath).catch(() => ({ ok:false, reason:'INVALID' }));
      if (!valid.ok) return res.status(400).json({ error: 'Invalid rootPath', reason: valid.reason });
      if (isDefault) {
        // unset previous default
        await prisma.library.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      const lib = await prisma.library.create({ data: { name, rootPath, isDefault: Boolean(isDefault) } });
      // Ensure folders exist on disk
      await libUtils.ensureLibraryStructure(rootPath).catch(() => {});
      res.status(201).json(lib);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to create library' }); }
  });

  // Admin UI for libraries
  router.get('/libraries-admin', async function(req, res) {
    try {
      const libs = await require('../utils/library').getLibraries(prisma);
      return res.render('libraries-admin', { libraries: libs });
    } catch (e) { console.error(e); return res.status(500).send('Failed to render admin'); }
  });

  // Update a library
  router.post('/libraries/:id', async function(req, res) {
    try {
      const id = req.params.id;
      const { name, rootPath, isDefault } = req.body;
      if (!prisma.library) return res.status(500).json({ error: 'Prisma client missing library model' });
      // Validate path
      const libUtils = require('../utils/library');
      const valid = await libUtils.validateLibraryPath(rootPath).catch(() => ({ ok:false, reason:'INVALID' }));
      if (!valid.ok) return res.status(400).json({ error: 'Invalid rootPath', reason: valid.reason });
      if (isDefault) await prisma.library.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      const updated = await prisma.library.update({ where: { id }, data: { name, rootPath, isDefault: Boolean(isDefault) } });
      // Ensure structure
      await libUtils.ensureLibraryStructure(rootPath);
      res.json(updated);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to update' }); }
  });

  // Delete a library
  router.delete('/libraries/:id', async function(req, res) {
    try {
      const id = req.params.id;
      if (!prisma.library) return res.status(500).json({ error: 'Prisma client missing library model' });
      await prisma.library.delete({ where: { id } });
      return res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to delete' }); }
  });

  // Move library contents from one root to another (simple migration: rename folder)
  router.post('/libraries/move', async function(req, res) {
    try {
      const { fromRoot, toRoot } = req.body;
      if (!fromRoot || !toRoot) return res.status(400).json({ error: 'fromRoot and toRoot required' });
      const fs = require('fs').promises;
      // Ensure destination exists
      await require('../utils/library').ensureLibraryStructure(toRoot);
      // Move subfolders (movies, shows, unrated) if they exist
      const subfolders = ['movies','shows','unrated'];
      for (const sub of subfolders) {
        const src = require('path').join(fromRoot, sub);
        const dest = require('path').join(toRoot, sub);
        try {
          await fs.rename(src, dest);
        } catch (e) {
          // ignore if not exist or partial failures
        }
      }
      // Update DB: directories with libraryPath under fromRoot should be updated to toRoot
      await prisma.directory.updateMany({ where: { libraryPath: { startsWith: fromRoot } }, data: { libraryPath: prisma.$executeRaw`''` } }).catch(() => {});
      return res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to move libraries' }); }
  });

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
