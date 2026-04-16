# NodeGhost Memory — Browser Extension

Private persistent AI memory for NodeGhost. Your memories stay in your browser — never on any server.

## What it does

- Automatically remembers key facts from your AI conversations
- Injects relevant memories into every new conversation
- Works with any app using your NodeGhost ng- API key
- All memory stored locally in your browser (IndexedDB)

## Installation (Developer Mode)

1. Download or clone this folder
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked**
5. Select this folder
6. The NodeGhost Memory icon will appear in your toolbar

## Setup

1. Click the extension icon
2. Go to **Settings**
3. Enter your `ng-` API key from [nodeghost.ai](https://nodeghost.ai)
4. Click **Save Settings**

## How it works

Once set up, the extension intercepts requests to NodeGhost and:

1. **Before each message** — searches your local memories for relevant context and injects it into the system prompt automatically
2. **After each response** — extracts key facts and stores them locally

Your memories never leave your browser. NodeGhost only sees the already-assembled prompt.

## Privacy

- All memory stored in browser IndexedDB
- No data sent to NodeGhost or any server
- Extension source is open and auditable
- You can clear all memories at any time from the popup

## Files

- `manifest.json` — Extension configuration
- `background.js` — Service worker, handles memory logic
- `ng-memory-browser.js` — Core memory library (browser version)
- `popup.html/js` — Extension popup UI
- `icons/` — Extension icons

## Development

To modify the extension:
1. Make your changes
2. Go to `chrome://extensions`
3. Click the refresh icon on the NodeGhost Memory card
