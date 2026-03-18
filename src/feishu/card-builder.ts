/**
 * Feishu Message Card Builder
 *
 * Converts Agent replies (markdown-like content) into
 * Feishu Interactive Message Cards for rich display.
 *
 * Card JSON Structure:
 * {
 *   "header": { "title": { "tag": "plain_text", "content": "..." }, "template": "blue" },
 *   "elements": [
 *     { "tag": "markdown", "content": "..." },
 *     { "tag": "hr" },
 *     ...
 *   ]
 * }
 */

export interface CardHeader {
  title: string;
  template?: 'blue' | 'green' | 'red' | 'orange' | 'purple' | 'indigo' | 'turquoise' | 'wathet' | 'grey';
}

/**
 * Build a Feishu interactive card JSON string from Agent reply content.
 */
export function buildAgentReplyCard(content: string, header?: CardHeader): string {
  const cardHeader = header || { title: '🤖 Agent Reply', template: 'blue' as const };

  // Split content into segments for better rendering
  const segments = splitContentSegments(content);
  const elements: any[] = [];

  for (const segment of segments) {
    if (segment.type === 'code') {
      // Code block: use markdown component with fenced code block
      elements.push({
        tag: 'markdown',
        content: `\`\`\`${segment.lang || ''}\n${segment.text}\n\`\`\``,
      });
    } else if (segment.type === 'divider') {
      elements.push({ tag: 'hr' });
    } else {
      // Normal text: use markdown component
      elements.push({
        tag: 'markdown',
        content: segment.text,
      });
    }
  }

  // Add footer with timestamp
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `⏱ ${new Date().toLocaleTimeString('zh-CN')} · Anti-Feishu`,
      },
    ],
  });

  const card = {
    header: {
      title: {
        tag: 'plain_text',
        content: cardHeader.title,
      },
      template: cardHeader.template || 'blue',
    },
    elements,
  };

  return JSON.stringify(card);
}

/**
 * Build a status card showing IDE connection info.
 */
export function buildStatusCard(
  cdpConnected: boolean,
  autoAcceptEnabled: boolean,
  windowTitle?: string,
): string {
  const elements: any[] = [];

  elements.push({
    tag: 'markdown',
    content: [
      `**📡 IDE 连接**: ${cdpConnected ? '🟢 已连接' : '🔴 未连接'}`,
      `**⚡ Auto Accept**: ${autoAcceptEnabled ? '✅ 已开启' : '⏸ 已关闭'}`,
      windowTitle ? `**📝 窗口**: ${windowTitle}` : '',
    ].filter(Boolean).join('\n'),
  });

  const card = {
    header: {
      title: { tag: 'plain_text', content: '📊 Anti-Feishu Status' },
      template: cdpConnected ? 'green' as const : 'red' as const,
    },
    elements,
  };

  return JSON.stringify(card);
}

/**
 * Build a help card listing all commands.
 */
export function buildHelpCard(commands: string[]): string {
  const elements: any[] = [];

  elements.push({
    tag: 'markdown',
    content: commands
      .map(cmd => `\`${cmd.split(' - ')[0]}\` - ${cmd.split(' - ')[1] || ''}`)
      .join('\n'),
  });

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: '💡 也可以直接输入文本（不带 `/`），自动发送给 Agent。',
  });

  const card = {
    header: {
      title: { tag: 'plain_text', content: '📖 Anti-Feishu 指令列表' },
      template: 'indigo' as const,
    },
    elements,
  };

  return JSON.stringify(card);
}

/**
 * Build a card for Auto Accept statistics.
 */
export function buildAutoAcceptCard(
  enabled: boolean,
  clickCount: number,
  recentLogs: Array<{ action: string; time: number; matched?: string; cmd?: string; count?: number }>,
): string {
  const elements: any[] = [];

  elements.push({
    tag: 'markdown',
    content: [
      `**状态**: ${enabled ? '⚡ 已开启' : '⏸ 已关闭'}`,
      `**总点击次数**: ${clickCount}`,
    ].join('\n'),
  });

  if (recentLogs.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: '**📋 最近活动**',
    });

    const logLines = recentLogs.map(d => {
      const time = new Date(d.time).toLocaleTimeString('zh-CN');
      if (d.action === 'CLICKED') {
        return `✅ \`${time}\` clicked: **${d.matched}**`;
      } else if (d.action === 'BLOCKED') {
        return `🚫 \`${time}\` blocked: \`${d.cmd}\``;
      } else if (d.action === 'CIRCUIT_BREAKER') {
        return `⚠️ \`${time}\` 熔断 (retries: ${d.count})`;
      }
      return `ℹ️ \`${time}\` ${d.action}`;
    });

    elements.push({
      tag: 'markdown',
      content: logLines.join('\n'),
    });
  }

  const card = {
    header: {
      title: { tag: 'plain_text', content: '⚡ Auto Accept' },
      template: enabled ? 'green' as const : 'grey' as const,
    },
    elements,
  };

  return JSON.stringify(card);
}

/**
 * Build a notification card for blocked commands.
 */
export function buildBlockedCommandCard(command: string, matchedText: string): string {
  const card = {
    header: {
      title: { tag: 'plain_text', content: '🚫 命令被拦截' },
      template: 'red' as const,
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**按钮**: ${matchedText}`,
          `**命令**: \`${command}\``,
          '',
          '该命令在黑名单中，已自动拦截。',
        ].join('\n'),
      },
    ],
  };

  return JSON.stringify(card);
}

// ──────────────── Internal helpers ────────────────

interface ContentSegment {
  type: 'text' | 'code' | 'divider';
  text: string;
  lang?: string;
}

/**
 * Parse markdown-like content into segments for card rendering.
 * Splits on code blocks (```) and horizontal rules (---).
 */
function splitContentSegments(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const lines = content.split('\n');

  let currentText: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];

  for (const line of lines) {
    if (!inCodeBlock && line.startsWith('```')) {
      // Entering code block
      if (currentText.length > 0) {
        segments.push({ type: 'text', text: currentText.join('\n') });
        currentText = [];
      }
      inCodeBlock = true;
      codeLang = line.slice(3).trim();
      codeLines = [];
    } else if (inCodeBlock && line.startsWith('```')) {
      // Exiting code block
      segments.push({
        type: 'code',
        text: codeLines.join('\n'),
        lang: codeLang,
      });
      inCodeBlock = false;
      codeLang = '';
      codeLines = [];
    } else if (inCodeBlock) {
      codeLines.push(line);
    } else if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim())) {
      // Horizontal rule
      if (currentText.length > 0) {
        segments.push({ type: 'text', text: currentText.join('\n') });
        currentText = [];
      }
      segments.push({ type: 'divider', text: '' });
    } else {
      currentText.push(line);
    }
  }

  // Remaining text
  if (inCodeBlock && codeLines.length > 0) {
    segments.push({ type: 'code', text: codeLines.join('\n'), lang: codeLang });
  }
  if (currentText.length > 0) {
    const text = currentText.join('\n').trim();
    if (text) {
      segments.push({ type: 'text', text });
    }
  }

  return segments;
}
