import puppeteer, { Browser, Page } from 'puppeteer-core';
import type { Page as PageType } from 'puppeteer-core';
import { Logger } from '../utils/logger.js';

export class CDPClient {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private port: number;
  private host: string;
  private log: Logger;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private maxRetries = 10;
  private retryCount = 0;
  private retryDelay = 5000;
  private lastTargetTitle: string | undefined;

  constructor(host: string, port: number, log: Logger) {
    this.host = host;
    this.port = port;
    this.log = log;
  }

  async connect(targetTitle?: string): Promise<void> {
    const url = `http://${this.host}:${this.port}/json/version`;
    this.log.info(`Connecting to CDP at ${url}...`);

    const response = await fetch(url);
    const data = await response.json() as { webSocketDebuggerUrl: string };
    const wsUrl = data.webSocketDebuggerUrl;

    this.browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null,
    });

    const pages = await this.browser.pages();
    this.page = pages[0];

    // Log all windows for debugging
    const titles: string[] = [];
    for (const p of pages) {
      const title = await p.title().catch(() => '');
      titles.push(title);
    }
    this.log.info(`CDP found ${pages.length} windows: ${titles.map((t, i) => `[${i}] ${t}`).join(', ')}`);

    // If targetTitle specified, use it
    if (targetTitle) {
      for (let i = 0; i < pages.length; i++) {
        if (titles[i].toLowerCase().includes(targetTitle.toLowerCase())) {
          this.page = pages[i];
          break;
        }
      }
    } else {
      // Default: prefer AIAgent window, then first real workspace
      const skipTitles = ['launchpad', 'settings', 'manager'];
      let fallback: typeof pages[0] | null = null;

      for (let i = 0; i < pages.length; i++) {
        const lower = titles[i].toLowerCase();
        if (skipTitles.some(s => lower === s)) continue;

        // Prefer windows with "AIAgent" or "Agent" in title
        if (lower.includes('aiagent') || lower.startsWith('agent')) {
          this.page = pages[i];
          fallback = null;
          break;
        }

        // Keep first valid as fallback
        if (!fallback) fallback = pages[i];
      }

      if (fallback && this.page === pages[0]) {
        this.page = fallback;
      }
    }

    this.setupDisconnectHandler();
    this.log.info(`CDP connected. Active page: "${await this.page?.title()}"`);
  }

  /**
   * List all available windows.
   */
  async listWindows(): Promise<string[]> {
    if (!this.browser) return [];
    const pages = await this.browser.pages();
    const titles: string[] = [];
    for (const p of pages) {
      titles.push(await p.title().catch(() => 'N/A'));
    }
    return titles;
  }

  /**
   * Switch to a specific window by title keyword or index.
   */
  async switchPage(target: string): Promise<string> {
    if (!this.browser) throw new Error('CDP not connected');
    const pages = await this.browser.pages();

    // Try by index
    const idx = parseInt(target);
    if (!isNaN(idx) && idx >= 0 && idx < pages.length) {
      this.page = pages[idx];
      return await this.page.title();
    }

    // Try by title keyword
    for (const p of pages) {
      const title = await p.title().catch(() => '');
      if (title.toLowerCase().includes(target.toLowerCase())) {
        this.page = p;
        this.lastTargetTitle = target; // Remember for reconnect
        return title;
      }
    }

    throw new Error(`Window not found: ${target}`);
  }

  async connectWithRetry(): Promise<void> {
    try {
      await this.connect(this.lastTargetTitle);
      this.retryCount = 0;
    } catch (err) {
      this.retryCount++;
      if (this.retryCount <= this.maxRetries) {
        this.log.warn(
          `CDP connection failed (${this.retryCount}/${this.maxRetries}), ` +
          `retrying in ${this.retryDelay / 1000}s... Error: ${err}`
        );
        this.reconnectTimer = setTimeout(
          () => this.connectWithRetry(),
          this.retryDelay,
        );
      } else {
        this.log.error('CDP connection failed after max retries');
      }
    }
  }

  /**
   * Send a message to the Agent Chat.
   * Antigravity uses a contenteditable div, not a textarea.
   */
  async sendMessage(text: string): Promise<boolean> {
    if (!this.page) throw new Error('CDP not connected');

    // Step 1: Focus the contenteditable input
    const focused = await this.page.evaluate(`(function() {
      var candidates = document.querySelectorAll('div[contenteditable="true"]');
      for (var i = 0; i < candidates.length; i++) {
        var cn = candidates[i].className || '';
        if (typeof cn === 'string' && cn.indexOf('cursor-text') !== -1) {
          candidates[i].focus();
          candidates[i].click();
          candidates[i].innerText = '';
          return true;
        }
      }
      return false;
    })()`);

    if (!focused) {
      this.log.warn('sendMessage: could not find Agent Chat input');
      return false;
    }

    // Step 2: Type using Puppeteer keyboard (sends real CDP key events)
    await this.page.keyboard.type(text, { delay: 10 });

    // Step 3: Wait for Send button to become enabled, then click
    await new Promise(r => setTimeout(r, 300));

    const result = await this.page.evaluate(`(function() {
      var buttons = document.querySelectorAll('button');
      for (var j = 0; j < buttons.length; j++) {
        var btnText = (buttons[j].textContent || '').trim();
        if (btnText === 'Send' && !buttons[j].disabled) {
          buttons[j].click();
          return 'sent';
        }
      }
      return 'no-send';
    })()`);

    this.log.info('sendMessage result: ' + result);

    if (result === 'no-send') {
      // Fallback: press Enter
      await this.page.keyboard.press('Enter');
      this.log.info('sendMessage: used Enter key fallback');
    }

    return true;
  }

  async getLatestReply(): Promise<string> {
    if (!this.page) throw new Error('CDP not connected');

    const result = await this.page.evaluate(`(function() {
      // Try known message selectors
      var selectors = ['.message-content', '[data-testid="message"]', '.chat-message', '.response-content'];
      for (var i = 0; i < selectors.length; i++) {
        var messages = document.querySelectorAll(selectors[i]);
        if (messages.length > 0) {
          var last = messages[messages.length - 1];
          return (last.textContent || '').trim() || 'Empty message';
        }
      }
      return 'No messages found';
    })()`);

    return result as string;
  }

  async getMessageCount(): Promise<number> {
    if (!this.page) throw new Error('CDP not connected');

    const result = await this.page.evaluate(`(function() {
      var selectors = ['.message-content', '[data-testid="message"]', '.chat-message', '.response-content'];
      for (var i = 0; i < selectors.length; i++) {
        var messages = document.querySelectorAll(selectors[i]);
        if (messages.length > 0) return messages.length;
      }
      return 0;
    })()`);

    return result as number;
  }

  async stopGeneration(): Promise<boolean> {
    if (!this.page) throw new Error('CDP not connected');

    const result = await this.page.evaluate(`(function() {
      var buttons = document.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        var text = (buttons[i].textContent || '').trim().toLowerCase();
        var label = (buttons[i].getAttribute('aria-label') || '').toLowerCase();
        if (text === 'stop' || label.indexOf('stop') !== -1 || label.indexOf('cancel') !== -1) {
          buttons[i].click();
          return true;
        }
      }
      return false;
    })()`);

    return result as boolean;
  }

  async screenshot(): Promise<Buffer> {
    if (!this.page) throw new Error('CDP not connected');
    const screenshot = await this.page.screenshot({
      type: 'png',
      fullPage: false,
    });
    return Buffer.from(screenshot);
  }

  async isConnected(): Promise<boolean> {
    try {
      if (!this.page) return false;
      await this.page.evaluate('document.title');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Synchronous check — returns true if page ref exists (no I/O).
   */
  isConnectedSync(): boolean {
    return this.page !== null && this.browser !== null;
  }

  /**
   * Get the current Puppeteer Page (for screencast / CDPSession).
   */
  getPage(): PageType | null {
    return this.page;
  }

  async evaluate(script: string): Promise<any> {
    if (!this.page) throw new Error('CDP not connected');
    return await this.page.evaluate(script);
  }

  /**
   * Evaluate script across ALL browser targets AND their sub-frames.
   * VS Code webviews appear as child frames (name="active-frame") inside pages.
   * Returns concatenated results from all contexts with content.
   */
  async evaluateInFrames(script: string): Promise<string | null> {
    if (!this.browser) return null;

    try {
      const pages = await this.browser.pages();
      const results: string[] = [];

      for (const page of pages) {
        // Search both the page AND its child frames
        const frames = page.frames();
        for (const frame of frames) {
          try {
            const result = await frame.evaluate(script);
            if (result && typeof result === 'string' && result.trim().length > 10) {
              results.push(result.trim());
            }
          } catch {
            // Frame may not be accessible
          }
        }
      }

      if (results.length === 0) return null;
      return results.join('\n---BOUNDARY---\n');
    } catch {
      return null;
    }
  }

  async evaluateOnAllTargets(script: string): Promise<void> {
    if (!this.browser) throw new Error('CDP not connected');

    const pages = await this.browser.pages();
    for (const page of pages) {
      try {
        await page.evaluate(script);
      } catch {
        // Some targets may not be accessible
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.browser) {
      this.browser.disconnect();
      this.browser = null;
      this.page = null;
    }
  }

  private setupDisconnectHandler(): void {
    this.browser?.on('disconnected', () => {
      this.log.warn('CDP disconnected, attempting reconnect...');
      this.retryCount = 0;
      this.connectWithRetry();
    });
  }
}
