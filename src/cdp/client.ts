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

    const idx = parseInt(target);
    if (!isNaN(idx) && idx >= 0 && idx < pages.length) {
      this.page = pages[idx];
      return await this.page.title();
    }

    for (const p of pages) {
      const title = await p.title().catch(() => '');
      if (title.toLowerCase().includes(target.toLowerCase())) {
        this.page = p;
        this.lastTargetTitle = target;
        return title;
      }
    }

    throw new Error(`Window not found: ${target}`);
  }

  /**
   * List Agent chat sessions (tabs in the agent panel).
   */
  async listAgentSessions(): Promise<{ index: number; title: string; active: boolean }[]> {
    if (!this.page) return [];

    const result = await this.page.evaluate(`(function() {
      // Agent sessions are in .tab elements within panels
      var tabs = document.querySelectorAll('.tab');
      var sessions = [];
      for (var i = 0; i < tabs.length; i++) {
        var text = (tabs[i].textContent || '').trim();
        var isActive = tabs[i].classList.contains('active');
        // Filter: agent session tabs typically have conversation-like names
        // Skip very short tabs (icons), non-text tabs, and known file extensions
        if (text.length > 0 && text.length < 80 &&
            !text.match(/\\.(ts|js|css|html|json|md|py|rs|go|toml|yaml|sh|cjs|mjs)$/i)) {
          sessions.push({ index: i, title: text, active: isActive });
        }
      }
      return JSON.stringify(sessions);
    })()`);

    try {
      return JSON.parse(result as string);
    } catch {
      return [];
    }
  }

  /**
   * Switch to an Agent session by tab index.
   */
  async switchAgentSession(tabIndex: number): Promise<boolean> {
    if (!this.page) return false;

    return await this.page.evaluate(`(function() {
      var tabs = document.querySelectorAll('.tab');
      if (${tabIndex} < tabs.length) {
        tabs[${tabIndex}].click();
        return true;
      }
      return false;
    })()`) as boolean;
  }

  /**
   * Create a new Agent chat session (Cmd+L / Ctrl+L).
   */
  async newAgentSession(): Promise<boolean> {
    if (!this.page) return false;

    const isMac = process.platform === 'darwin';
    await this.page.keyboard.down(isMac ? 'Meta' : 'Control');
    await this.page.keyboard.press('l');
    await this.page.keyboard.up(isMac ? 'Meta' : 'Control');

    return true;
  }

  /**
   * Close an Agent session tab by index.
   */
  async closeAgentSession(tabIndex: number): Promise<boolean> {
    if (!this.page) return false;

    return await this.page.evaluate(`(function() {
      var tabs = document.querySelectorAll('.tab');
      if (${tabIndex} >= tabs.length) return false;
      // Find close button within the tab
      var closeBtn = tabs[${tabIndex}].querySelector('.tab-close, [class*="close"], .codicon-close');
      if (closeBtn) {
        closeBtn.click();
        return true;
      }
      return false;
    })()`) as boolean;
  }

  /**
   * List open editor files (tabs).
   */
  async listOpenFiles(): Promise<{ index: number; title: string; active: boolean }[]> {
    if (!this.page) return [];

    const result = await this.page.evaluate(`(function() {
      var containers = document.querySelectorAll('.tabs-container .tab, .editor-tabs .tab');
      var files = [];
      for (var i = 0; i < containers.length; i++) {
        var text = (containers[i].textContent || '').trim();
        var isActive = containers[i].classList.contains('active');
        if (text.length > 0 && text.length < 100) {
          files.push({ index: i, title: text, active: isActive });
        }
      }
      // Fallback: if no tabs-container found, try all .tab with file extensions
      if (files.length === 0) {
        var allTabs = document.querySelectorAll('.tab');
        for (var j = 0; j < allTabs.length; j++) {
          var t = (allTabs[j].textContent || '').trim();
          var active = allTabs[j].classList.contains('active');
          if (t.length > 0 && t.length < 100 &&
              t.match(/\\.(ts|js|css|html|json|md|py|rs|go|toml|yaml|sh|cjs|mjs|vue|tsx|jsx)$/i)) {
            files.push({ index: j, title: t, active: active });
          }
        }
      }
      return JSON.stringify(files);
    })()`);

    try {
      return JSON.parse(result as string);
    } catch {
      return [];
    }
  }

  /**
   * Switch to an open file tab by index.
   */
  async switchFile(tabIndex: number): Promise<boolean> {
    if (!this.page) return false;

    return await this.page.evaluate(`(function() {
      var tabs = document.querySelectorAll('.tabs-container .tab, .editor-tabs .tab');
      if (tabs.length === 0) tabs = document.querySelectorAll('.tab');
      if (${tabIndex} < tabs.length) {
        tabs[${tabIndex}].click();
        return true;
      }
      return false;
    })()`) as boolean;
  }

  /**
   * Close a file tab by index.
   */
  async closeFile(tabIndex: number): Promise<boolean> {
    if (!this.page) return false;

    // First switch to the tab, then use Cmd+W
    await this.switchFile(tabIndex);
    await new Promise(r => setTimeout(r, 200));

    const isMac = process.platform === 'darwin';
    await this.page.keyboard.down(isMac ? 'Meta' : 'Control');
    await this.page.keyboard.press('w');
    await this.page.keyboard.up(isMac ? 'Meta' : 'Control');

    return true;
  }

  /**
   * List currently open workspaces (CDP targets / Cursor windows).
   */
  async listWorkspaces(): Promise<{ index: number; title: string; active: boolean }[]> {
    if (!this.browser) return [];
    const pages = await this.browser.pages();
    const currentTitle = this.page ? await this.page.title().catch(() => '') : '';
    const results: { index: number; title: string; active: boolean }[] = [];

    for (let i = 0; i < pages.length; i++) {
      const title = await pages[i].title().catch(() => 'N/A');
      results.push({
        index: i,
        title,
        active: title === currentTitle,
      });
    }
    return results;
  }

  /**
   * Switch to a workspace by index.
   */
  async switchWorkspace(index: number): Promise<string> {
    if (!this.browser) throw new Error('CDP not connected');
    const pages = await this.browser.pages();

    if (index < 0 || index >= pages.length) {
      throw new Error(`Workspace index out of range: ${index}`);
    }

    this.page = pages[index];
    // Bring the window to front so screencast can capture it
    await this.page.bringToFront().catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    const title = await this.page.title().catch(() => 'Unknown');
    this.lastTargetTitle = title;
    return title;
  }

  /**
   * Get the IDE viewport size for coordinate mapping.
   */
  async getViewportSize(): Promise<{ width: number; height: number }> {
    if (!this.page) return { width: 1920, height: 1080 };

    const size = await this.page.evaluate(`(function() {
      return JSON.stringify({ width: window.innerWidth, height: window.innerHeight });
    })()`);

    try {
      return JSON.parse(size as string);
    } catch {
      return { width: 1920, height: 1080 };
    }
  }

  /**
   * Dispatch mouse event to the IDE page.
   */
  async dispatchMouseEvent(
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    x: number,
    y: number,
    _button?: 'left' | 'right' | 'middle',
  ): Promise<void> {
    if (!this.page) return;

    const px = Math.round(x);
    const py = Math.round(y);

    if (type === 'mousePressed') {
      await this.page.mouse.move(px, py);
      await this.page.mouse.down();
    } else if (type === 'mouseReleased') {
      await this.page.mouse.move(px, py);
      await this.page.mouse.up();
    } else if (type === 'mouseMoved') {
      await this.page.mouse.move(px, py);
    }
  }

  /**
   * Perform a click at coordinates.
   */
  async clickAt(x: number, y: number): Promise<void> {
    if (!this.page) return;
    await this.page.mouse.click(x, y);
  }

  /**
   * Perform a drag from one point to another.
   */
  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    if (!this.page) return;
    await this.page.mouse.move(fromX, fromY);
    await this.page.mouse.down();
    // Move in steps for smooth dragging
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const x = fromX + (toX - fromX) * (i / steps);
      const y = fromY + (toY - fromY) * (i / steps);
      await this.page.mouse.move(x, y);
    }
    await this.page.mouse.up();
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
    if (!this.browser) throw new Error('CDP not connected');

    const pages = await this.browser.pages();

    for (const p of pages) {
      try {
        const title = await Promise.race([
          p.title(),
          new Promise<string>(r => setTimeout(() => r(''), 1000)),
        ]);
        if (title.includes('Dashboard') || title === 'Launchpad') continue;

        const result = await Promise.race([
          p.evaluate(`(function() {
            try {
              var els = document.querySelectorAll('.animate-markdown');
              if (els.length === 0) return '';
              var last = els[els.length - 1];
              var html = (last.innerHTML || '').trim();
              return html || '';
            } catch(e) { return ''; }
          })()`),
          new Promise<string>(r => setTimeout(() => r(''), 2000)),
        ]);

        if (result && typeof result === 'string' && result.length > 3) {
          return result;
        }
      } catch {
        // skip inaccessible pages
      }
    }

    return 'No messages found';
  }

  async getMessageCount(): Promise<number> {
    if (!this.page) throw new Error('CDP not connected');

    const result = await this.page.evaluate(`(function() {
      var els = document.querySelectorAll('.animate-markdown');
      return els.length;
    })()`);

    return result as number;
  }

  async stopGeneration(): Promise<boolean> {
    if (!this.page) throw new Error('CDP not connected');

    // Strategy 1 (most reliable): Press Escape — universally stops generation
    this.log.info('stopGeneration: pressing Escape');
    await this.page.keyboard.press('Escape');

    // Also try clicking a stop button if one exists (belt-and-suspenders)
    const result = await this.page.evaluate(`(function() {
      // Try specific stop button selectors
      var selectors = [
        '[data-testid="stop-button"]',
        'button[aria-label="Stop"]',
        'button[aria-label="stop"]',
        'button[title="Stop generating"]',
        'button[title="Stop"]',
        'button[aria-label="Stop generation"]',
        'button[aria-label="Stop Generation"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var el = document.querySelector(selectors[s]);
        if (el) { el.click(); return 'selector:' + selectors[s]; }
      }

      // Try stop icon classes (VS Code / Cursor)
      var iconClasses = ['codicon-debug-stop', 'codicon-stop-circle', 'codicon-stop'];
      for (var ic = 0; ic < iconClasses.length; ic++) {
        var icons = document.querySelectorAll('.' + iconClasses[ic]);
        for (var j = 0; j < icons.length; j++) {
          var btn = icons[j].closest('button');
          if (btn) { btn.click(); return 'icon:' + iconClasses[ic]; }
        }
      }

      // Narrow text search: only match "stop" (not "cancel" which hits unrelated dialogs)
      var buttons = document.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        var text = (buttons[i].textContent || '').trim().toLowerCase();
        var label = (buttons[i].getAttribute('aria-label') || '').toLowerCase();
        var title = (buttons[i].getAttribute('title') || '').toLowerCase();
        var all = text + ' ' + label + ' ' + title;
        if (all.indexOf('stop') !== -1 || all.indexOf('interrupt') !== -1) {
          buttons[i].click();
          return 'text:' + text + '|label:' + label;
        }
      }

      return false;
    })()`);

    if (result && result !== false) {
      this.log.info('stopGeneration: also clicked via ' + result);
    }

    return true;
  }

  /**
   * Execute a common IDE action via keyboard shortcut.
   * Used by H5 quick action buttons to bypass imprecise screencast clicks.
   */
  async executeAction(action: string): Promise<{ success: boolean; message: string }> {
    if (!this.page) return { success: false, message: 'CDP not connected' };

    const isMac = process.platform === 'darwin';
    const mod = isMac ? 'Meta' : 'Control';

    try {
      switch (action) {
        case 'stop':
          await this.stopGeneration();
          return { success: true, message: 'Generation stopped' };

        case 'accept':
          // Accept current suggestion (Cmd/Ctrl+Y or click Accept in Antigravity)
          await this.page.evaluate(`(function() {
            // Try to find and click Accept/Apply buttons
            var btns = document.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
              var text = (btns[i].textContent || '').trim().toLowerCase();
              if ((text === 'accept' || text === 'apply' || text === 'accept all'
                  || text.indexOf('accept') === 0)
                  && btns[i].offsetParent !== null && !btns[i].disabled) {
                btns[i].click();
                return 'clicked:' + text;
              }
            }
            return false;
          })()`);
          return { success: true, message: 'Accept triggered' };

        case 'reject':
          // Reject current suggestion
          await this.page.evaluate(`(function() {
            var btns = document.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
              var text = (btns[i].textContent || '').trim().toLowerCase();
              if ((text === 'reject' || text === 'reject all' || text === 'dismiss'
                  || text.indexOf('reject') === 0)
                  && btns[i].offsetParent !== null && !btns[i].disabled) {
                btns[i].click();
                return 'clicked:' + text;
              }
            }
            return false;
          })()`);
          return { success: true, message: 'Reject triggered' };

        case 'new-chat':
          // New Agent session (Cmd/Ctrl + L)
          await this.page.keyboard.down(mod);
          await this.page.keyboard.press('l');
          await this.page.keyboard.up(mod);
          return { success: true, message: 'New chat created' };

        case 'save':
          // Save file (Cmd/Ctrl + S)
          await this.page.keyboard.down(mod);
          await this.page.keyboard.press('s');
          await this.page.keyboard.up(mod);
          return { success: true, message: 'File saved' };

        case 'undo':
          // Undo (Cmd/Ctrl + Z)
          await this.page.keyboard.down(mod);
          await this.page.keyboard.press('z');
          await this.page.keyboard.up(mod);
          return { success: true, message: 'Undo triggered' };

        case 'redo':
          // Redo (Cmd/Ctrl + Shift + Z)
          await this.page.keyboard.down(mod);
          await this.page.keyboard.down('Shift');
          await this.page.keyboard.press('z');
          await this.page.keyboard.up('Shift');
          await this.page.keyboard.up(mod);
          return { success: true, message: 'Redo triggered' };

        case 'toggle-terminal':
          // Toggle terminal (Ctrl + `)
          await this.page.keyboard.down('Control');
          await this.page.keyboard.press('`');
          await this.page.keyboard.up('Control');
          return { success: true, message: 'Terminal toggled' };

        case 'toggle-sidebar':
          // Toggle sidebar (Cmd/Ctrl + B)
          await this.page.keyboard.down(mod);
          await this.page.keyboard.press('b');
          await this.page.keyboard.up(mod);
          return { success: true, message: 'Sidebar toggled' };

        case 'command-palette':
          // Command palette (Cmd/Ctrl + Shift + P)
          await this.page.keyboard.down(mod);
          await this.page.keyboard.down('Shift');
          await this.page.keyboard.press('p');
          await this.page.keyboard.up('Shift');
          await this.page.keyboard.up(mod);
          return { success: true, message: 'Command palette opened' };

        case 'focus-agent':
          // Focus Agent chat (Cmd/Ctrl + L)
          await this.page.keyboard.down(mod);
          await this.page.keyboard.press('l');
          await this.page.keyboard.up(mod);
          return { success: true, message: 'Agent focused' };

        default:
          return { success: false, message: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { success: false, message: `Action failed: ${err}` };
    }
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
