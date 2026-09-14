# Static Site Deployment Flow

A reusable pattern for deploying a static HTML/CSS/JS site via Docker + GitHub Actions to a VPS (e.g. DigitalOcean Droplet), with host nginx as a reverse proxy and Let's Encrypt SSL.

---

## Architecture Overview

```
[GitHub push to main]
        |
        v
[GitHub Actions CI/CD]
   1. Build Docker image (nginx:alpine + static files)
   2. Push image to Docker Hub (tagged :latest + :<sha>)
   3. SSH into VPS
   4. Install/renew Let's Encrypt cert via certbot
   5. Install host nginx config
   6. Pull new image + docker compose up -d
        |
        v
[VPS: Host nginx on 443/80]
   - Handles SSL termination
   - Redirects HTTP -> HTTPS, www -> apex
   - Proxies to Docker container on 127.0.0.1:8081
        |
        v
[Docker container: nginx:alpine on port 8081]
   - Serves static files from /usr/share/nginx/html
   - gzip compression
   - Static asset caching (7d)
```

---

## File Structure to Copy

```
project-root/
  Dockerfile
  docker-compose.yml
  .dockerignore
  deploy/
    nginx.conf          # In-container nginx config (static file serving)
    nginx-host.conf     # Host nginx config (SSL + reverse proxy)
  .github/
    workflows/
      deploy.yml        # GitHub Actions CI/CD pipeline
  site/                 # Your static files go here
    index.html
    ...
```

---

## File Contents

### `Dockerfile`

```dockerfile
FROM nginx:alpine
COPY site/ /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

### `docker-compose.yml`

```yaml
services:
  web:
    image: ${IMAGE_NAME:-yourusername/your-app}:latest
    ports:
      - "8081:80"
    restart: unless-stopped
```

> Change `yourusername/your-app` to your Docker Hub image name. The `IMAGE_NAME` env var overrides it at deploy time.

### `.dockerignore`

```
.git/
.github/
*.md
.DS_Store
.vscode/
```

### `deploy/nginx.conf` (in-container)

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types text/plain text/css text/html application/javascript;
    gzip_min_length 256;

    location ~* \.(css|jpg|jpeg|png|gif|ico|svg|webp)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
```

### `deploy/nginx-host.conf` (on VPS)

Replace `yourdomain.com` with your actual domain.

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # Let's Encrypt ACME challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # Redirect all HTTP to HTTPS
    location / {
        return 301 https://yourdomain.com$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name www.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    return 301 https://yourdomain.com$request_uri;
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass         http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

### `.github/workflows/deploy.yml`

Replace all `yourdomain.com`, `your-app-name`, and `/opt/your-app` placeholders.

```yaml
name: Build and Deploy

on:
  push:
    branches: [main]

env:
  IMAGE_NAME: ${{ secrets.DOCKERHUB_USERNAME }}/your-app-name

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Docker login
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}

      - name: Build and push image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ${{ env.IMAGE_NAME }}:latest
            ${{ env.IMAGE_NAME }}:${{ github.sha }}

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Validate SSH key
        env:
          DROPLET_SSH_KEY: ${{ secrets.DROPLET_SSH_KEY }}
        run: |
          if [[ -z "$DROPLET_SSH_KEY" ]]; then
            echo "ERROR: DROPLET_SSH_KEY is empty"; exit 1
          fi
          KEYFILE=$(mktemp)
          echo "$DROPLET_SSH_KEY" > "$KEYFILE"
          chmod 600 "$KEYFILE"
          grep -q "BEGIN" "$KEYFILE" || { echo "ERROR: malformed key"; exit 1; }
          rm -f "$KEYFILE"

      - name: Copy host nginx config to VPS
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: ${{ secrets.DROPLET_USER }}
          key: ${{ secrets.DROPLET_SSH_KEY }}
          source: deploy/nginx-host.conf
          target: /tmp/your-app-nginx/

      - name: Provision SSL and install nginx config
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: ${{ secrets.DROPLET_USER }}
          key: ${{ secrets.DROPLET_SSH_KEY }}
          envs: CERTBOT_EMAIL
          script: |
            set -e

            if ! command -v certbot &> /dev/null; then
              apt-get update -q
              apt-get install -y certbot python3-certbot-nginx
            fi

            mkdir -p /var/www/certbot
            CERT_PATH=/etc/letsencrypt/live/yourdomain.com/fullchain.pem

            if [ ! -f "$CERT_PATH" ]; then
              # Bootstrap: HTTP-only config so ACME challenge can complete
              cat > /etc/nginx/sites-available/yourdomain.com << 'NGINX'
            server {
                listen 80;
                server_name yourdomain.com www.yourdomain.com;
                location /.well-known/acme-challenge/ { root /var/www/certbot; }
                location / { proxy_pass http://127.0.0.1:8081; }
            }
            NGINX
              ln -sf /etc/nginx/sites-available/yourdomain.com /etc/nginx/sites-enabled/yourdomain.com
              nginx -t && systemctl reload nginx

              if host yourdomain.com > /dev/null 2>&1; then
                certbot certonly --webroot \
                  -w /var/www/certbot \
                  -d yourdomain.com -d www.yourdomain.com \
                  --email "$CERTBOT_EMAIL" \
                  --agree-tos --non-interactive
              else
                echo "WARNING: DNS not resolving yet. Re-run after DNS propagates."
              fi
            else
              certbot renew --quiet --no-random-sleep-on-renew
            fi

            if [ -f "$CERT_PATH" ]; then
              cp /tmp/your-app-nginx/deploy/nginx-host.conf /etc/nginx/sites-available/yourdomain.com
            fi
            ln -sf /etc/nginx/sites-available/yourdomain.com /etc/nginx/sites-enabled/yourdomain.com
            nginx -t && systemctl reload nginx
        env:
          CERTBOT_EMAIL: ${{ secrets.CERTBOT_EMAIL }}

      - name: Deploy container to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: ${{ secrets.DROPLET_USER }}
          key: ${{ secrets.DROPLET_SSH_KEY }}
          envs: IMAGE_NAME
          script: |
            set -e
            mkdir -p /opt/your-app
            cd /opt/your-app

            cat > docker-compose.yml << COMPOSE
            services:
              web:
                image: ${IMAGE_NAME}:latest
                ports:
                  - "8081:80"
                restart: unless-stopped
            COMPOSE

            docker compose down --remove-orphans || true
            fuser -k 8081/tcp 2>/dev/null || true
            sleep 1

            docker pull ${IMAGE_NAME}:latest
            docker compose up -d
            docker image prune -f

            echo "Deploy complete at $(date -u)"
```

---

## GitHub Secrets Required

Set these in your repo under **Settings > Secrets and variables > Actions**:

| Secret | Description |
|---|---|
| `DOCKERHUB_USERNAME` | Your Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub access token (not your password) |
| `DROPLET_HOST` | VPS public IP address |
| `DROPLET_USER` | SSH username (e.g. `root`) |
| `DROPLET_SSH_KEY` | Private SSH key (full PEM content, including headers) |
| `CERTBOT_EMAIL` | Email for Let's Encrypt cert registration |

---

## VPS Prerequisites

The target server needs:

- Ubuntu/Debian (or similar apt-based distro)
- `nginx` installed and running (`apt install nginx`)
- `docker` installed and running
- `docker compose` (v2, included with Docker Engine)
- Your SSH public key in `~/.ssh/authorized_keys`
- Port 80 and 443 open in firewall

---

## First-Time Setup Notes

1. **DNS**: Point your domain's A record to the VPS IP before running the workflow for the first time. The SSL provisioning step checks DNS before requesting a cert.
2. **nginx default site**: Remove or disable the default nginx site (`/etc/nginx/sites-enabled/default`) on the VPS to avoid conflicts.
3. **SSH key**: Generate a dedicated deploy key (`ssh-keygen -t ed25519 -C "deploy"`). Add the public key to the VPS and the private key to GitHub Secrets.
4. **Docker Hub token**: Create a read/write token at hub.docker.com under Account Settings > Security.

---

## How It Works: Step by Step

1. **Push to `main`** triggers the workflow.
2. **`build-and-push` job**: Checks out code, logs into Docker Hub, builds the image from `Dockerfile`, pushes two tags (`:latest` and `:<git-sha>`).
3. **`deploy` job** (runs after build succeeds):
   - Validates the SSH private key is well-formed.
   - SCPs `deploy/nginx-host.conf` to the VPS.
   - SSHes in to install/renew the Let's Encrypt cert and reload nginx.
   - SSHes in again to write `docker-compose.yml`, pull the new image, restart the container, and prune old images.

---

## Customizing for a New Project

1. Copy the file structure above.
2. Replace all occurrences of:
   - `yourdomain.com` / `www.yourdomain.com`
   - `your-app-name` (Docker Hub image name)
   - `/opt/your-app` (deploy directory on VPS)
   - `8081` (host port, if another app already uses it — pick a different port)
3. Put your static files in `site/`.
4. Add GitHub Secrets.
5. Push to `main`.

---

## Claude Code Integration Suggestions

### 1. `CLAUDE.md` — Project Instructions

Add a `CLAUDE.md` at the project root so Claude Code automatically picks up project context:

```markdown
# Project

Static site for [description]. Deployed via Docker + GitHub Actions to runvaders.com.

## Deployment

- Push to `main` triggers automatic deploy via `.github/workflows/deploy.yml`
- Docker image: `DOCKERHUB_USERNAME/your-app-name`
- Live at: https://yourdomain.com

## Site files

All site content lives in `site/`. No build step — plain HTML/CSS/JS.

## Do not

- Do not add a build system unless explicitly asked.
- Do not modify `deploy/nginx-host.conf` without confirming SSL impact.
```

### 2. Memory File — Deployment Context

Add a `memory/deployment.md` in your Claude project memory so it persists across sessions:

```markdown
# Deployment

- Platform: DigitalOcean Droplet, Ubuntu
- Container port: 8081 (host) -> 80 (container)
- Deploy path: /opt/your-app
- Docker Hub image: yourusername/your-app
- Host: yourdomain.com (SSL via Let's Encrypt / certbot)
- Triggered by: push to main branch
- Secrets: DOCKERHUB_USERNAME, DOCKERHUB_TOKEN, DROPLET_HOST, DROPLET_USER, DROPLET_SSH_KEY, CERTBOT_EMAIL
```

### 3. Ask Claude to Diagnose Deployment Failures

When a deploy fails, paste the GitHub Actions log and ask:

> "The deploy job failed. Here is the log: [paste]. What went wrong and how do I fix it?"

Claude can parse SSH errors, Docker pull failures, nginx config test errors, and certbot DNS issues effectively.

### 4. Ask Claude to Adapt This Pattern

When starting a new project, open Claude Code in the new repo and say:

> "I have a deployment pattern in my other project. Apply it here — my domain is newdomain.com, Docker Hub image is myuser/new-app, VPS port is 8082."

With `CLAUDE.md` and memory files in place, Claude will have the context to adapt the files without re-explaining the architecture.

### 5. Git Hook: Pre-push Reminder

Add `.claude/commands/predeploy-check.md` as a custom slash command to run before pushing:

```markdown
Check that:
1. All HTML files in site/ are valid (no unclosed tags, broken links to local assets).
2. docker-compose.yml image name matches the IMAGE_NAME in deploy.yml.
3. nginx-host.conf domain matches the domain in the certbot step of deploy.yml.
Report any mismatches.
```

Then run `/predeploy-check` in Claude Code before pushing to catch config drift.
