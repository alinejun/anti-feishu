import { CDPClient } from './client.js';
import { Logger } from '../utils/logger.js';

/**
 * Extracts agent reply messages as HTML (preserves Markdown rendering).
 * Each agent reply is in a container with class "animate-markdown".
 */
const GET_REPLIES_SCRIPT = `
(function() {
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
})()
`;

export class AgentMonitor {
  private cdp: CDPClient;
  private log: Logger;
  private onReply: (text: string) => void;
  private polling: NodeJS.Timeout | null = null;
  private lastMessageCount = 0;
  private lastMessageText = '';
  private isChecking = false;
  private initialized = false;

  constructor(
    cdp: CDPClient,
    log: Logger,
    onReply: (text: string) => void,
  ) {
    this.cdp = cdp;
    this.log = log;
    this.onReply = onReply;
  }

  start(intervalMs: number = 3000): void {
    if (this.polling) return;
    this.log.info(`Agent monitor started (interval: ${intervalMs}ms)`);

    this.polling = setInterval(async () => {
      if (this.isChecking) return;
      this.isChecking = true;

      try {
        if (!this.cdp.isConnectedSync()) return;

        const data = await this.findChatMessages();
        if (!data || data.count === 0) return;

        if (!this.initialized) {
          this.lastMessageCount = data.count;
          this.lastMessageText = data.lastMsg;
          this.initialized = true;
          this.log.info(`Monitor: baseline ${data.count} messages`);
          return;
        }

        // New message(s) appeared
        if (data.count > this.lastMessageCount) {
          const newMsgs = data.messages.slice(this.lastMessageCount);
          for (const msg of newMsgs) {
            if (msg.length > 3) {
              this.log.info(`Agent reply (${msg.length} chars)`);
              this.onReply(msg);
            }
          }
        } else if (data.lastMsg !== this.lastMessageText && data.lastMsg.length > 3) {
          // Content of last message changed (streaming)
          this.log.info(`Agent reply updated (${data.lastMsg.length} chars)`);
          this.onReply(data.lastMsg);
        }

        this.lastMessageCount = data.count;
        this.lastMessageText = data.lastMsg;
      } catch {
        // silently ignore
      } finally {
        this.isChecking = false;
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.polling) {
      clearInterval(this.polling);
      this.polling = null;
      this.log.info('Agent monitor stopped');
    }
  }

  resetCounter(): void {
    this.lastMessageCount = 0;
    this.lastMessageText = '';
    this.initialized = false;
  }

  /**
   * Search all browser windows, pick the one with most .animate-markdown messages.
   */
  private async findChatMessages(): Promise<{ count: number; messages: string[]; lastMsg: string } | null> {
    const page = this.cdp.getPage();
    if (!page) return null;

    const browser = page.browser();
    if (!browser) return null;

    try {
      const pages = await browser.pages();
      let best: { count: number; messages: string[]; lastMsg: string } | null = null;

      for (const p of pages) {
        try {
          const title = await Promise.race([
            p.title(),
            new Promise<string>(r => setTimeout(() => r(''), 1000)),
          ]);
          // Skip non-IDE pages
          if (title.includes('Dashboard') || title === 'Launchpad') continue;

          const raw = await Promise.race([
            p.evaluate(GET_REPLIES_SCRIPT),
            new Promise<null>(r => setTimeout(() => r(null), 2000)),
          ]);

          if (!raw || typeof raw !== 'string') continue;

          const data = JSON.parse(raw) as { count: number; messages: string[] };
          if (data.count > 0 && (!best || data.count > best.count)) {
            best = {
              count: data.count,
              messages: data.messages,
              lastMsg: data.messages[data.messages.length - 1] || '',
            };
          }
        } catch {
          // skip
        }
      }

      return best;
    } catch {
      return null;
    }
  }
}
