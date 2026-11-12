# Rexify full-server backups

Rexify full backups are encrypted disaster-recovery archives. They include the Rexify source/configuration, `.env`, control-plane SQLite database, every Docker volume, Docker bind-mounted host directories, Docker metadata, and optionally all Docker images.

## Google Drive setup

Install and configure rclone on the host, not inside the repository:

```bash
sudo apt-get update && sudo apt-get install -y rclone
sudo rclone config
```

Create a remote named `gdrive` and test it:

```bash
sudo rclone lsd gdrive:
```

Create a recovery key and store it outside the server. The same key is required for restore:

```bash
sudo install -m 600 /dev/null /root/rexify-backup.key
sudo nano /root/rexify-backup.key
```

Create `/home/ubuntu/rexify/.backup.env` from `.backup.env.example`, then enable the timer:

```bash
sudo cp .backup.env.example .backup.env
sudo chmod 600 .backup.env
sudo ./scripts/install-rexify-backup-timer.sh
```

The timer runs daily around 03:30 server time. It uploads to Google Drive, verifies the remote byte count, and keeps the configured number of remote and local encrypted archives.

## Manual backup

```bash
sudo ./scripts/rexify-backup.sh \
  --to gdrive:rexify-backups \
  --key-file /root/rexify-backup.key \
  --keep-remote 7 \
  --keep-local 1
```

Add `--images` if the server must be recoverable without pulling Docker images from registries. This can create a very large archive.

The dashboard also provides **Settings → Full Server Backups**. The API backup engine uses the same encrypted archive format and can use an rclone destination such as `gdrive:rexify-backups`.

## Complete restore on a new server

Install Docker, rclone, and the Rexify checkout on the new Ubuntu server. Download the encrypted archive and its checksum from Google Drive:

```bash
rclone copy gdrive:rexify-backups /root/rexify-recovery --include '*.tar.gz.age*'
```

Restore while Rexify is stopped:

```bash
sudo ./scripts/rexify-restore.sh \
  /root/rexify-recovery/rexify-full-<host>-<timestamp>.tar.gz.age \
  /root/rexify-backup.key \
  /home/ubuntu/rexify
```

The restore script validates the archive, makes a safety copy of the existing checkout, restores the source and `.env`, recreates Docker volumes, restores their contents, optionally loads saved images, starts Rexify, and checks the API health endpoint.

After changing servers, point DNS records to the new server IP. Existing certificates are restored, but certificate renewal and DNS still depend on the new server being reachable.

## Important recovery rules

- Never store the recovery key only on the Rexify server or in the same Google Drive folder.
- Keep the original `.env` and `COOLIFY_SECRET_KEY`; they are required to decrypt application secrets.
- Do not restore `/var/lib/docker` wholesale. Restore named volumes and recreate containers instead.
- Test a restore before trusting a backup as your only disaster-recovery copy.
