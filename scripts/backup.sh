#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TIMESTAMP="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
BACKUP_DIR="backups/$TIMESTAMP"

mkdir -p "$BACKUP_DIR"

if [[ ! -f data/lituus.sqlite ]]; then
  echo "SQLite database not found at data/lituus.sqlite" >&2
  exit 1
fi

sqlite3 data/lituus.sqlite ".backup '$BACKUP_DIR/lituus.sqlite'"
tar -czf "$BACKUP_DIR/recordings.tar.gz" recordings
find backups -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +

echo "Backup written to $BACKUP_DIR"
