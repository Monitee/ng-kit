# ng-memory-server

Self-hosted private AI memory server. Run your own persistent memory backend accessible from anywhere.

Works with the [ng-memory](https://www.npmjs.com/package/ng-memory) npm package and the NodeGhost Memory browser extension.

## Why self-host?

- **Your data, your server** — memories never leave your infrastructure
- **Access from anywhere** — not tied to one browser or machine
- **Team knowledge base** — share a memory server across your organization
- **Complete privacy** — even NodeGhost cannot see your memories

---

## Quick Start

### Option 1 — Docker (recommended)

```bash
# Create a directory for your memory server
mkdir ng-memory-server && cd ng-memory-server

# Download docker-compose.yml
curl -O https://raw.githubusercontent.com/Monitee/nodeghost/main/ng-memory-server/docker-compose.yml

# Start the server
docker compose up -d

# Verify it's running
curl http://localhost:3100/health
```

### Option 2 — Node.js directly

```bash
# Clone or download the server
git clone https://github.com/Monitee/nodeghost
cd nodeghost/ng-memory-server

# Install dependencies
npm install

# Start
node server.js
```

---

## Configuration

All configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `DATA_DIR` | `./data` | Directory for SQLite databases |
| `INFERENCE_URL` | `https://nodeghost.ai/v1` | NodeGhost URL for fact extraction |
| `MAX_MEMORIES` | `2000` | Max memories stored per user |
| `CORS_ORIGINS` | `*` | Allowed CORS origins |
| `ALLOWED_KEYS` | `` | Restrict to specific ng- keys (comma separated). Empty = allow all valid keys |

---

## Making it accessible from anywhere

To access your memory server from other devices you need to expose it publicly. Here are your options:

### VPS (recommended for always-on access)

Any small VPS works — you need about 512MB RAM and 1GB storage to start.

Popular options:
- [Hetzner Cloud](https://www.hetzner.com/cloud) — from €4/month
- [DigitalOcean Droplets](https://www.digitalocean.com/products/droplets) — from $4/month
- [Linode/Akamai](https://www.linode.com) — from $5/month
- [Vultr](https://www.vultr.com) — from $2.50/month
- [Fly.io](https://fly.io) — free tier available

### Home server / Raspberry Pi

Run it on a Raspberry Pi or spare PC at home. You'll need to configure port forwarding on your router and use a dynamic DNS service if your home IP changes.

### Cloudflare Tunnel (no open ports)

If you don't want to open firewall ports, Cloudflare Tunnel creates a secure tunnel from your machine to a public URL for free.

```bash
# Install cloudflared
# Then:
cloudflared tunnel --url http://localhost:3100
```

---

## Setting up with nginx + SSL (VPS)

Once you have a VPS and a domain, set up nginx as a reverse proxy with SSL:

```nginx
server {
    listen 443 ssl;
    server_name memory.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/memory.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/memory.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Get a free SSL certificate:
```bash
certbot --nginx -d memory.yourdomain.com
```

---

## API Reference

All endpoints require `Authorization: Bearer ng-your-key` header.

### POST /recall
Get memories relevant to a query.

```bash
curl -X POST https://your-server/recall \
  -H "Authorization: Bearer ng-your-key" \
  -H "Content-Type: application/json" \
  -d '{"query": "what do I prefer for breakfast?", "topK": 5}'
```

Response:
```json
{
  "ok": true,
  "memories": ["User prefers oat milk in their coffee"],
  "count": 1,
  "memoryBlock": "Relevant context from memory:\n- User prefers oat milk in their coffee"
}
```

### POST /remember
Extract and store facts from a conversation turn.

```bash
curl -X POST https://your-server/remember \
  -H "Authorization: Bearer ng-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "userMsg": "I always drink oat milk in my coffee",
    "assistantMsg": "Got it, I will remember that you prefer oat milk."
  }'
```

### POST /store
Manually store a memory.

```bash
curl -X POST https://your-server/store \
  -H "Authorization: Bearer ng-your-key" \
  -H "Content-Type: application/json" \
  -d '{"text": "Company return policy is 30 days no questions asked"}'
```

### GET /list
List all stored memories.

### GET /stats
Get memory count.

### DELETE /memories
Clear all memories.

### DELETE /memories/:id
Delete a specific memory.

---

## Using with ng-memory npm package

```javascript
const { NGMemory } = require('ng-memory');

const memory = new NGMemory({
  apiKey:       'ng-your-key',
  inferenceUrl: 'https://nodeghost.ai/v1',
  // Point at your self-hosted server
  storageUrl:   'https://memory.yourdomain.com',
  userId:       'user-123',
});

await memory.init();

// Works exactly the same — just stores remotely
messages = await memory.recall(userMessage, messages);
await memory.remember(userMessage, assistantResponse);
```

## Using with the browser extension

1. Open the NodeGhost Memory extension
2. Go to Settings
3. Set **Memory Server URL** to `https://memory.yourdomain.com`
4. Save

Memories will now sync across all your devices.

---

## Privacy & Security

- Each ng- key gets its own isolated SQLite database
- The actual ng- key is never stored — only a SHA-256 hash is used as the user ID
- Memories are stored as plaintext on your server — you control who has access
- Set `ALLOWED_KEYS` to restrict access to specific ng- keys

---

## Business Use Case

Run ng-memory-server as a shared knowledge base for your team or AI agent:

```bash
# Restrict to your team's keys only
ALLOWED_KEYS=ng-key1,ng-key2,ng-key3 docker compose up -d
```

Your AI agent can then recall company policies, product knowledge, customer history — all stored privately on your infrastructure, recalled via NodeGhost's relay network.

---

## License

MIT — NodeGhost
