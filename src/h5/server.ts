import http from 'http';
import https from 'https';
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
  type: 'frame' | 'agent_output' | 'status' | 'event' | 'welcome' | 'file_content' | 'sessions_list' | 'files_list' | 'projects_list';
  data?: string;
  text?: string;
  status?: StatusInfo;
  event?: string;
  timestamp?: number;
  filename?: string;
  language?: string;
  items?: { index: number; title: string; active: boolean }[];
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
  type: 'send' | 'stop' | 'screenshot' | 'auto' | 'config' | 'ping' | 'image' | 'file' | 'sessions' | 'files' | 'projects' | 'mouse' | 'viewport' | 'action';
  text?: string;
  data?: string;
  name?: string;
  config?: {
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
  };
  // Mouse event data
  x?: number;
  y?: number;
  action?: string; // 'click' | 'down' | 'up' | 'move' | 'drag'
  toX?: number;
  toY?: number;
}

export class H5Server {
  private httpServer: http.Server;
  private httpsServer: https.Server | null = null;
  private wss: WebSocketServer;
  private wssSecure: WebSocketServer | null = null;
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
  public onImageSend: ((filePath: string, text: string) => Promise<boolean>) | null = null;
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

    const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handleHttpRequest(req, res);
    };

    // Create HTTP server
    this.httpServer = http.createServer(requestHandler);

    // Create WebSocket server on HTTP
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => {
      this.handleWsConnection(ws);
    });

    // Try to create HTTPS server if certs exist
    const projectRoot = path.join(__dirname, '..', '..');
    const certPath = path.join(projectRoot, 'certs', 'cert.pem');
    const keyPath = path.join(projectRoot, 'certs', 'key.pem');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      try {
        const sslOptions = {
          cert: fs.readFileSync(certPath),
          key: fs.readFileSync(keyPath),
        };
        this.httpsServer = https.createServer(sslOptions, requestHandler);
        this.wssSecure = new WebSocketServer({ server: this.httpsServer });
        this.wssSecure.on('connection', (ws) => {
          this.handleWsConnection(ws);
        });
        this.log.info('HTTPS enabled (certs found)');
      } catch (err) {
        this.log.warn(`Failed to load SSL certs: ${err}`);
      }
    }
  }

  /**
   * Start the H5 server.
   */
  async start(): Promise<void> {
    // Start HTTP server
    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.port, () => {
        this.log.info(`H5 Dashboard (HTTP): http://localhost:${this.port}`);
        resolve();
      });
    });

    // Start HTTPS server on port+1
    if (this.httpsServer) {
      const httpsPort = this.port + 1;
      await new Promise<void>((resolve) => {
        this.httpsServer!.listen(httpsPort, () => {
          this.log.info(`H5 Dashboard (HTTPS): https://localhost:${httpsPort}`);
          resolve();
        });
      });
    }
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

    // Close servers with timeout
    const closeServer = (server: http.Server | https.Server, name: string) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.log.warn(`${name} close timed out, forcing...`);
          resolve();
        }, 3000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });

    await closeServer(this.httpServer, 'HTTP server');
    if (this.httpsServer) {
      await closeServer(this.httpsServer, 'HTTPS server');
    }

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

  /**
   * Fetch current agent messages from CDP and send to a specific client.
   */
  private async fetchAndSendHistory(ws: WebSocket): Promise<void> {
    try {
      const page = this.cdp.getPage();
      if (!page) return;

      const browser = page.browser();
      if (!browser) return;

      const pages = await browser.pages();

      for (const p of pages) {
        try {
          const title = await Promise.race([
            p.title(),
            new Promise<string>(r => setTimeout(() => r(''), 1000)),
          ]);
          if (title.includes('Dashboard') || title === 'Launchpad') continue;

          const raw = await Promise.race([
            p.evaluate(`(function() {
              try {
                var els = document.querySelectorAll('.animate-markdown');
                if (els.length === 0) return JSON.stringify({count: 0, messages: []});
                var messages = [];
                for (var i = 0; i < els.length; i++) {
                  var html = (els[i].innerHTML || '').trim();
                  if (html.length > 0) {
                    messages.push(html.length > 5000 ? html.substring(0, 5000) + '...' : html);
                  }
                }
                return JSON.stringify({count: messages.length, messages: messages});
              } catch(e) {
                return JSON.stringify({count: 0, messages: []});
              }
            })()`),
            new Promise<null>(r => setTimeout(() => r(null), 3000)),
          ]);

          if (!raw || typeof raw !== 'string') continue;

          const data = JSON.parse(raw) as { count: number; messages: string[] };
          if (data.count > 0) {
            for (const msg of data.messages) {
              this.sendToClient(ws, {
                type: 'agent_output',
                text: msg,
                timestamp: Date.now(),
              });
            }
            this.log.info(`Sent ${data.count} history messages to new H5 client`);
            return; // Found messages, done
          }
        } catch {
          // skip
        }
      }
    } catch (err) {
      this.log.warn(`Failed to fetch history: ${err}`);
    }
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

    // Fetch current agent messages from CDP and send to client
    this.fetchAndSendHistory(ws).catch(() => {});

    // Auto-start screencast if not already running (any client triggers restart)
    if (!this.screencast.isRunning) {
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

      case 'image': {
        if (msg.data) {
          try {
            // Save image to uploads directory
            const uploadsDir = path.join(this.publicDir, '..', '..', '..', 'uploads');
            if (!fs.existsSync(uploadsDir)) {
              fs.mkdirSync(uploadsDir, { recursive: true });
            }

            const ext = '.jpg';
            const filename = `h5-upload-${Date.now()}${ext}`;
            const filePath = path.join(uploadsDir, filename);
            const buf = Buffer.from(msg.data, 'base64');
            fs.writeFileSync(filePath, buf);

            this.log.info(`Image saved: ${filePath} (${Math.round(buf.length / 1024)}KB)`);

            // Send to agent via callback
            if (this.onImageSend) {
              const success = await this.onImageSend(filePath, msg.text || '');
              this.sendToClient(ws, {
                type: 'event',
                event: success ? `✅ Image sent to Agent` : `❌ Failed to send image`,
                timestamp: Date.now(),
              });
            } else if (this.onAgentSend) {
              // Fallback: send file path as text
              const text = msg.text
                ? `[Image: ${filePath}] ${msg.text}`
                : `Please analyze this image: ${filePath}`;
              const success = await this.onAgentSend(text);
              this.sendToClient(ws, {
                type: 'event',
                event: success ? `✅ Image sent to Agent` : `❌ Failed to send image`,
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            this.sendToClient(ws, {
              type: 'event',
              event: `❌ Image upload failed: ${err}`,
              timestamp: Date.now(),
            });
          }
        }
        break;
      }
      case 'file': {
        if (msg.text) {
          try {
            const filePath = msg.text.trim();
            if (!fs.existsSync(filePath)) {
              this.sendToClient(ws, {
                type: 'event',
                event: `❌ File not found: ${filePath}`,
                timestamp: Date.now(),
              });
              break;
            }

            const stat = fs.statSync(filePath);
            if (!stat.isFile()) {
              this.sendToClient(ws, {
                type: 'event',
                event: `❌ Not a file: ${filePath}`,
                timestamp: Date.now(),
              });
              break;
            }

            // Limit to 1MB
            if (stat.size > 1024 * 1024) {
              this.sendToClient(ws, {
                type: 'event',
                event: `❌ File too large: ${Math.round(stat.size / 1024)}KB (max 1MB)`,
                timestamp: Date.now(),
              });
              break;
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            const ext = path.extname(filePath).slice(1);
            const langMap: Record<string, string> = {
              ts: 'typescript', js: 'javascript', py: 'python',
              rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
              css: 'css', html: 'html', json: 'json', yaml: 'yaml', yml: 'yaml',
              md: 'markdown', sh: 'bash', toml: 'toml', xml: 'xml', sql: 'sql',
              tsx: 'typescript', jsx: 'javascript', vue: 'html', svelte: 'html',
            };

            this.sendToClient(ws, {
              type: 'file_content',
              text: content,
              filename: path.basename(filePath),
              language: langMap[ext] || 'text',
              timestamp: Date.now(),
            });

            this.log.info(`File sent to H5: ${filePath} (${Math.round(stat.size / 1024)}KB)`);
          } catch (err) {
            this.sendToClient(ws, {
              type: 'event',
              event: `❌ File read failed: ${err}`,
              timestamp: Date.now(),
            });
          }
        }
        break;
      }
      case 'sessions': {
        const action = msg.text || 'list';
        try {
          if (action === 'list') {
            const sessions = await this.cdp.listAgentSessions();
            this.sendToClient(ws, {
              type: 'sessions_list',
              items: sessions,
              timestamp: Date.now(),
            });
          } else if (action === 'new') {
            await this.cdp.newAgentSession();
            this.sendToClient(ws, {
              type: 'event',
              event: '✅ New Agent session created',
              timestamp: Date.now(),
            });
            // Send updated list after a short delay
            await new Promise(r => setTimeout(r, 500));
            const sessions = await this.cdp.listAgentSessions();
            this.sendToClient(ws, {
              type: 'sessions_list',
              items: sessions,
              timestamp: Date.now(),
            });
          } else if (action.startsWith('switch:')) {
            const idx = parseInt(action.split(':')[1]);
            const ok = await this.cdp.switchAgentSession(idx);
            this.sendToClient(ws, {
              type: 'event',
              event: ok ? '✅ Switched session' : '❌ Failed to switch',
              timestamp: Date.now(),
            });
          } else if (action.startsWith('close:')) {
            const idx = parseInt(action.split(':')[1]);
            const ok = await this.cdp.closeAgentSession(idx);
            this.sendToClient(ws, {
              type: 'event',
              event: ok ? '✅ Session closed' : '❌ Failed to close',
              timestamp: Date.now(),
            });
            await new Promise(r => setTimeout(r, 300));
            const sessions = await this.cdp.listAgentSessions();
            this.sendToClient(ws, {
              type: 'sessions_list',
              items: sessions,
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          this.sendToClient(ws, {
            type: 'event',
            event: `❌ Session error: ${err}`,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'files': {
        const action = msg.text || 'list';
        try {
          if (action === 'list') {
            const files = await this.cdp.listOpenFiles();
            this.sendToClient(ws, {
              type: 'files_list',
              items: files,
              timestamp: Date.now(),
            });
          } else if (action.startsWith('switch:')) {
            const idx = parseInt(action.split(':')[1]);
            const ok = await this.cdp.switchFile(idx);
            this.sendToClient(ws, {
              type: 'event',
              event: ok ? '✅ Switched file' : '❌ Failed to switch',
              timestamp: Date.now(),
            });
          } else if (action.startsWith('close:')) {
            const idx = parseInt(action.split(':')[1]);
            const ok = await this.cdp.closeFile(idx);
            this.sendToClient(ws, {
              type: 'event',
              event: ok ? '✅ File closed' : '❌ Failed to close',
              timestamp: Date.now(),
            });
            await new Promise(r => setTimeout(r, 300));
            const files = await this.cdp.listOpenFiles();
            this.sendToClient(ws, {
              type: 'files_list',
              items: files,
              timestamp: Date.now(),
            });
          } else if (action === 'windows') {
            const windows = await this.cdp.listWindows();
            const items = windows.map((title, index) => ({ index, title, active: index === 0 }));
            this.sendToClient(ws, {
              type: 'files_list',
              items,
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          this.sendToClient(ws, {
            type: 'event',
            event: `\u274C File error: ${err}`,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'projects': {
        const action = msg.text || 'list';
        try {
          if (action === 'list') {
            const workspaces = await this.cdp.listWorkspaces();
            this.sendToClient(ws, {
              type: 'projects_list' as any,
              items: workspaces,
              timestamp: Date.now(),
            });
          } else if (action.startsWith('switch:')) {
            const idx = parseInt(action.split(':')[1]);
            const title = await this.cdp.switchWorkspace(idx);
            this.log.info(`Workspace switched to [${idx}]: ${title}`);
            this.sendToClient(ws, {
              type: 'event',
              event: `\u2705 Switched to: ${title}`,
              timestamp: Date.now(),
            });
            // Always force stop screencast before restarting
            this.log.info(`Screencast running=${this.screencast.isRunning}, stopping...`);
            await this.screencast.stop();
            await new Promise(r => setTimeout(r, 500));
            const page = this.cdp.getPage();
            if (page) {
              this.log.info(`Restarting screencast on new page`);
              await this.screencast.start(page);
            } else {
              this.log.warn('No page available to restart screencast');
            }
            // Refresh the list
            const updated = await this.cdp.listWorkspaces();
            this.sendToClient(ws, {
              type: 'projects_list' as any,
              items: updated,
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          this.sendToClient(ws, {
            type: 'event',
            event: `\u274C Project error: ${err}`,
            timestamp: Date.now(),
          });
        }
        break;
      }
      case 'mouse': {
        try {
          const viewport = await this.cdp.getViewportSize();
          // Coordinates from client are normalized (0-1), map to viewport pixels
          const x = (msg.x || 0) * viewport.width;
          const y = (msg.y || 0) * viewport.height;

          if (msg.action === 'click') {
            await this.cdp.clickAt(x, y);
          } else if (msg.action === 'drag') {
            const toX = (msg.toX || 0) * viewport.width;
            const toY = (msg.toY || 0) * viewport.height;
            await this.cdp.drag(x, y, toX, toY);
          } else if (msg.action === 'down') {
            await this.cdp.dispatchMouseEvent('mousePressed', x, y);
          } else if (msg.action === 'up') {
            await this.cdp.dispatchMouseEvent('mouseReleased', x, y);
          } else if (msg.action === 'move') {
            await this.cdp.dispatchMouseEvent('mouseMoved', x, y);
          }
        } catch (err) {
          this.log.warn(`Mouse event error: ${err}`);
        }
        break;
      }

      case 'viewport': {
        try {
          const size = await this.cdp.getViewportSize();
          this.sendToClient(ws, {
            type: 'event',
            event: `Viewport: ${size.width}x${size.height}`,
            data: JSON.stringify(size),
            timestamp: Date.now(),
          });
        } catch (err) {
          this.log.warn(`Viewport error: ${err}`);
        }
        break;
      }

      case 'action': {
        const action = msg.text || '';
        if (!action) break;
        try {
          const result = await this.cdp.executeAction(action);
          this.sendToClient(ws, {
            type: 'event',
            event: result.success ? `✅ ${result.message}` : `⚠️ ${result.message}`,
            timestamp: Date.now(),
          });
        } catch (err) {
          this.sendToClient(ws, {
            type: 'event',
            event: `❌ Action failed: ${err}`,
            timestamp: Date.now(),
          });
        }
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
