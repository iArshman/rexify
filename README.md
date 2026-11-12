# Rexify

An open-source & self-hostable Heroku / Netlify alternative.
Forked from coolify v3.
---

## Installation (3 simple steps!)

### Step 1: Clone the repository
```bash
git clone https://github.com/iArshman/rexify.git
cd rexify
```

### Step 2: Run the setup script
```bash
sudo bash ./install.sh
```

That's it! The script will:
- Install Docker (if needed)
- Build your custom Docker image locally
- Create `.env` configuration
- Start Rexify on `http://localhost:3000`

### Step 3: Access Rexify
Open your browser and go to: **http://localhost:3000**

---

---

## Common Commands

**View logs:**
```bash
docker compose logs -f
```

**Stop Rexify:**
```bash
docker compose down
```

**Start Rexify (after stopped):**
```bash
docker compose up -d
```

**Restart Rexify:**
```bash
docker compose restart
```

**Check running containers:**
```bash
docker ps
```

## Full server backups

Rexify includes encrypted disaster-recovery backups for Google Drive and other rclone destinations. See [docs/full-backups.md](docs/full-backups.md) for setup, scheduling, verification, and restoring onto a new server.

---

## Updating Your Code

After making code changes:

1. Stop the running service:
   ```bash
   docker compose down
   ```

2. Run setup again (it will rebuild):
   ```bash
   sudo bash ./install.sh
   ```

Or rebuild and restart manually:
```bash
docker build -t coolify:latest .
docker compose up -d
```

---

## Environment Variables

Edit `.env` file to change configuration:

```bash
COOLIFY_APP_ID=your-unique-id
COOLIFY_SECRET_KEY=your-secret-key
COOLIFY_LOG_LEVEL=info
TAG=latest
```

---

## Troubleshooting

**Port 3000 already in use?**
```bash
# Change port in docker-compose.yaml
# Find the line:  published: 3000
# Change to:      published: 8080  (or any other port)
# Then restart: docker compose restart
```

**Database errors?**
```bash
# Reset the database
docker volume rm coolify-db
docker compose restart
```

**Need to see full logs?**
```bash
docker compose logs --tail=100 -f coolify
```

---

