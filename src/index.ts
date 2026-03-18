import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { FeishuBot } from './feishu/bot.js';
import { CDPClient } from './cdp/client.js';
import { AgentMonitor } from './cdp/monitor.js';
import { AutoAcceptManager } from './cdp/auto-accept.js';
import { CommandRouter } from './commands/router.js';
import { registerCommands } from './commands/handlers.js';
import { splitMessage } from './utils/helpers.js';
import { buildAgentReplyCard } from './feishu/card-builder.js';

async function main() {
  // 1. Load config
  const config = loadConfig();
  const log = createLogger(config.log.level);

  log.info('🚀 Anti-Feishu starting...');

  // 2. Initialize CDP client
  const cdp = new CDPClient(config.cdp.host, config.cdp.port, log);
  log.info(`Connecting to CDP at ${config.cdp.host}:${config.cdp.port}...`);
  await cdp.connectWithRetry();

  // 3. Initialize Feishu Bot
  const bot = new FeishuBot(
    config.feishu.appId,
    config.feishu.appSecret,
    config.feishu.allowedUserIds,
    log,
  );

  // 4. Initialize Auto Accept
  const autoAccept = new AutoAcceptManager(
    cdp,
    log,
    {
      enabled: config.autoAccept.enabled,
      blockedCommands: config.autoAccept.blockedCommands,
      allowedCommands: config.autoAccept.allowedCommands,
    },
    // onEvent: push Auto Accept events to Feishu
    async (event: string) => {
      const chatId = bot.getLastChatId();
      if (chatId) {
        await bot.sendText(chatId, event);
      }
    },
  );

  // 5. Register commands
  const router = new CommandRouter(log);
  registerCommands(router, cdp, bot, autoAccept);

  // 6. Set message handler on bot
  bot.setMessageHandler(async (text, chatId, userId) => {
    await router.dispatch(text, chatId, userId);
  });

  // 7. Start Agent reply monitor — push Agent replies as rich cards
  const monitor = new AgentMonitor(cdp, log, async (reply: string) => {
    const chatId = bot.getLastChatId();
    if (!chatId) return;

    try {
      const cardJson = buildAgentReplyCard(reply);
      await bot.sendCard(chatId, cardJson);
    } catch {
      // Fallback to plain text
      const chunks = splitMessage(reply);
      for (const chunk of chunks) {
        await bot.sendText(chatId, `🤖 Agent:\n\n${chunk}`);
      }
    }
  });

  if (config.monitor.enabled) {
    monitor.start(config.monitor.intervalMs);
  }

  // 8. Auto-enable Auto Accept if configured
  if (config.autoAccept.enabled) {
    // Wait a bit for CDP to fully connect
    setTimeout(async () => {
      const connected = await cdp.isConnected();
      if (connected) {
        await autoAccept.enable();
      } else {
        log.warn('Auto Accept not started: CDP not connected yet');
      }
    }, 3000);
  }

  // 9. Start Feishu WebSocket connection
  await bot.start();

  log.info('✅ Anti-Feishu is running!');
  log.info(`   CDP: ${config.cdp.host}:${config.cdp.port}`);
  log.info(`   Monitor: ${config.monitor.enabled ? 'ON' : 'OFF'}`);
  log.info(`   Auto Accept: ${config.autoAccept.enabled ? 'ON' : 'OFF'}`);

  // Graceful shutdown
  const shutdown = () => {
    log.info('Shutting down...');
    monitor.stop();
    cdp.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
