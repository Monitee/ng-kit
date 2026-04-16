# NodeGhost Business Proxy

Let your customers chat with an AI that knows your business — without ever exposing your API key.

## What it does

- Sits between your website and NodeGhost
- Injects your ng- key server-side (customers never see it)
- Automatically pulls context from your knowledge base before every response
- Works with any OpenAI-compatible chat widget

## Quick start

### Option 1 — Docker (recommended)

```bash
docker run -d \
  -p 3200:3200 \
  -e NG_KEY=ng-your-key-here \
  -e MEMORY_URL=http://your-memory-server:3100 \
  -e SYSTEM_PROMPT="You are a helpful assistant for Acme Corp." \
  -e ALLOWED_ORIGINS=https://yourwebsite.com \
  nodeghost/proxy
```

### Option 2 — Docker Compose

```bash
# Edit docker-compose.yml with your values
docker compose up -d
```

### Option 3 — Node.js directly

```bash
NG_KEY=ng-your-key-here \
MEMORY_URL=http://your-memory-server:3100 \
SYSTEM_PROMPT="You are a helpful assistant." \
node server.js
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NG_KEY` | ✅ Yes | — | Your NodeGhost API key |
| `PORT` | No | 3200 | Port to listen on |
| `NG_URL` | No | https://nodeghost.ai | NodeGhost base URL |
| `MEMORY_URL` | No | — | Your ng-memory-server URL |
| `MODEL` | No | deepseek-chat | Model to use |
| `NAMESPACE` | No | knowledge-base | Memory namespace to query |
| `SYSTEM_PROMPT` | No | Generic prompt | Your custom system prompt |
| `ALLOWED_ORIGINS` | No | * | Comma-separated allowed CORS origins |
| `MAX_TOKENS` | No | 800 | Max tokens per response |

## Point your chat widget here

Once running, point any OpenAI-compatible chat widget at your proxy:

```
Base URL: http://your-server:3200/v1
API Key:  any-string  (proxy ignores it, uses NG_KEY internally)
Model:    deepseek-chat
```

## Upload your knowledge base

Use the NodeGhost Memory Admin panel to upload your business docs:

```
https://nodeghost.ai/memory-admin
Server URL: http://your-memory-server:3100
API Key:    ng-your-key-here
Namespace:  knowledge-base
```

The proxy automatically queries your knowledge base before every customer message.

## Health check

```bash
curl http://your-server:3200/health
```

## Compatible chat widgets

Any of these work out of the box:
- [Open WebUI](https://github.com/open-webui/open-webui) — full featured, self-hosted
- [LibreChat](https://github.com/danny-avila/LibreChat) — open source ChatGPT alternative
- [Chatbot UI](https://github.com/mckaywrigley/chatbot-ui) — clean, minimal
- [Flowise](https://github.com/FlowiseAI/Flowise) — visual flow builder
- Any widget that supports a custom OpenAI base URL
