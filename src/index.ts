import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { FeishuBot } from './feishu/bot.js';
import { CDPClient } from './cdp/client.js';
import { AgentMonitor } from './cdp/monitor.js';
import { AutoAcceptManager } from './cdp/auto-accept.js';
import { CommandRouter } from './commands/router.js';
import { registerCommands } from './commands/handlers.js';
import { splitMessage, htmlToMarkdown } from './utils/helpers.js';
import { buildAgentReplyCard } from './feishu/card-builder.js';
import { H5Server } from './h5/server.js';

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

  // 7. Start Agent reply monitor — push Agent replies as rich cards + H5
  const monitor = new AgentMonitor(cdp, log, async (reply: string) => {
    const chatId = bot.getLastChatId();

    // Push to H5 dashboard
    if (h5Server) {
      h5Server.pushAgentOutput(reply);
    }

    if (!chatId) return;

    try {
      const cardJson = buildAgentReplyCard(reply);
      await bot.sendCard(chatId, cardJson);
    } catch {
      // Fallback to plain text
      const plainText = htmlToMarkdown(reply);
      const chunks = splitMessage(plainText);
      for (const chunk of chunks) {
        await bot.sendText(chatId, `🤖 Agent:\n\n${chunk}`);
      }
    }
  });

  if (config.monitor.enabled) {
    monitor.start(config.monitor.intervalMs);
  }

  // 7.5 Start H5 Dashboard
  let h5Server: H5Server | null = null;
  if (config.h5.enabled) {
    h5Server = new H5Server(cdp, log, config.h5.port);

    // Wire up H5 actions
    h5Server.onAgentSend = async (text: string) => {
      const connected = await cdp.isConnected();
      if (!connected) return false;
      return await cdp.sendMessage(text);
    };

    h5Server.onStop = async () => {
      return await cdp.stopGeneration();
    };

    h5Server.onScreenshot = async () => {
      return await cdp.screenshot();
    };

    h5Server.onAutoAcceptToggle = async (enable: boolean) => {
      if (enable) {
        await autoAccept.enable();
      } else {
        await autoAccept.disable();
      }
      h5Server!.setAutoAcceptStatus(autoAccept.enabled);
    };

    await h5Server.start();
    h5Server.setFeishuStatus(true); // Feishu starts after this
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
  log.info(`   H5 Dashboard: ${config.h5.enabled ? `http://localhost:${config.h5.port} | https://localhost:${config.h5.port + 1}` : 'OFF'}`);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info('Shutting down...');

    // Hard timeout: force exit after 5s no matter what
    const forceTimer = setTimeout(() => {
      log.warn('Shutdown timed out, forcing exit');
      process.exit(1);
    }, 5000);

    try {
      monitor.stop();
      if (h5Server) await h5Server.stop();
      await cdp.disconnect();
    } catch (err) {
      log.error(`Shutdown error: ${err}`);
    }

    clearTimeout(forceTimer);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
