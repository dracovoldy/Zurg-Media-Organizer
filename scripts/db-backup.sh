#!/usr/bin/env bash
# Backup prisma sqlite DB files with timestamp
set -euo pipefail
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

timestamp=$(date +%Y%m%d%H%M%S)
if [ -f prisma/dev.db ]; then
  cp prisma/dev.db prisma/dev.$timestamp.db.bak
  echo "Backed up prisma/dev.db -> prisma/dev.$timestamp.db.bak"
else
  echo "No prisma/dev.db found"
fi

if [ -f prisma/test.db ]; then
  cp prisma/test.db prisma/test.$timestamp.db.bak
  echo "Backed up prisma/test.db -> prisma/test.$timestamp.db.bak"
else
  echo "No prisma/test.db found"
fi

ls -l prisma
