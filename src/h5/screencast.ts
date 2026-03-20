import type { Page, CDPSession } from 'puppeteer-core';
import { Logger } from '../utils/logger.js';

export interface ScreencastConfig {
  format: 'jpeg' | 'png';
  quality: number;       // 1-100
  maxWidth: number;
  maxHeight: number;
  everyNthFrame: number; // 1 = every frame
}

const DEFAULT_CONFIG: ScreencastConfig = {
  format: 'jpeg',
  quality: 60,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 2,  // Skip every other frame to reduce CDP load
};

export class ScreencastManager {
  private session: CDPSession | null = null;
  private running = false;
  private frameCount = 0;
  private lastFrameTime = 0;
  private fps = 0;
  private fpsUpdateInterval: NodeJS.Timeout | null = null;
  private frameCountForFps = 0;
  private config: ScreencastConfig;
  private log: Logger;
  private minFrameIntervalMs = 200; // Min 200ms between frames (~5 fps max)

  // Callback when a new frame arrives
  public onFrame: ((base64Data: string, metadata: FrameMetadata) => void) | null = null;

  constructor(log: Logger, config?: Partial<ScreencastConfig>) {
    this.log = log;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start screencast on the given page.
   */
  async start(page: Page): Promise<void> {
    if (this.running) {
      this.log.warn('Screencast already running');
      return;
    }

    try {
      this.session = await page.createCDPSession();

      // Listen for frames
      this.session.on('Page.screencastFrame', (params: any) => {
        this.handleFrame(params);
      });

      // Start screencast
      await this.session.send('Page.startScreencast', {
        format: this.config.format,
        quality: this.config.quality,
        maxWidth: this.config.maxWidth,
        maxHeight: this.config.maxHeight,
        everyNthFrame: this.config.everyNthFrame,
      });

      this.running = true;
      this.frameCount = 0;
      this.startFpsCounter();

      this.log.info(
        `Screencast started (${this.config.maxWidth}x${this.config.maxHeight}, ` +
        `quality: ${this.config.quality}, format: ${this.config.format})`
      );
    } catch (err) {
      this.log.error(`Failed to start screencast: ${err}`);
      throw err;
    }
  }

  /**
   * Stop screencast.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    // Mark stopped first to prevent handleFrame from re-triggering
    this.running = false;
    this.stopFpsCounter();

    const session = this.session;
    this.session = null;

    if (session) {
      // Use timeout to prevent hanging if CDP session is dead
      const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | void> =>
        Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);

      try {
        session.removeAllListeners('Page.screencastFrame');
        await withTimeout(session.send('Page.stopScreencast'), 3000);
      } catch { /* ignore */ }

      try {
        await withTimeout(session.detach(), 3000);
      } catch { /* ignore */ }
    }

    this.log.info('Screencast stopped');
  }

  /**
   * Update screencast config on the fly (e.g., quality change from client).
   */
  async updateConfig(page: Page, newConfig: Partial<ScreencastConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    if (this.running) {
      await this.stop();
      await this.start(page);
    }
  }

  /**
   * Check if it's running.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Current FPS.
   */
  get currentFps(): number {
    return this.fps;
  }

  /**
   * Total frames captured.
   */
  get totalFrames(): number {
    return this.frameCount;
  }

  /**
   * Handle incoming screencast frame from CDP.
   */
  private handleFrame(params: any): void {
    if (!this.running) return;

    const { data, metadata, sessionId } = params;
    const now = Date.now();

    // Always ACK — required by CDP to receive next frame
    if (this.session) {
      this.session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    }

    // Throttle: skip frame if too soon after last one
    if (now - this.lastFrameTime < this.minFrameIntervalMs) {
      return;
    }

    this.frameCount++;
    this.frameCountForFps++;
    this.lastFrameTime = now;

    // Emit frame to listeners
    if (this.onFrame) {
      this.onFrame(data, {
        offsetTop: metadata.offsetTop,
        pageScaleFactor: metadata.pageScaleFactor,
        deviceWidth: metadata.deviceWidth,
        deviceHeight: metadata.deviceHeight,
        scrollOffsetX: metadata.scrollOffsetX,
        scrollOffsetY: metadata.scrollOffsetY,
        timestamp: metadata.timestamp,
      });
    }
  }

  private startFpsCounter(): void {
    this.frameCountForFps = 0;
    this.fpsUpdateInterval = setInterval(() => {
      this.fps = Math.round(this.frameCountForFps * 10) / 10;
      this.frameCountForFps = 0;
    }, 1000);
  }

  private stopFpsCounter(): void {
    if (this.fpsUpdateInterval) {
      clearInterval(this.fpsUpdateInterval);
      this.fpsUpdateInterval = null;
    }
    this.fps = 0;
  }
}

export interface FrameMetadata {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp: number;
}
