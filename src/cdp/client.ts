import puppeteer, { Browser, Page } from 'puppeteer-core';
import { Logger } from '../utils/logger.js';
import {
  CHAT_INPUT_SELECTORS,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTORS,
  MESSAGE_SELECTORS,
} from './selectors.js';

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

  constructor(host: string, port: number, log: Logger) {
    this.host = host;
    this.port = port;
    this.log = log;
  }

  /**
   * Connect to Antigravity IDE's Chromium via CDP.
   */
  async connect(): Promise<void> {
    const url = `http://${this.host}:${this.port}/json/version`;
    this.log.info(`Connecting to CDP at ${url}...`);

    const response = await fetch(url);
    const data = await response.json() as { webSocketDebuggerUrl: string };
    const wsUrl = data.webSocketDebuggerUrl;

    this.browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null,
    });

    // Find the main IDE window page
    const pages = await this.browser.pages();
    this.page = pages[0];

    // Try to find a better page by title
    for (const p of pages) {
      const title = await p.title().catch(() => '');
      if (title.includes('Antigravity') || title.includes('Visual Studio')) {
        this.page = p;
        break;
      }
    }

    this.setupDisconnectHandler();
    this.log.info(`CDP connected. Page title: "${await this.page?.title()}"`);
  }

  /**
   * Connect with automatic retry on failure.
   */
  async connectWithRetry(): Promise<void> {
    try {
      await this.connect();
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
   */
  async sendMessage(text: string): Promise<boolean> {
    if (!this.page) throw new Error('CDP not connected');

    const inputSelectors = JSON.stringify(CHAT_INPUT_SELECTORS);
    const sendSelectors = JSON.stringify(SEND_BUTTON_SELECTORS);

    return await this.page.evaluate(
      (msg: string, inputSels: string, sendSels: string) => {
        const inputSelectors: string[] = JSON.parse(inputSels);
        const sendSelectors: string[] = JSON.parse(sendSels);

        // Recursive Shadow DOM query
        function queryShadow(root: Element | Document | ShadowRoot, selector: string): Element | null {
          const result = root.querySelector(selector);
          if (result) return result;
          const allElements = root.querySelectorAll('*');
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = queryShadow(el.shadowRoot, selector);
              if (found) return found;
            }
          }
          return null;
        }

        // Find chat input using fallback selectors
        let chatInput: Element | null = null;
        for (const sel of inputSelectors) {
          chatInput = queryShadow(document, sel);
          if (chatInput) break;
        }
        if (!chatInput) return false;

        // Set textarea value using native setter to trigger React
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value',
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(chatInput, msg);
        } else {
          (chatInput as HTMLTextAreaElement).value = msg;
        }
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
        chatInput.dispatchEvent(new Event('change', { bubbles: true }));

        // Try clicking send button
        for (const sel of sendSelectors) {
          const sendBtn = queryShadow(document, sel);
          if (sendBtn) {
            (sendBtn as HTMLElement).click();
            return true;
          }
        }

        // Fallback: simulate Enter key
        chatInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          bubbles: true,
        }));
        return true;
      },
      text,
      inputSelectors,
      sendSelectors,
    );
  }

  /**
   * Get the latest Agent reply text.
   */
  async getLatestReply(): Promise<string> {
    if (!this.page) throw new Error('CDP not connected');

    const messageSelectors = JSON.stringify(MESSAGE_SELECTORS);

    return await this.page.evaluate((msgSels: string) => {
      const selectors: string[] = JSON.parse(msgSels);

      function queryShadowAll(root: Element | Document | ShadowRoot, selector: string): Element[] {
        const results: Element[] = Array.from(root.querySelectorAll(selector));
        const allElements = root.querySelectorAll('*');
        for (const el of allElements) {
          if (el.shadowRoot) {
            results.push(...queryShadowAll(el.shadowRoot, selector));
          }
        }
        return results;
      }

      for (const sel of selectors) {
        const messages = queryShadowAll(document, sel);
        if (messages.length > 0) {
          const lastMessage = messages[messages.length - 1];
          return lastMessage.textContent?.trim() || 'Empty message';
        }
      }
      return 'No messages found';
    }, messageSelectors);
  }

  /**
   * Get the count of messages in the chat.
   */
  async getMessageCount(): Promise<number> {
    if (!this.page) throw new Error('CDP not connected');

    const messageSelectors = JSON.stringify(MESSAGE_SELECTORS);

    return await this.page.evaluate((msgSels: string) => {
      const selectors: string[] = JSON.parse(msgSels);

      function queryShadowAll(root: Element | Document | ShadowRoot, selector: string): Element[] {
        const results: Element[] = Array.from(root.querySelectorAll(selector));
        const allElements = root.querySelectorAll('*');
        for (const el of allElements) {
          if (el.shadowRoot) {
            results.push(...queryShadowAll(el.shadowRoot, selector));
          }
        }
        return results;
      }

      for (const sel of selectors) {
        const messages = queryShadowAll(document, sel);
        if (messages.length > 0) return messages.length;
      }
      return 0;
    }, messageSelectors);
  }

  /**
   * Stop the current Agent generation.
   */
  async stopGeneration(): Promise<boolean> {
    if (!this.page) throw new Error('CDP not connected');

    const stopSelectors = JSON.stringify(STOP_BUTTON_SELECTORS);

    return await this.page.evaluate((stopSels: string) => {
      const selectors: string[] = JSON.parse(stopSels);

      function queryShadow(root: Element | Document | ShadowRoot, selector: string): Element | null {
        const result = root.querySelector(selector);
        if (result) return result;
        const allElements = root.querySelectorAll('*');
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = queryShadow(el.shadowRoot, selector);
            if (found) return found;
          }
        }
        return null;
      }

      for (const sel of selectors) {
        const stopBtn = queryShadow(document, sel);
        if (stopBtn) {
          (stopBtn as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, stopSelectors);
  }

  /**
   * Take a screenshot of the IDE.
   */
  async screenshot(): Promise<Buffer> {
    if (!this.page) throw new Error('CDP not connected');
    const screenshot = await this.page.screenshot({
      type: 'png',
      fullPage: false,
    });
    return Buffer.from(screenshot);
  }

  /**
   * Check if CDP is connected and responsive.
   */
  async isConnected(): Promise<boolean> {
    try {
      if (!this.page) return false;
      await this.page.evaluate(() => document.title);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Evaluate JavaScript on the main page.
   */
  async evaluate(script: string): Promise<any> {
    if (!this.page) throw new Error('CDP not connected');
    return await this.page.evaluate(script);
  }

  /**
   * Evaluate JavaScript on all targets (main page + iframes).
   * For Auto Accept injection into Agent Chat iframes.
   */
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

  /**
   * Disconnect from CDP.
   */
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
