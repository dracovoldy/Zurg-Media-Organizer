#!/usr/bin/env bash
# Helper to backup and reset the Prisma SQLite DB
# Usage: ./scripts/db-reset.sh [--seed]
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
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

# Generate client and reset DB
npx prisma generate
if [ "$1" = "--seed" ] 2>/dev/null; then
  npx prisma migrate reset --force
  npm run seed
else
  npx prisma migrate reset --force --skip-seed
fi

ls -l prisma
