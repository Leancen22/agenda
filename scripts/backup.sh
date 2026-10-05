#!/usr/bin/env bash
# Copia data.json con fecha y conserva las últimas 30 copias.
# Uso: scripts/backup.sh [DATA_DIR] [BACKUP_DIR]
set -euo pipefail
DATA_DIR="${1:-${DATA_DIR:-$(dirname "$0")/../data}}"
BACKUP_DIR="${2:-${BACKUP_DIR:-$HOME/agenda-backups}}"
SRC="$DATA_DIR/data.json"
[ -f "$SRC" ] || { echo "No existe $SRC" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
cp "$SRC" "$BACKUP_DIR/data-$(date +%Y%m%d-%H%M%S).json"
ls -1t "$BACKUP_DIR"/data-*.json | tail -n +31 | xargs -r rm --
