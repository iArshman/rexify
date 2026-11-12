#!/usr/bin/env bash
set -Eeuo pipefail

# Full Rexify disaster-recovery backup. Run as root from the Rexify checkout.
# Required: openssl, docker. Optional for off-site upload: rclone.
# Example:
#   sudo ./scripts/rexify-backup.sh --to gdrive:rexify-backups --key-file /root/rexify.key --keep-remote 7

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${REXIFY_BACKUP_OUTPUT:-$REPO_DIR/backups}"
DEST=""
KEY_FILE="${REXIFY_BACKUP_KEY_FILE:-}"
KEEP_REMOTE="${REXIFY_BACKUP_KEEP_REMOTE:-7}"
KEEP_LOCAL="${REXIFY_BACKUP_KEEP_LOCAL:-1}"
INCLUDE_IMAGES=0
VOLUME_IMAGE="${REXIFY_BACKUP_VOLUME_IMAGE:-alpine:3.19}"
RCLONE_CONFIG_FILE="${RCLONE_CONFIG_FILE:-/root/.config/rclone/rclone.conf}"
RCLONE_SERVICE_ACCOUNT_FILE="${RCLONE_SERVICE_ACCOUNT_FILE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to) DEST="$2"; shift 2;;
    --key-file) KEY_FILE="$2"; shift 2;;
    --output) OUTPUT_DIR="$2"; shift 2;;
    --keep-remote) KEEP_REMOTE="$2"; shift 2;;
    --keep-local) KEEP_LOCAL="$2"; shift 2;;
    --images) INCLUDE_IMAGES=1; shift;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done

[[ "$(id -u)" == 0 ]] || { echo "Run as root." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required." >&2; exit 1; }
command -v openssl >/dev/null || { echo "OpenSSL is required." >&2; exit 1; }
[[ -n "$KEY_FILE" && -r "$KEY_FILE" ]] || { echo "Provide a recovery key with --key-file. Keep it outside the server." >&2; exit 1; }
mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

HOST="$(hostname -s)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="rexify-full-${HOST}-${STAMP}"
WORK="$(mktemp -d /tmp/rexify-backup.XXXXXX)"
STAGE="$WORK/stage"
ARCHIVE="$OUTPUT_DIR/$NAME.tar.gz"
ENCRYPTED="$OUTPUT_DIR/$NAME.tar.gz.age"
LOCK="/var/lock/rexify-full-backup.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "Another Rexify backup is running." >&2; exit 1; }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$STAGE/control-plane" "$STAGE/volumes" "$STAGE/docker-metadata" "$STAGE/rexify-source"

# Preserve the off-site storage credentials inside the encrypted archive. Keep
# an external copy too: they are needed to download the archive before restore.
mkdir -p "$STAGE/credentials/rclone"
if [[ -f "$RCLONE_CONFIG_FILE" ]]; then
  install -m 600 "$RCLONE_CONFIG_FILE" "$STAGE/credentials/rclone/rclone.conf"
fi
if [[ -n "$RCLONE_SERVICE_ACCOUNT_FILE" && -f "$RCLONE_SERVICE_ACCOUNT_FILE" ]]; then
  install -m 600 "$RCLONE_SERVICE_ACCOUNT_FILE" "$STAGE/credentials/rclone/service-account.json"
fi

# Copy the installation, excluding generated dependency/build folders and old backups.
tar -C "$REPO_DIR" --exclude=node_modules --exclude=.git --exclude=build --exclude=backups -cf - . | tar -C "$STAGE/rexify-source" -xf -

# Preserve the exact runtime environment, including the secret key.
[[ -f "$REPO_DIR/.env" ]] && install -m 600 "$REPO_DIR/.env" "$STAGE/rexify-source/.env"

# Native consistent SQLite copy where available.
if [[ -f /var/lib/docker/volumes/coolify-db/_data/prod.db ]]; then
  sqlite3 /var/lib/docker/volumes/coolify-db/_data/prod.db ".backup '$STAGE/control-plane/prod.db'"
elif [[ -f "$REPO_DIR/../db/prod.db" ]]; then
  sqlite3 "$REPO_DIR/../db/prod.db" ".backup '$STAGE/control-plane/prod.db'"
fi

# Docker metadata makes the restore auditable and helps rebuild images/networks.
docker ps -a --no-trunc --format '{{json .}}' > "$STAGE/docker-metadata/containers.json" || true
docker volume ls --format '{{json .}}' > "$STAGE/docker-metadata/volumes.json" || true
docker network ls --format '{{json .}}' > "$STAGE/docker-metadata/networks.json" || true
docker image ls --no-trunc --format '{{json .}}' > "$STAGE/docker-metadata/images.json" || true
docker compose -f "$REPO_DIR/docker-compose.yaml" config > "$STAGE/docker-metadata/rexify-compose.rendered.yaml" 2>/dev/null || true

mapfile -t VOLUMES < <(docker volume ls --format '{{.Name}}' | sed '/^$/d' | sort)
for volume in "${VOLUMES[@]}"; do
  [[ "$volume" =~ ^[a-zA-Z0-9_.-]+$ ]] || continue
  echo "Archiving Docker volume: $volume"
  docker run --rm -v "$volume:/volume:ro" -v "$STAGE:/out" "$VOLUME_IMAGE" \
    sh -c "tar czf /out/volumes/${volume}.tar.gz -C /volume ."
done
printf '%s\n' "${VOLUMES[@]}" > "$STAGE/volumes.list"

# Named volumes do not cover bind-mounted application data. Capture every
# bind source referenced by a Docker container and retain its original path.
mkdir -p "$STAGE/bind-mounts"
: > "$STAGE/bind-mounts.list"
mapfile -t BIND_SOURCES < <(docker ps -aq | while read -r cid; do docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' "$cid" 2>/dev/null || true; done | sort -u)
for source in "${BIND_SOURCES[@]}"; do
  [[ -d "$source" || -f "$source" ]] || continue
  id="$(printf '%s' "$source" | sha256sum | cut -c1-16)"
  echo "Archiving bind mount: $source"
  tar -C "$(dirname "$source")" -czf "$STAGE/bind-mounts/$id.tar.gz" "$(basename "$source")"
  printf '%s\t%s\n' "$source" "$id.tar.gz" >> "$STAGE/bind-mounts.list"
done

if [[ "$INCLUDE_IMAGES" == 1 ]]; then
  echo "Saving Docker images (this may be large)..."
  mapfile -t IMAGES < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -v '^<none>:' | sort -u)
  ((${#IMAGES[@]})) && docker save "${IMAGES[@]}" | gzip -1 > "$STAGE/docker-images.tar.gz"
fi

cat > "$STAGE/manifest.json" <<EOF
{
  "formatVersion": 1,
  "product": "rexify",
  "rexifyVersion": "3.12.39",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hostname": "$(printf '%s' "$HOST" | sed 's/"/\\"/g')",
  "sourceDirectory": "$REPO_DIR",
  "encrypted": true,
  "volumes": $(printf '%s\n' "${VOLUMES[@]}" | python3 -c 'import json,sys; print(json.dumps([x.strip() for x in sys.stdin if x.strip()]))'),
  "imagesIncluded": $([[ "$INCLUDE_IMAGES" == 1 ]] && echo true || echo false),
  "bindMountsIncluded": true
}
EOF

sha256sum "$STAGE/manifest.json" > "$STAGE/manifest.sha256"
tar -czf "$ARCHIVE" -C "$STAGE" .
openssl enc -aes-256-cbc -pbkdf2 -iter 310000 -salt -in "$ARCHIVE" -out "$ENCRYPTED" -pass "file:$KEY_FILE"
rm -f "$ARCHIVE"
sha256sum "$ENCRYPTED" > "$ENCRYPTED.sha256"
chmod 600 "$ENCRYPTED" "$ENCRYPTED.sha256"

if [[ -n "$DEST" ]]; then
  command -v rclone >/dev/null || { echo "rclone is required for --to $DEST" >&2; exit 1; }
  echo "Uploading and verifying: $DEST/$NAME.tar.gz.age"
  rclone copyto "$ENCRYPTED" "${DEST%/}/$NAME.tar.gz.age" --retries 5 --low-level-retries 20
  LOCAL_SIZE="$(stat -c '%s' "$ENCRYPTED")"
  REMOTE_SIZE="$(rclone size "${DEST%/}/$NAME.tar.gz.age" --json | python3 -c 'import json,sys; print(int(json.load(sys.stdin).get("bytes",0)))')"
  [[ "$LOCAL_SIZE" == "$REMOTE_SIZE" ]] || { echo "Remote verification failed: $LOCAL_SIZE != $REMOTE_SIZE" >&2; exit 1; }
  rclone copyto "$ENCRYPTED.sha256" "${DEST%/}/$NAME.tar.gz.age.sha256" --retries 5 --low-level-retries 20
  mapfile -t REMOTE_FILES < <(rclone lsf "$DEST" --files-only | grep -E '\.tar\.gz\.age$' | sort -r || true)
  if (( KEEP_REMOTE > 0 )); then
    for old in "${REMOTE_FILES[@]:$KEEP_REMOTE}"; do rclone deletefile "${DEST%/}/$old" || true; rclone deletefile "${DEST%/}/$old.sha256" || true; done
  fi
fi

if [[ -n "$DEST" && "$KEEP_LOCAL" -eq 0 ]]; then
  rm -f "$ENCRYPTED" "$ENCRYPTED.sha256"
elif [[ -n "$DEST" ]]; then
  mapfile -t LOCAL_FILES < <(find "$OUTPUT_DIR" -maxdepth 1 -type f -name 'rexify-full-*.tar.gz.age' -printf '%f\n' | sort -r)
  for old in "${LOCAL_FILES[@]:$KEEP_LOCAL}"; do rm -f "$OUTPUT_DIR/$old" "$OUTPUT_DIR/$old.sha256"; done
fi

echo "Backup complete: $ENCRYPTED"
[[ -n "$DEST" ]] && echo "Verified remote copy: ${DEST%/}/$NAME.tar.gz.age"
