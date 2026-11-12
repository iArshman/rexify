#!/usr/bin/env bash
set -Eeuo pipefail

# Full Rexify restore. Run as root on a new server with Docker installed.
# Usage:
#   sudo ./scripts/rexify-restore.sh /path/backup.tar.gz.age /root/rexify.key /home/ubuntu/rexify
# Or download the newest remote backup first with rclone.

BACKUP="${1:-}"
KEY_FILE="${2:-${REXIFY_BACKUP_KEY_FILE:-}}"
REPO_DIR="${3:-${REXIFY_REPO_DIR:-/home/ubuntu/rexify}}"
VOLUME_IMAGE="${REXIFY_BACKUP_VOLUME_IMAGE:-alpine:3.19}"

[[ "$(id -u)" == 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ -f "$BACKUP" ]] || { echo "Backup file not found: $BACKUP" >&2; exit 1; }
[[ -r "$KEY_FILE" ]] || { echo "Recovery key file not found/readable: $KEY_FILE" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required." >&2; exit 1; }
command -v openssl >/dev/null || { echo "OpenSSL is required." >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required." >&2; exit 1; }

WORK="$(mktemp -d /tmp/rexify-restore.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
PLAIN="$WORK/backup.tar.gz"
EXTRACT="$WORK/extracted"
mkdir -p "$EXTRACT"

if [[ -f "$BACKUP.sha256" ]]; then
  (cd "$(dirname "$BACKUP")" && sha256sum -c "$(basename "$BACKUP").sha256")
fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 310000 -in "$BACKUP" -out "$PLAIN" -pass "file:$KEY_FILE"
mkdir -p "$EXTRACT"
tar -xzf "$PLAIN" -C "$EXTRACT"
python3 - <<PY
import json, pathlib
m=json.loads(pathlib.Path('$EXTRACT/manifest.json').read_text())
assert m.get('product') == 'rexify', 'Not a Rexify backup'
assert m.get('formatVersion') == 1, 'Unsupported backup format'
print('Validated Rexify backup from', m.get('createdAt'), 'with', len(m.get('volumes', [])), 'volumes')
PY

read -r -p "This will replace Rexify state and Docker volumes on $REPO_DIR. Continue? [y/N] " answer
[[ "$answer" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

mkdir -p "$REPO_DIR"
SAFETY="$REPO_DIR/rexify-restore-safety-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$SAFETY"
if [[ -d "$REPO_DIR" ]]; then
  tar -C "$REPO_DIR" --exclude='rexify-restore-safety-*' -czf "$SAFETY/repository.tar.gz" . 2>/dev/null || true
fi

docker compose -f "$REPO_DIR/docker-compose.yaml" down 2>/dev/null || true

# Restore the repository first so compose and the .env are present.
tar -C "$REPO_DIR" --exclude=.git -xf <(tar -C "$EXTRACT/rexify-source" -cf - .)

# Restore bind-mounted host paths captured from deployed containers.
if [[ -f "$EXTRACT/bind-mounts.list" ]]; then
  while IFS=$'\t' read -r source archive; do
    [[ -n "$source" && -f "$EXTRACT/bind-mounts/$archive" ]] || continue
    [[ "$source" != "/" ]] || continue
    if [[ -e "$source" ]]; then
      mv "$source" "${source}.rexify-old-$(date +%s)"
    fi
    mkdir -p "$(dirname "$source")"
    tar -xzf "$EXTRACT/bind-mounts/$archive" -C "$(dirname "$source")"
  done < "$EXTRACT/bind-mounts.list"
fi

# Restore every volume into a newly-created volume. Existing volumes are renamed
# so a failed restore can be recovered manually.
mapfile -t VOLUMES < "$EXTRACT/volumes.list"
for volume in "${VOLUMES[@]}"; do
  [[ -z "$volume" ]] && continue
  archive="$EXTRACT/volumes/${volume}.tar.gz"
  [[ -f "$archive" ]] || continue
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    old="${volume}.rexify-old-$(date +%s)"
    docker volume create "$old" >/dev/null
    docker run --rm -v "$volume:/src:ro" -v "$old:/dst" "$VOLUME_IMAGE" sh -c 'cp -a /src/. /dst/'
    docker volume rm "$volume" >/dev/null
  fi
  docker volume create "$volume" >/dev/null
  docker run --rm -v "$volume:/volume" -v "$EXTRACT:/backup:ro" "$VOLUME_IMAGE" sh -c "tar xzf /backup/volumes/${volume}.tar.gz -C /volume"
done

if [[ -f "$EXTRACT/docker-images.tar.gz" ]]; then
  echo "Loading saved Docker images..."
  gunzip -c "$EXTRACT/docker-images.tar.gz" | docker load
fi

# Ensure the expected network and external volumes exist before compose starts.
docker network create --attachable coolify-infra 2>/dev/null || true
for volume in coolify-local-backup coolify-db coolify-logs coolify-ssl-certs coolify-letsencrypt coolify-traefik-letsencrypt; do
  docker volume inspect "$volume" >/dev/null 2>&1 || docker volume create "$volume" >/dev/null
done

docker compose -f "$REPO_DIR/docker-compose.yaml" up -d --build
sleep 10
curl --fail --silent --show-error http://127.0.0.1:3000/api/v1/undead >/dev/null

echo "Restore complete. Rexify is running from $REPO_DIR."
echo "Safety copy retained at $SAFETY"
