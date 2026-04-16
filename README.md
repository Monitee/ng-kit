# ng-kit

Everything you need to build private AI products on [NodeGhost](https://nodeghost.ai) and POKT Network.

NodeGhost is a privacy-preserving AI inference gateway built on POKT's decentralized network. ng-kit gives you the tools to build on top of it — from a self-hosted memory server to a business proxy that keeps your API key private.

---

## What's in this repo

| Package | Description |
|---------|-------------|
| [`ng-memory-server`](./ng-memory-server) | Self-hosted RAG memory server — store, embed, and recall documents and memories |
| [`ng-proxy`](./ng-proxy) | Business proxy — hide your ng- key, serve customers without exposing credentials |
| [`ng-extension`](./ng-extension) | Browser extension — persistent memory for any NodeGhost-powered chat interface |
| [`examples/ghost-chat`](./examples/ghost-chat) | Reference implementation — full BYOM chat page using all three POKT services |

---

## Quick start

### I want to add AI to my website

1. Upload your business docs to the [Memory Admin Panel](https://nodeghost.ai/memory-admin)
2. Deploy the [business proxy](./ng-proxy) with your ng- key
3. Point any OpenAI-compatible chat widget at your proxy URL
4. Customers get accurate answers from your knowledge base — no API keys exposed

```bash
# Deploy the proxy in one command
docker run -d \
  -p 3200:3200 \
  -e NG_KEY=ng-your-key-here \
  -e MEMORY_URL=http://your-memory-server:3100 \
  -e SYSTEM_PROMPT="You are a helpful assistant for Acme Corp." \
  -e ALLOWED_ORIGINS=https://yourwebsite.com \
  nodeghost/proxy
```

### I want persistent memory in my AI app

```bash
npm install ng-memory
```

```javascript
const { NGMemory } = require('ng-memory');

const memory = new NGMemory({
  apiKey:     'ng-your-key',
  storageUrl: 'http://your-memory-server:3100',
});

await memory.init();
messages = await memory.recall(userMessage, messages);
// ... call your model ...
await memory.remember(userMessage, assistantResponse);
```

### I want a private chat interface

Open [nodeghost.ai/ghost](https://nodeghost.ai/ghost) — a full BYOM chat page with:
- Memory recall and storage through POKT's `vector-memory` service
- Web search through POKT's `web-search` service  
- Inference through POKT's `ai-inference` service
- Password-based zero-knowledge encryption (your memories, your key)

Or self-host the reference implementation from [`examples/ghost-chat`](./examples/ghost-chat).

---

## How NodeGhost works

```
Your app → NodeGhost gateway → POKT Network → your model provider
                                    ↓
                         Decentralized relay nodes
                         No single point of failure
                         No centralized logging
```

NodeGhost is a gateway into the POKT decentralized network. Your requests are routed through independent node operators — no single company has visibility into what you're asking.

**Three live POKT services:**

| Service ID | Purpose | Endpoint |
|------------|---------|----------|
| `ai-inference` | LLM inference routing | `nodeghost.ai/v1/chat/completions` |
| `web-search` | Brave Search via POKT | `nodeghost.ai/v1/tools/search` |
| `vector-memory` | RAG memory store/recall | `nodeghost.ai/v1/memory/recall` |

---

## Get an API key

Sign up at [nodeghost.ai](https://nodeghost.ai) to get an `ng-` API key. Plans start at $1/month.

Crypto-native? Stake a POKT application wallet directly on Shannon mainnet — no Stripe required. See the [docs](https://nodeghost.ai/docs.html#pokt-stake) for instructions.

---

## Run a supplier node

Want to earn POKT relay rewards by running infrastructure? See the [nodeghost-supplier](https://github.com/Monitee/nodeghost-supplier) repo for setup instructions.

---

## Documentation

Full docs at [nodeghost.ai/docs.html](https://nodeghost.ai/docs.html) including:
- Ghost Chat setup and encryption guide
- Memory server deployment
- Business proxy configuration
- Browser extension install
- POKT native stake instructions
- API reference

---

## Architecture — privacy by design

```
Personal memories:
  Browser → encrypt with password → POKT relay → memory server → ciphertext stored
  Memory server → ciphertext → POKT relay → browser → decrypt with password → injected

Business knowledge base:
  Admin panel → upload docs → memory server → chunked + embedded → stored plaintext
  Customer query → POKT relay → memory server → semantic search → relevant chunks returned

Inference:
  Your app → ng- key auth → NodeGhost → POKT relay → your model provider → response
```

NodeGhost never sees your plaintext memories. Your ng- key controls billing only — not your data.

---

## License

MIT
