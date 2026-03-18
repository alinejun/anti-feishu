/**
 * DOM Selectors for Antigravity Agent Chat.
 *
 * These selectors are centralized here for easy maintenance
 * when Antigravity IDE updates change the DOM structure.
 *
 * IMPORTANT: These are initial guesses and MUST be verified
 * by inspecting the actual Agent Chat DOM via CDP.
 * Launch Antigravity with --remote-debugging-port=9222,
 * then open http://localhost:9222 in Chrome to inspect.
 */

/** Selectors for the chat input area (textarea or contenteditable) */
export const CHAT_INPUT_SELECTORS = [
  'textarea[data-testid="chat-input"]',
  '.chat-input textarea',
  '[role="textbox"]',
  'textarea.inputarea',
  'textarea',
];

/** Selectors for the send button */
export const SEND_BUTTON_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label="Send"]',
  'button[title="Send"]',
  'button[aria-label="Submit"]',
];

/** Selectors for the stop generation button */
export const STOP_BUTTON_SELECTORS = [
  '[data-testid="stop-button"]',
  'button[aria-label="Stop"]',
  'button[title="Stop generating"]',
  'button[aria-label="Cancel"]',
];

/** Selectors for message content elements */
export const MESSAGE_SELECTORS = [
  '.message-content',
  '[data-testid="message"]',
  '.chat-message',
  '.response-content',
];

/** Selectors for identifying the Agent Chat panel */
export const AGENT_PANEL_SELECTORS = [
  '[data-testid="agent-panel"]',
  '.agent-chat',
  '[aria-label="Agent"]',
];

/**
 * Button text keywords for Auto Accept.
 * Matched case-insensitively against button textContent.
 */
export const AUTO_ACCEPT_BUTTON_TEXTS = [
  'accept',
  'run',
  'allow',
  'approve',
  'retry',
  'continue',
  'confirm',
];

/**
 * Expand/preview buttons — these are UI chrome, not command executors.
 * No command filtering is applied to these.
 */
export const AUTO_ACCEPT_EXPAND_TEXTS = [
  'expand',
  'requires input',
];

/**
 * Default blocked commands for Auto Accept safety.
 */
export const DEFAULT_BLOCKED_COMMANDS = [
  'rm -rf',
  'rm -r /',
  'sudo',
  'mkfs',
  'format',
  'drop table',
  'drop database',
  'truncate',
  'shutdown',
  'reboot',
  ':(){:|:&};:',
  'dd if=',
  'chmod -R 777',
  'git push --force',
  'git reset --hard',
];
