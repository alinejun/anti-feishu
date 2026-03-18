import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  feishu: {
    appId: string;
    appSecret: string;
    allowedUserIds: string[];
  };
  cdp: {
    port: number;
    host: string;
  };
  monitor: {
    intervalMs: number;
    enabled: boolean;
  };
  autoAccept: {
    enabled: boolean;
    blockedCommands: string[];
    allowedCommands: string[];
  };
  log: {
    level: string;
  };
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export function loadConfig(): AppConfig {
  return {
    feishu: {
      appId: requiredEnv('FEISHU_APP_ID'),
      appSecret: requiredEnv('FEISHU_APP_SECRET'),
      allowedUserIds: optionalEnv('FEISHU_ALLOWED_USER_IDS', '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    },
    cdp: {
      port: parseInt(optionalEnv('CDP_PORT', '9222'), 10),
      host: optionalEnv('CDP_HOST', 'localhost'),
    },
    monitor: {
      intervalMs: parseInt(optionalEnv('MONITOR_INTERVAL_MS', '3000'), 10),
      enabled: optionalEnv('MONITOR_ENABLED', 'true') === 'true',
    },
    autoAccept: {
      enabled: optionalEnv('AUTO_ACCEPT_ENABLED', 'false') === 'true',
      blockedCommands: optionalEnv('AUTO_ACCEPT_BLOCKED_COMMANDS', '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
      allowedCommands: optionalEnv('AUTO_ACCEPT_ALLOWED_COMMANDS', '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    },
    log: {
      level: optionalEnv('LOG_LEVEL', 'info'),
    },
  };
}
