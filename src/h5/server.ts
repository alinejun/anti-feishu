import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { Logger } from '../utils/logger.js';
import { CDPClient } from '../cdp/client.js';
import { ScreencastManager } from './screencast.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// MIME types for static files
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/**
 * Messages from server to client.
 */
interface ServerMessage {
  type: 'frame' | 'agent_output' | 'status' | 'event' | 'welcome';
  data?: string;
  text?: string;
  status?: StatusInfo;
  event?: string;
  timestamp?: number;
}

interface StatusInfo {
  cdp: boolean;
  feishu: boolean;
  autoAccept: boolean;
  fps: number;
  totalFrames: number;
  screencast: boolean;
  uptime: number;
}

/**
 * Messages from client to server.
 */
interface ClientMessage {
  type: 'send' | 'stop' | 'screenshot' | 'auto' | 'config' | 'ping';
  text?: string;
  config?: {
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
  };
}

export class H5Server {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private screencast: ScreencastManager;
  private cdp: CDPClient;
  private log: Logger;
  private port: number;
  private startTime = Date.now();
  private publicDir: string;

  // External status providers
  private feishuConnected = false;
  private autoAcceptEnabled = false;

  // Agent output handler — set by caller
  public onAgentSend: ((text: string) => Promise<boolean>) | null = null;
  public onStop: (() => Promise<boolean>) | null = null;
  public onScreenshot: (() => Promise<Buffer>) | null = null;
  public onAutoAcceptToggle: ((enable: boolean) => Promise<void>) | null = null;

  constructor(cdp: CDPClient, log: Logger, port: number = 3000) {
    this.cdp = cdp;
    this.log = log;
    this.port = port;
    this.screencast = new ScreencastManager(log);
    this.publicDir = path.join(__dirname, '..', '..', 'src', 'h5', 'public');

    // Setup screencast frame handler
    this.screencast.onFrame = (base64Data) => {
      this.broadcast({
        type: 'frame',
        data: base64Data,
        timestamp: Date.now(),
      });
    };

    // Create HTTP server for static files
    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => {
      this.handleWsConnection(ws);
    });
  }

  /**
   * Start the H5 server.
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.port, () => {
        this.log.info(`H5 Dashboard: http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Start screencast streaming.
   */
  async startScreencast(): Promise<void> {
    const page = this.cdp.getPage();
    if (!page) {
      this.log.warn('Cannot start screencast: no CDP page');
      return;
    }
    await this.screencast.start(page);
  }

  /**
   * Stop screencast streaming.
   */
  async stopScreencast(): Promise<void> {
    await this.screencast.stop();
  }

  /**
   * Push agent output to all connected H5 clients.
   */
  pushAgentOutput(text: string): void {
    this.broadcast({
      type: 'agent_output',
      text,
      timestamp: Date.now(),
    });
  }

  /**
   * Push an event to all clients.
   */
  pushEvent(event: string): void {
    this.broadcast({
      type: 'event',
      event,
      timestamp: Date.now(),
    });
  }

  /**
   * Update external status flags.
   */
  setFeishuStatus(connected: boolean): void {
    this.feishuConnected = connected;
  }

  setAutoAcceptStatus(enabled: boolean): void {
    this.autoAcceptEnabled = enabled;
  }

  /**
   * Stop the H5 server.
   */
  async stop(): Promise<void> {
    await this.stopScreencast();
    for (const client of this.clients) {
      try { client.close(); } catch { /* ignore */ }
    }
    this.clients.clear();

    // Close HTTP server with timeout
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.log.warn('H5 server close timed out, forcing...');
        resolve();
      }, 3000);
      this.httpServer.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.log.info('H5 server stopped');
  }

  // === Private methods ===

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let urlPath = req.url || '/';

    // Strip query string
    urlPath = urlPath.split('?')[0];

    // Default to index.html
    if (urlPath === '/') {
      urlPath = '/index.html';
    }

    const filePath = path.join(this.publicDir, urlPath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(this.publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Serve static file
    const ext = path.extname(filePath);
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          res.end('Not Found');
        } else {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
        return;
      }

      res.writeHead(200, {
        'Content-Type': mimeType,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  private handleWsConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.log.info(`H5 client connected (total: ${this.clients.size})`);

    // Send welcome message with current status
    this.sendToClient(ws, {
      type: 'welcome',
      status: this.getStatusInfo(),
      timestamp: Date.now(),
    });

    // Auto-start screencast if first client and not already running
    if (this.clients.size === 1 && !this.screencast.isRunning) {
      this.startScreencast().catch((err) => {
        this.log.error(`Auto-start screencast failed: ${err}`);
      });
    }

    ws.on('message', (raw) => {
      try {
        const msg: ClientMessage = JSON.parse(raw.toString());
        this.handleClientMessage(ws, msg);
      } catch (err) {
        this.log.warn(`Invalid H5 client message: ${err}`);
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.log.info(`H5 client disconnected (total: ${this.clients.size})`);

      // Stop screencast if no clients
      if (this.clients.size === 0 && this.screencast.isRunning) {
        this.stopScreencast().catch(() => {});
      }
    });

    ws.on('error', (err) => {
      this.log.error(`H5 WebSocket error: ${err}`);
      this.clients.delete(ws);
    });
  }

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'send': {
        if (msg.text && this.onAgentSend) {
          const success = await this.onAgentSend(msg.text);
          this.sendToClient(ws, {
            type: 'event',
            event: success ? `✅ Sent to Agent` : `❌ Failed to send`,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'stop': {
        if (this.onStop) {
          const success = await this.onStop();
          this.sendToClient(ws, {
            type: 'event',
            event: success ? `⏹ Generation stopped` : `⚠️ No active generation`,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'screenshot': {
        if (this.onScreenshot) {
          try {
            const buf = await this.onScreenshot();
            const base64 = buf.toString('base64');
            this.sendToClient(ws, {
              type: 'event',
              event: `📸 Screenshot captured (${Math.round(buf.length / 1024)}KB)`,
              data: base64,
              timestamp: Date.now(),
            });
          } catch (err) {
            this.sendToClient(ws, {
              type: 'event',
              event: `❌ Screenshot failed: ${err}`,
              timestamp: Date.now(),
            });
          }
        }
        break;
      }

      case 'auto': {
        if (this.onAutoAcceptToggle) {
          const enable = msg.text === 'on';
          await this.onAutoAcceptToggle(enable);
        }
        break;
      }

      case 'config': {
        if (msg.config) {
          const page = this.cdp.getPage();
          if (page) {
            await this.screencast.updateConfig(page, msg.config);
            this.sendToClient(ws, {
              type: 'event',
              event: `⚙️ Config updated: quality=${msg.config.quality || 'unchanged'}`,
              timestamp: Date.now(),
            });
          }
        }
        break;
      }

      case 'ping': {
        this.sendToClient(ws, {
          type: 'status',
          status: this.getStatusInfo(),
          timestamp: Date.now(),
        });
        break;
      }
    }
  }

  private getStatusInfo(): StatusInfo {
    return {
      cdp: this.cdp.isConnectedSync(),
      feishu: this.feishuConnected,
      autoAccept: this.autoAcceptEnabled,
      fps: this.screencast.currentFps,
      totalFrames: this.screencast.totalFrames,
      screencast: this.screencast.isRunning,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  private broadcast(msg: ServerMessage): void {
    const raw = JSON.stringify(msg);
    const isFrame = msg.type === 'frame';

    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      // For frame data: skip clients with high backpressure to prevent blocking
      if (isFrame && client.bufferedAmount > 1024 * 512) {
        continue; // Skip this frame for slow clients
      }

      try {
        client.send(raw);
      } catch {
        // Client may have just closed
      }
    }
  }

  private sendToClient(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
