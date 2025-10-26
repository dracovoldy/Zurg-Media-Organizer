const path = require('path');
const { processMovieDirectory, ensureLibraryStructure } = require('../utils/library');

async function run() {
  // Setup a fake library root under /tmp for testing
  const libRoot = path.join('/tmp', 'zurg_test_library');
  await ensureLibraryStructure(libRoot);

  const fakeDirectory = {
    id: 'fake-1',
    name: 'Fake Movie (2020)',
    tmdbId: 99999,
    files: [
      { id: 'f1', name: 'Fake.Movie.2020.mkv', path: path.join('/tmp', 'source_dir', 'Fake.Movie.2020.mkv'), size: 1024 * 1024 },
      { id: 'f2', name: 'sample.txt', path: path.join('/tmp', 'source_dir', 'sample.txt'), size: 100 }
    ]
  };

  try {
    const target = await processMovieDirectory(fakeDirectory, { title: 'Fake Movie', release_date: '2020-01-01' }, null, libRoot);
    console.log('Process returned targetDir:', target);
  } catch (e) {
    console.error('Error:', e);
  }
}

run();
