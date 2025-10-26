// tools/watch-test.js
// Usage: node tools/watch-test.js [path]
// Defaults to current directory if no path provided.
//
// This script runs three watchers in parallel to help you determine if
// native inotify events are emitted by your filesystem mount (rclone/webdav):
// 1) chokidar native (usePolling: false)
// 2) chokidar polling (usePolling: true)
// 3) fs.watch (native Node watcher)
//
// Run it and then from another shell create/remove directories and files under
// the watched path. Observe which watchers report events. If native watchers
// (chokidar native + fs.watch) do NOT report events but polling does, then
// your mount doesn't provide inotify and polling is required.

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

const watched = process.argv[2] || '.';
console.log('Watching:', watched);

function prefixLogger(prefix) {
  return (...args) => console.log(new Date().toISOString(), prefix, ...args);
}

// 1) chokidar native watcher (no polling)
const nativeLogger = prefixLogger('[chokidar-native]');
const watcherNative = chokidar.watch(watched, {
  persistent: true,
  ignoreInitial: true,
  usePolling: false,
  depth: 2,
  followSymlinks: false
});

watcherNative
  .on('add', p => nativeLogger('add file', p))
  .on('addDir', p => nativeLogger('add dir', p))
  .on('change', p => nativeLogger('change', p))
  .on('unlink', p => nativeLogger('unlink', p))
  .on('unlinkDir', p => nativeLogger('unlinkDir', p))
  .on('error', e => nativeLogger('error', e && e.message));

// 2) chokidar polling watcher
const pollingLogger = prefixLogger('[chokidar-polling]');
const watcherPolling = chokidar.watch(watched, {
  persistent: true,
  ignoreInitial: true,
  usePolling: true,
  interval: 2000,
  depth: 2,
  followSymlinks: false
});

watcherPolling
  .on('add', p => pollingLogger('add file', p))
  .on('addDir', p => pollingLogger('add dir', p))
  .on('change', p => pollingLogger('change', p))
  .on('unlink', p => pollingLogger('unlink', p))
  .on('unlinkDir', p => pollingLogger('unlinkDir', p))
  .on('error', e => pollingLogger('error', e && e.message));

// 3) fs.watch native
const fsLogger = prefixLogger('[fs.watch]');
try {
  const fsWatcher = fs.watch(watched, { recursive: true }, (eventType, filename) => {
    fsLogger('event', eventType, filename);
  });
  fsWatcher.on('error', (e) => fsLogger('error', e && e.message));
} catch (e) {
  fsLogger('failed to start fs.watch:', e && e.message);
}

console.log('\nInstructions:');
console.log(' - In another terminal, create/remove directories or files under the watched path:');
console.log(`   mkdir -p ${path.join(watched, 'test-dir')}`);
console.log(`   touch ${path.join(watched, 'test-dir', 'file.mkv')}`);
console.log(' - Watch which of the above loggers report events.');
console.log(' - Ctrl+C to exit this script.\n');
