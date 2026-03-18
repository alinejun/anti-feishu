import { Logger } from '../utils/logger.js';

export interface CommandContext {
  chatId: string;
  args: string[];
  rawText: string;
  userId: string;
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

export class CommandRouter {
  private commands = new Map<string, { handler: CommandHandler; description: string }>();
  private log: Logger;
  private defaultHandler: CommandHandler | null = null;

  constructor(log: Logger) {
    this.log = log;
  }

  /**
   * Register a command handler.
   */
  register(name: string, description: string, handler: CommandHandler): void {
    this.commands.set(name.toLowerCase(), { handler, description });
  }

  /**
   * Set the default handler for non-command messages.
   */
  setDefaultHandler(handler: CommandHandler): void {
    this.defaultHandler = handler;
  }

  /**
   * Get all registered command descriptions (for /help).
   */
  getCommandList(): string[] {
    const lines: string[] = [];
    for (const [name, { description }] of this.commands) {
      lines.push(`/${name} - ${description}`);
    }
    return lines;
  }

  /**
   * Dispatch a message to the appropriate handler.
   */
  async dispatch(text: string, chatId: string, userId: string): Promise<void> {
    // Check if it's a command (starts with /)
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      const entry = this.commands.get(cmd);
      if (entry) {
        this.log.info(`Executing command: /${cmd} ${args.join(' ')}`);
        try {
          await entry.handler({ chatId, args, rawText: text, userId });
        } catch (err) {
          this.log.error(`Command /${cmd} failed: ${err}`);
        }
        return;
      }

      // Unknown command — fall through to default handler
      this.log.warn(`Unknown command: /${cmd}`);
    }

    // Non-command message: send directly to Agent
    if (this.defaultHandler) {
      try {
        await this.defaultHandler({ chatId, args: [text], rawText: text, userId });
      } catch (err) {
        this.log.error(`Default handler failed: ${err}`);
      }
    }
  }
}
