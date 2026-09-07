#!/usr/bin/env bash
# Restore a local custom-format archive, an R2 object, or the latest R2 .dump.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node packages/backend/config/db/backup.js restore "$@"
