# Anti-Feishu

> Control Antigravity Agent remotely via Feishu (Lark) Bot — a standalone Node.js service.

[中文文档](README.zh.md)

## Features

- **Remote Agent Control**: Send messages, read replies, stop generation via Feishu
- **Auto Accept**: Automatically accept Agent file changes, terminal commands with safety filters
- **Screenshots**: Capture IDE screenshots and send to Feishu
- **Push Notifications**: Agent replies are automatically pushed to Feishu
- **No Public IP**: Uses Feishu WebSocket long connection (no ngrok/tunnel needed)

## Quick Start

1. Create a Feishu app with Bot capability on [Feishu Open Platform](https://open.feishu.cn/)
2. Start Antigravity with CDP: `bash scripts/start-antigravity.sh`
3. Configure `.env` with your Feishu credentials: `cp .env.example .env`
4. Install and run: `npm install && npm run dev`
5. Send `/help` to your bot in Feishu

See [README.zh.md](README.zh.md) for detailed setup instructions.

## License

MIT
