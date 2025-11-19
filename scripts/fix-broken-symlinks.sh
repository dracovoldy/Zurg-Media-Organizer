#!/usr/bin/env bash
# fix-broken-symlinks.sh
# Scan a library directory for broken symlinks and attempt a safe fix:
# If a broken symlink points to /path/to/dir/file.ext but the actual existing
# file is at /path/to/dir.ext/file.ext (i.e. the directory needs the file
# extension appended), this script will recreate the symlink to point at the
# candidate path. It verifies the candidate exists before changing anything,
# and can run in dry-run mode by default.

set -euo pipefail
IFS=$'\n\t'

# Defaults
LIB_DIR="/mnt/library/unrated"
APPLY=0
VERBOSE=1

usage() {
  cat <<EOF
Usage: $0 [--apply] [--dir DIR] [--quiet]

--apply      Actually modify symlinks. Without this flag the script runs in dry-run mode.
--dir DIR    Directory to scan (default: /mnt/library/unrated)
--quiet      Minimize output
--help       Show this help

Example (dry-run):
  $0 --dir /mnt/library/unrated

Example (apply changes):
  $0 --apply --dir /mnt/library/unrated
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift;;
    --dir) LIB_DIR="$2"; shift 2;;
    --quiet) VERBOSE=0; shift;;
    --help) usage; exit 0;;
    -h) usage; exit 0;;
    *) echo "Unknown arg: $1"; usage; exit 2;;
  esac
done

log() {
  if [[ $VERBOSE -ne 0 ]]; then
    echo "$@"
  fi
}

if [[ ! -d "$LIB_DIR" ]]; then
  echo "Directory not found: $LIB_DIR" >&2
  exit 3
fi

# Find broken symlinks under LIB_DIR
# We'll use find to get symlink paths (null-separated) and then process each
# with a while-read loop so filenames with weird chars are handled safely.

find "$LIB_DIR" -type l ! -exec test -e {} \; -print0 |
  while IFS= read -r -d '' symlink; do
    # Get stored link target (as written in the symlink)
    orig_target=$(readlink "$symlink") || continue

    # Compute an absolute candidate path for the target (even if orig_target
    # is relative). We won't require existence yet.
    if [[ "$orig_target" = /* ]]; then
      abs_target="$orig_target"
    else
      # Resolve relative to the symlink's directory (do not require file to exist)
      symlink_dir=$(dirname "$symlink")
      # readlink -m will canonicalize the path without failing on missing components
      abs_target=$(readlink -m "$symlink_dir/$orig_target")
    fi

    target_base=$(basename "$abs_target")
    target_dir=$(dirname "$abs_target")

    # Only consider targets with an extension (like .mkv, .mp4)
    if [[ "$target_base" != *.* ]]; then
      log "Skipping (no extension): $symlink -> $orig_target"
      continue
    fi

    ext="${target_base##*.}"
    # Skip weird extensions
    if [[ -z "$ext" ]]; then
      log "Skipping (empty extension): $symlink -> $orig_target"
      continue
    fi

    # Build a candidate directory by appending the extension to the dirname
    candidate_dir="$target_dir.$ext"
    candidate_path="$candidate_dir/$target_base"

    # If candidate exists, attempt to swap the symlink to point to it.
    if [[ -e "$candidate_path" ]]; then
      log "Candidate exists: $symlink -> $candidate_path"

      if [[ $APPLY -eq 0 ]]; then
        log "DRY-RUN: would update symlink: $symlink\n  orig -> $orig_target\n  new  -> $candidate_path"
        continue
      fi

      # Perform a safe replace:
      # 1) create a temporary symlink next to the original
      # 2) move it over the original atomically
      tmp="${symlink}.tmp.$$"
      if ln -s -- "$candidate_path" "$tmp"; then
        if mv -T -- "$tmp" "$symlink"; then
          # verify it's now valid
          if [[ -e "$symlink" ]]; then
            log "UPDATED: $symlink -> $candidate_path"
          else
            # Revert: recreate original symlink
            rm -f -- "$symlink"
            ln -s -- "$orig_target" "$symlink"
            echo "Failed to fix (reverted): $symlink" >&2
          fi
        else
          rm -f -- "$tmp"
          echo "Failed to move temp symlink into place: $symlink" >&2
        fi
      else
        echo "Failed to create temp symlink: $tmp -> $candidate_path" >&2
      fi
    else
      log "No candidate: $symlink -> $orig_target (tested $candidate_path)"
    fi

  done

log "Done scanning $LIB_DIR"

# Exit status: 0 even if nothing changed; errors printed to stderr for failures.
exit 0
