#!/usr/bin/env bash
# Restore a selected sqlite backup from prisma/*.db.bak
set -euo pipefail
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

print_backups() {
  echo "Available backups in prisma/ (most recent first):"
  ls -1t prisma/*.db.bak 2>/dev/null || echo "  (no .db.bak files found)"
}

if [ "${1:-}" = "--list" ] || [ "${1:-}" = "-l" ]; then
  print_backups
  exit 0
fi

backups=(prisma/*.db.bak)
if [ ! -e "${backups[0]}" ]; then
  echo "No backup files found in prisma/ (*.db.bak)"
  exit 1
fi

echo "Select a backup to restore:" 
index=1
declare -a files
for f in prisma/*.db.bak; do
  printf "  %2d) %s\n" "$index" "$(basename "$f")"
  files+=("$f")
  index=$((index+1))
done

while true; do
  read -rp "Enter number (or q to quit): " sel
  if [[ "$sel" =~ ^[Qq]$ ]]; then
    echo "Aborted."
    exit 0
  fi
  if ! [[ "$sel" =~ ^[0-9]+$ ]]; then
    echo "Please enter a valid number.";
    continue
  fi
  sel_i=$((sel-1))
  if [ "$sel_i" -lt 0 ] || [ "$sel_i" -ge "${#files[@]}" ]; then
    echo "Number out of range.";
    continue
  fi
  chosen="${files[$sel_i]}"
  break
done

base=$(basename "$chosen")
if [[ "$base" == dev.* ]]; then
  target="prisma/dev.db"
elif [[ "$base" == test.* ]]; then
  target="prisma/test.db"
else
  # fallback: ask user
  read -rp "Cannot infer target DB from filename. Restore to which path? (default prisma/dev.db) " target_input
  target=${target_input:-prisma/dev.db}
fi

echo "Selected: $chosen -> $target"
read -rp "Are you sure you want to overwrite '$target' with this backup? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted.";
  exit 0
fi

cp -v "$chosen" "$target"
echo "Restore complete. ls -l $target:" 
ls -l "$target"
