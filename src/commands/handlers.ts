import { CommandRouter } from './router.js';
import { CDPClient } from '../cdp/client.js';
import { AutoAcceptManager } from '../cdp/auto-accept.js';
import { FeishuBot } from '../feishu/bot.js';
import {
  buildAgentReplyCard,
  buildStatusCard,
  buildHelpCard,
  buildAutoAcceptCard,
} from '../feishu/card-builder.js';
import { splitMessage } from '../utils/helpers.js';

export function registerCommands(
  router: CommandRouter,
  cdp: CDPClient,
  bot: FeishuBot,
  autoAccept: AutoAcceptManager,
): void {

  // Default handler: send directly to Agent
  router.setDefaultHandler(async (ctx) => {
    const message = ctx.rawText;
    const connected = await cdp.isConnected();
    if (!connected) {
      await bot.sendText(ctx.chatId, '🔴 IDE not connected. Check /status');
      return;
    }

    const success = await cdp.sendMessage(message);
    if (success) {
      await bot.sendText(ctx.chatId, '✅ Sent to Agent');
    } else {
      await bot.sendText(ctx.chatId, '❌ Failed to send. Is Agent Chat panel open?');
    }
  });

  // /send <message>
  router.register('send', 'Send message to Agent', async (ctx) => {
    const message = ctx.args.join(' ');
    if (!message) {
      await bot.sendText(ctx.chatId, 'Usage: /send <message>');
      return;
    }

    const connected = await cdp.isConnected();
    if (!connected) {
      await bot.sendText(ctx.chatId, '🔴 IDE not connected. Check /status');
      return;
    }

    const success = await cdp.sendMessage(message);
    if (success) {
      await bot.sendText(ctx.chatId, '✅ Sent to Agent');
    } else {
      await bot.sendText(ctx.chatId, '❌ Failed to send. Is Agent Chat panel open?');
    }
  });

  // /latest — get latest reply as a rich card
  router.register('latest', 'Get latest Agent reply', async (ctx) => {
    const connected = await cdp.isConnected();
    if (!connected) {
      await bot.sendText(ctx.chatId, '🔴 IDE not connected');
      return;
    }

    const reply = await cdp.getLatestReply();

    // Send as interactive card for rich rendering
    try {
      const cardJson = buildAgentReplyCard(reply);
      await bot.sendCard(ctx.chatId, cardJson);
    } catch {
      // Fallback to plain text
      const chunks = splitMessage(reply);
      for (const chunk of chunks) {
        await bot.sendText(ctx.chatId, chunk);
      }
    }
  });

  // /stop
  router.register('stop', 'Stop current generation', async (ctx) => {
    const connected = await cdp.isConnected();
    if (!connected) {
      await bot.sendText(ctx.chatId, '🔴 IDE not connected');
      return;
    }

    const success = await cdp.stopGeneration();
    await bot.sendText(
      ctx.chatId,
      success ? '⏹ Generation stopped' : '⚠️ No active generation found',
    );
  });

  // /screenshot
  router.register('screenshot', 'Capture IDE screenshot', async (ctx) => {
    const connected = await cdp.isConnected();
    if (!connected) {
      await bot.sendText(ctx.chatId, '🔴 IDE not connected');
      return;
    }

    try {
      const image = await cdp.screenshot();
      await bot.sendImage(ctx.chatId, image);
    } catch (err) {
      await bot.sendText(ctx.chatId, `❌ Screenshot failed: ${err}`);
    }
  });

  // /status — rich card display
  router.register('status', 'Check IDE connection status', async (ctx) => {
    const connected = await cdp.isConnected();
    let windowTitle: string | undefined;

    if (connected) {
      try {
        windowTitle = await cdp.evaluate('document.title') as string;
      } catch {
        // ignore
      }
    }

    const cardJson = buildStatusCard(connected, autoAccept.enabled, windowTitle);
    await bot.sendCard(ctx.chatId, cardJson);
  });

  // /auto [on|off|status] — rich card display
  router.register('auto', 'Toggle Auto Accept (on/off/status)', async (ctx) => {
    const subCmd = (ctx.args[0] || 'status').toLowerCase();

    switch (subCmd) {
      case 'on': {
        const success = await autoAccept.enable();
        if (!success) {
          await bot.sendText(ctx.chatId, '❌ Failed to enable Auto Accept. Check IDE connection.');
        }
        break;
      }
      case 'off': {
        await autoAccept.disable();
        break;
      }
      case 'status':
      default: {
        let clickCount = 0;
        let diagLog: Array<{ action: string; time: number; matched?: string; cmd?: string; count?: number }> = [];

        try {
          clickCount = await cdp.evaluate('window.__AA_CLICK_COUNT || 0') as number;
          diagLog = await cdp.evaluate('(window.__AA_DIAG || []).slice(-10)') as typeof diagLog;
        } catch {
          // ignore
        }

        const cardJson = buildAutoAcceptCard(autoAccept.enabled, clickCount, diagLog);
        await bot.sendCard(ctx.chatId, cardJson);
        break;
      }
    }
  });

  // /help — rich card display
  router.register('help', 'Show available commands', async (ctx) => {
    const commands = router.getCommandList();
    const cardJson = buildHelpCard(commands);
    await bot.sendCard(ctx.chatId, cardJson);
  });
}
