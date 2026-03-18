import { CommandRouter } from './router.js';
import { CDPClient } from '../cdp/client.js';
import { AutoAcceptManager } from '../cdp/auto-accept.js';
import { FeishuBot } from '../feishu/bot.js';
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

  // /latest
  router.register('latest', 'Get latest Agent reply', async (ctx) => {
    const connected = await cdp.isConnected();
    if (!connected) {
      await bot.sendText(ctx.chatId, '🔴 IDE not connected');
      return;
    }

    const reply = await cdp.getLatestReply();
    const chunks = splitMessage(reply);
    for (const chunk of chunks) {
      await bot.sendText(ctx.chatId, chunk);
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

  // /status
  router.register('status', 'Check IDE connection status', async (ctx) => {
    const connected = await cdp.isConnected();
    const autoAcceptStatus = autoAccept.enabled ? 'ON' : 'OFF';

    const lines = [
      `📡 IDE: ${connected ? '🟢 Connected' : '🔴 Disconnected'}`,
      `⚡ Auto Accept: ${autoAcceptStatus}`,
    ];

    if (connected) {
      try {
        const title = await cdp.evaluate('document.title') as string;
        lines.push(`📝 Window: ${title}`);
      } catch {
        // ignore
      }
    }

    await bot.sendText(ctx.chatId, lines.join('\n'));
  });

  // /auto [on|off|status]
  router.register('auto', 'Toggle Auto Accept (on/off/status)', async (ctx) => {
    const subCmd = (ctx.args[0] || 'status').toLowerCase();

    switch (subCmd) {
      case 'on': {
        const success = await autoAccept.enable();
        if (!success) {
          await bot.sendText(ctx.chatId, '❌ Failed to enable Auto Accept. Check IDE connection.');
        }
        // onEvent callback will send the success message
        break;
      }
      case 'off': {
        await autoAccept.disable();
        // onEvent callback will send the message
        break;
      }
      case 'status':
      default: {
        const stats = await autoAccept.getStats();
        await bot.sendText(ctx.chatId, stats);
        break;
      }
    }
  });

  // /help
  router.register('help', 'Show available commands', async (ctx) => {
    const commands = router.getCommandList();
    const lines = [
      '📖 Anti-Feishu Commands:',
      '',
      ...commands,
      '',
      'Or just type without / to send directly to Agent.',
    ];
    await bot.sendText(ctx.chatId, lines.join('\n'));
  });
}
