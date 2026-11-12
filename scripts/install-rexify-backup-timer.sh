#!/usr/bin/env bash
set -Eeuo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.backup.env"
[[ "$(id -u)" == 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Create $ENV_FILE first; see .backup.env.example." >&2; exit 1; }
install -m 0644 "$REPO_DIR/scripts/rexify-backup.service" /etc/systemd/system/rexify-backup.service
install -m 0644 "$REPO_DIR/scripts/rexify-backup.timer" /etc/systemd/system/rexify-backup.timer
systemctl daemon-reload
systemctl enable --now rexify-backup.timer
systemctl list-timers rexify-backup.timer
