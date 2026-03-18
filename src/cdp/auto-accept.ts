import { CDPClient } from './client.js';
import { Logger } from '../utils/logger.js';
import {
  AUTO_ACCEPT_BUTTON_TEXTS,
  AUTO_ACCEPT_EXPAND_TEXTS,
} from './selectors.js';

export interface AutoAcceptConfig {
  enabled: boolean;
  blockedCommands: string[];
  allowedCommands: string[];
}

export class AutoAcceptManager {
  private cdp: CDPClient;
  private log: Logger;
  private config: AutoAcceptConfig;
  private _enabled = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private onEvent: (event: string) => void;

  constructor(
    cdp: CDPClient,
    log: Logger,
    config: AutoAcceptConfig,
    onEvent: (event: string) => void,
  ) {
    this.cdp = cdp;
    this.log = log;
    this.config = config;
    this.onEvent = onEvent;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Enable Auto Accept by injecting DOMObserver script via CDP.
   */
  async enable(): Promise<boolean> {
    if (this._enabled) return true;

    try {
      const connected = await this.cdp.isConnected();
      if (!connected) {
        this.log.warn('Cannot enable Auto Accept: CDP not connected');
        return false;
      }

      const script = this.buildDOMObserverScript();
      await this.cdp.evaluateOnAllTargets(script);

      this.startHeartbeat();
      this._enabled = true;
      this.log.info('Auto Accept enabled');
      this.onEvent('⚡ Auto Accept enabled');
      return true;
    } catch (err) {
      this.log.error(`Auto Accept enable failed: ${err}`);
      this.onEvent(`❌ Auto Accept failed: ${err}`);
      return false;
    }
  }

  /**
   * Disable Auto Accept (pause observers, don't remove them).
   */
  async disable(): Promise<void> {
    if (!this._enabled) return;

    try {
      await this.cdp.evaluateOnAllTargets('window.__AA_PAUSED = true;');
    } catch {
      // ignore
    }

    this.stopHeartbeat();
    this._enabled = false;
    this.log.info('Auto Accept disabled');
    this.onEvent('⏸ Auto Accept disabled');
  }

  /**
   * Get current Auto Accept statistics.
   */
  async getStats(): Promise<string> {
    let clickCount = 0;
    let diagLog: Array<{ action: string; time: number; matched?: string; cmd?: string; count?: number }> = [];

    try {
      clickCount = await this.cdp.evaluate('window.__AA_CLICK_COUNT || 0') as number;
      diagLog = await this.cdp.evaluate('(window.__AA_DIAG || []).slice(-10)') as typeof diagLog;
    } catch {
      // CDP might be disconnected
    }

    const lines = [
      `⚡ Auto Accept: ${this._enabled ? 'ON' : 'OFF'}`,
      `📊 Total Clicks: ${clickCount}`,
      '',
      '📋 Recent Activity:',
    ];

    if (diagLog.length === 0) {
      lines.push('  (no activity yet)');
    } else {
      for (const d of diagLog) {
        const time = new Date(d.time).toLocaleTimeString();
        if (d.action === 'CLICKED') {
          lines.push(`  ✅ ${time} clicked: ${d.matched}`);
        } else if (d.action === 'BLOCKED') {
          lines.push(`  🚫 ${time} blocked: ${d.cmd}`);
        } else if (d.action === 'CIRCUIT_BREAKER') {
          lines.push(`  ⚠️ ${time} circuit breaker (retries: ${d.count})`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Build the DOMObserver injection script.
   * Reference: yazanbaker94/AntiGravity-AutoAccept v3.0 DOMObserver.js
   */
  private buildDOMObserverScript(): string {
    const buttonTexts = JSON.stringify(AUTO_ACCEPT_BUTTON_TEXTS);
    const expandTexts = JSON.stringify(AUTO_ACCEPT_EXPAND_TEXTS);
    const blocked = JSON.stringify(this.config.blockedCommands);
    const allowed = JSON.stringify(this.config.allowedCommands);
    const hasFilters =
      this.config.blockedCommands.length > 0 ||
      this.config.allowedCommands.length > 0;

    return `(function() {
  if (window.__AA_OBSERVER) return 'already-installed';
  window.__AA_PAUSED = false;

  var BUTTON_TEXTS = ${buttonTexts};
  var EXPAND_TEXTS = ${expandTexts};
  var BLOCKED_COMMANDS = ${blocked};
  var ALLOWED_COMMANDS = ${allowed};
  var HAS_FILTERS = ${hasFilters};
  var COOLDOWN_MS = 2000;
  var clickCooldowns = {};

  function findButton(root, texts) {
    var buttons = root.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.getAttribute('data-aa-blocked')) continue;
      var text = (btn.textContent || '').trim().toLowerCase();
      for (var t = 0; t < texts.length; t++) {
        if (text.indexOf(texts[t]) !== -1) {
          var key = texts[t] + ':' + text.substring(0, 30);
          if (clickCooldowns[key] && Date.now() - clickCooldowns[key] < COOLDOWN_MS) continue;
          return { node: btn, matchedText: texts[t] };
        }
      }
    }
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) {
        var found = findButton(all[j].shadowRoot, texts);
        if (found) return found;
      }
    }
    return null;
  }

  function extractCommandText(btn) {
    var el = btn;
    for (var i = 0; i < 8 && el && el !== document.body; i++) {
      el = el.parentElement;
      if (!el) break;
      var codes = el.querySelectorAll('pre, code');
      if (codes.length > 0) {
        var allText = '';
        for (var j = 0; j < codes.length; j++) {
          allText += ' ' + (codes[j].textContent || '').trim();
        }
        allText = allText.trim();
        if (allText.length > 0) return allText;
      }
    }
    return null;
  }

  function isCommandAllowed(cmdText) {
    if (!HAS_FILTERS) return true;
    if (!cmdText) return false;
    var cmdLower = cmdText.toLowerCase();
    for (var b = 0; b < BLOCKED_COMMANDS.length; b++) {
      if (cmdLower.indexOf(BLOCKED_COMMANDS[b].toLowerCase()) !== -1) return false;
    }
    if (ALLOWED_COMMANDS.length > 0) {
      var allowed = false;
      for (var a = 0; a < ALLOWED_COMMANDS.length; a++) {
        if (cmdLower.indexOf(ALLOWED_COMMANDS[a].toLowerCase()) !== -1) { allowed = true; break; }
      }
      if (!allowed) return false;
    }
    return true;
  }

  function pruneCooldowns() {
    var now = Date.now();
    for (var k in clickCooldowns) {
      if (now - clickCooldowns[k] > COOLDOWN_MS * 5) delete clickCooldowns[k];
    }
  }

  function scanAndClick() {
    window.__AA_LAST_SCAN = Date.now();
    if (window.__AA_PAUSED) return null;
    pruneCooldowns();

    var allTexts = BUTTON_TEXTS.concat(EXPAND_TEXTS);
    var MAX_SCANS = 5;

    for (var scan = 0; scan < MAX_SCANS; scan++) {
      var match = findButton(document.body, allTexts);
      if (!match) return null;

      var btn = match.node;
      var matchedText = match.matchedText;

      // Retry circuit breaker
      if (matchedText === 'retry' || matchedText === 'continue') {
        window.__AA_RECOVERY_TS = window.__AA_RECOVERY_TS || [];
        var now = Date.now();
        window.__AA_RECOVERY_TS = window.__AA_RECOVERY_TS.filter(function(ts) { return now - ts < 60000; });
        if (window.__AA_RECOVERY_TS.length >= 3) return 'blocked:circuit_breaker';
        window.__AA_RECOVERY_TS.push(now);
      } else {
        window.__AA_RECOVERY_TS = [];
      }

      // Command filtering (skip for expand buttons)
      var isExpandBtn = (matchedText === 'expand' || matchedText === 'requires input');
      if (HAS_FILTERS && !isExpandBtn) {
        var cmdText = extractCommandText(btn);
        if (cmdText && !isCommandAllowed(cmdText)) {
          btn.setAttribute('data-aa-blocked', 'true');
          if (!window.__AA_DIAG) window.__AA_DIAG = [];
          if (window.__AA_DIAG.length < 50) {
            window.__AA_DIAG.push({ action: 'BLOCKED', time: Date.now(), matched: matchedText, cmd: cmdText.substring(0, 60) });
          }
          var blockKey = matchedText + ':blocked:' + (btn.textContent || '').trim().substring(0, 20);
          clickCooldowns[blockKey] = Date.now() + 15000;
          continue;
        }
      }

      // Record cooldown and click
      var key = matchedText + ':' + (btn.textContent || '').trim().toLowerCase().substring(0, 30);
      clickCooldowns[key] = Date.now();

      btn.click();
      window.__AA_CLICK_COUNT = (window.__AA_CLICK_COUNT || 0) + 1;
      if (!window.__AA_DIAG) window.__AA_DIAG = [];
      if (window.__AA_DIAG.length < 50) {
        window.__AA_DIAG.push({ action: 'CLICKED', time: Date.now(), matched: matchedText });
      }
      return 'clicked:' + matchedText;
    }
    return null;
  }

  // Initial scan
  try { scanAndClick(); } catch(e) {}

  // MutationObserver: event-driven, zero-polling
  var scanQueued = false;
  var observer = new MutationObserver(function() {
    if (scanQueued || window.__AA_PAUSED) return;
    scanQueued = true;
    setTimeout(function() {
      try { scanAndClick(); } catch(e) {}
      finally { scanQueued = false; }
    }, 50);
  });

  observer.observe(document.documentElement, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-expanded', 'data-state']
  });

  // Fallback scan every 10s
  if (window.__AA_FALLBACK_INTERVAL) clearInterval(window.__AA_FALLBACK_INTERVAL);
  window.__AA_FALLBACK_INTERVAL = setInterval(function() {
    if (window.__AA_PAUSED) return;
    window.__AA_LAST_SCAN = Date.now();
    try { scanAndClick(); } catch(e) {}
  }, 10000);

  window.__AA_OBSERVER = observer;
  return 'observer-installed';
})()`;
  }

  /**
   * Heartbeat: check if injected observer is still alive.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      if (!this._enabled) return;
      try {
        const lastScan = await this.cdp.evaluate('window.__AA_LAST_SCAN || 0') as number;
        const staleMs = Date.now() - lastScan;
        if (staleMs > 30000) {
          this.log.warn('Auto Accept watchdog: observer stale, re-injecting...');
          const script = this.buildDOMObserverScript();
          await this.cdp.evaluateOnAllTargets(script);
        }
      } catch {
        // ignore
      }
    }, 15000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
