import { CDPClient } from './client.js';
import { Logger } from '../utils/logger.js';

export class AgentMonitor {
  private cdp: CDPClient;
  private log: Logger;
  private onReply: (text: string) => void;
  private polling: NodeJS.Timeout | null = null;
  private lastMessageCount = 0;
  private isChecking = false;

  constructor(
    cdp: CDPClient,
    log: Logger,
    onReply: (text: string) => void,
  ) {
    this.cdp = cdp;
    this.log = log;
    this.onReply = onReply;
  }

  /**
   * Start polling for new Agent replies.
   */
  start(intervalMs: number = 3000): void {
    if (this.polling) return;

    this.log.info(`Agent monitor started (interval: ${intervalMs}ms)`);

    this.polling = setInterval(async () => {
      if (this.isChecking) return;
      this.isChecking = true;

      try {
        const connected = await this.cdp.isConnected();
        if (!connected) return;

        const currentCount = await this.cdp.getMessageCount();

        if (currentCount > this.lastMessageCount && this.lastMessageCount > 0) {
          // New message appeared
          const latestReply = await this.cdp.getLatestReply();
          this.log.info(`New agent reply detected (messages: ${currentCount})`);
          this.onReply(latestReply);
        }

        this.lastMessageCount = currentCount;
      } catch (err) {
        // CDP disconnected — silently ignore
      } finally {
        this.isChecking = false;
      }
    }, intervalMs);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.polling) {
      clearInterval(this.polling);
      this.polling = null;
      this.log.info('Agent monitor stopped');
    }
  }

  /**
   * Reset message counter (e.g., when sending a new message).
   */
  resetCounter(): void {
    this.lastMessageCount = 0;
  }
}
