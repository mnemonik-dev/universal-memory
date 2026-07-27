# Deploying Universal Memory Hub to a VPS

Step-by-step guide for deploying `memory-hub` on a Hetzner (or any Debian/Ubuntu) VPS
with Docker Compose, nginx reverse proxy, and Let's Encrypt HTTPS.

## Prerequisites

- VPS with Ubuntu 22.04+ (or Debian 12+)
- Docker Engine + Docker Compose v2 installed
  ```bash
  # Docker install (if not already present)
  curl -fsSL https://get.docker.com | sh
  ```
- A domain with a DNS A-record pointing `memory.yourdomain.com` to the VPS IP
- nginx + certbot installed on the VPS
  ```bash
  apt-get install -y nginx certbot python3-certbot-nginx
  ```

## 1. Clone the repository

```bash
git clone https://github.com/mnemonik-dev/universal-memory.git /opt/universal-memory
cd /opt/universal-memory
```

## 2. Configure environment variables

```bash
cp .env.example .env
$EDITOR .env
```

Required values to fill in:

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | Strong random password (e.g. `openssl rand -hex 32`) |
| `MEMORY_API_KEY` | Bearer token for API auth (e.g. `openssl rand -hex 32`) |
| `OPENAI_API_KEY` | (or another LLM key) — enables semantic search + synthesis |

All other variables have working defaults. See `.env.example` for full reference.

## 3. Start the services

```bash
docker compose up memory-hub postgres -d
```

Verify both containers are healthy:

```bash
docker compose ps
# memory-hub   Up (healthy)
# postgres     Up (healthy)
```

Check memory-hub logs:

```bash
docker compose logs memory-hub --tail 20
```

Expected output: `memory-hub started on port 3456 (cloud mode)` (or similar startup line).

## 4. Configure nginx

```bash
# Replace the placeholder domain in the nginx config
sed -i 's/memory\.yourdomain\.com/memory.YOUR_ACTUAL_DOMAIN.com/g' nginx/memory.conf

# Enable the site
ln -s /opt/universal-memory/nginx/memory.conf /etc/nginx/sites-enabled/memory.conf
```

Add the rate-limiting zone to `/etc/nginx/nginx.conf` inside the `http {}` block:

```nginx
http {
    # ... existing config ...
    limit_req_zone $binary_remote_addr zone=memory_api:10m rate=30r/m;
}
```

Create the secrets file that nginx includes (never committed to git):

```bash
# Generate and store the API key for nginx
echo "set \$memory_api_key \"$(grep MEMORY_API_KEY /opt/universal-memory/.env | cut -d= -f2)\";" \
  > /etc/nginx/memory-secrets.conf
chmod 600 /etc/nginx/memory-secrets.conf
```

Test the nginx config:

```bash
nginx -t
```

## 5. Obtain an HTTPS certificate

```bash
certbot --nginx -d memory.YOUR_ACTUAL_DOMAIN.com
```

Certbot will automatically modify the nginx config to add TLS.

Reload nginx:

```bash
systemctl reload nginx
```

## 6. Verify the deployment

**Health check (no auth required):**

```bash
curl https://memory.YOUR_ACTUAL_DOMAIN.com/health
# {"status":"ok","transport":"http"}
```

**Auth rejection (401 expected):**

```bash
curl -s -o /dev/null -w "%{http_code}" https://memory.YOUR_ACTUAL_DOMAIN.com/mcp
# 401
```

**Authenticated MCP endpoint:**

```bash
export MEMORY_API_KEY="$(grep MEMORY_API_KEY /opt/universal-memory/.env | cut -d= -f2)"
curl -H "Authorization: Bearer $MEMORY_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
     https://memory.YOUR_ACTUAL_DOMAIN.com/mcp
```

Expected response: JSON with 7 tools listed: `memory_capture`, `memory_search`,
`memory_think`, `memory_sign`, `memory_verify`, `memory_list`, `memory_delete`.

## 7. Configure clients

Once the HTTPS endpoint is live, use the cloud MCP config in all your clients.
Replace `memory.yourdomain.com` with your actual domain and `<MEMORY_API_KEY>`
with the key from your `.env`.

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "universal-memory": {
      "type": "http",
      "url": "https://memory.YOUR_ACTUAL_DOMAIN.com/mcp",
      "headers": {
        "Authorization": "Bearer <MEMORY_API_KEY>"
      }
    }
  }
}
```

Run `/mcp` in Claude Code to confirm the 7 tools appear.

See `README.md` — Client Configuration section for KimiClaw, Kini, and Coding Fabric configs.

## 8. Updates and maintenance

```bash
cd /opt/universal-memory
git pull
docker compose build memory-hub
docker compose up memory-hub -d --no-deps
```

Check containers are healthy after update:

```bash
docker compose ps
```

## Rollback

```bash
git log --oneline -5          # find the previous commit
git checkout <previous-sha>
docker compose build memory-hub
docker compose up memory-hub -d --no-deps
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `memory-hub` unhealthy | Postgres not ready | `docker compose logs postgres` — check for errors |
| 401 from nginx before certbot | `memory-secrets.conf` missing or empty key | Check `/etc/nginx/memory-secrets.conf` |
| 413 Request Entity Too Large | nginx body limit | Verify `client_max_body_size 11m` in `nginx/memory.conf` |
| `POSTGRES_PASSWORD is required` | `.env` not filled | Re-run `$EDITOR .env` and set the password |
| BM25-only mode warning in logs | No LLM key set | Set `OPENAI_API_KEY` (or another provider) in `.env` |
| SSE requests timing out | `proxy_buffering` off needed | Verify `proxy_buffering off` is in `nginx/memory.conf` |
