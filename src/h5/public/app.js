// Anti-Feishu H5 Dashboard — Frontend Logic
(function () {
  'use strict';

  // ===== DOM Elements =====
  const $ = (sel) => document.querySelector(sel);
  const canvas = $('#video-canvas');
  const ctx = canvas.getContext('2d');
  const videoContainer = $('#video-container');
  const videoPlaceholder = $('#video-placeholder');
  const liveBadge = $('#live-badge');
  const fpsCounter = $('#fps-counter');
  const agentOutput = $('#agent-output');
  const agentInput = $('#agent-input');
  const outputCount = $('#output-count');
  const connectionBadge = $('#connection-badge');
  const uptimeDisplay = $('#uptime-display');
  const qualitySelect = $('#quality-select');
  const toastContainer = $('#toast-container');

  // ===== State =====
  let ws = null;
  let connected = false;
  let paused = false;
  let isFullscreen = false;
  let messageCount = 0;
  let autoScroll = true;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let statusPollTimer = null;
  let pendingFrame = null;

  // ===== WebSocket =====
  function connectWs() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}`;

    setConnectionState('connecting');

    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('WebSocket creation failed:', err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      connected = true;
      reconnectAttempts = 0;
      setConnectionState('connected');
      showToast('Connected to server');
      startStatusPoll();
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        handleServerMessage(msg);
      } catch (e) {
        console.warn('Invalid message:', e);
      }
    };

    ws.onclose = () => {
      connected = false;
      setConnectionState('disconnected');
      stopStatusPoll();
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
    console.log(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWs();
    }, delay);
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ===== Message Handlers =====
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'frame':
        if (!paused) renderFrame(msg.data);
        break;
      case 'agent_output':
        addAgentOutput(msg.text, msg.timestamp);
        break;
      case 'status':
        updateStatus(msg.status);
        break;
      case 'event':
        addAgentOutput(msg.event, msg.timestamp, 'event');
        if (msg.data && msg.event && msg.event.includes('Screenshot')) {
          downloadScreenshot(msg.data);
        }
        break;
      case 'file_content':
        showFileContent(msg.filename, msg.text, msg.language, msg.timestamp);
        break;
      case 'sessions_list':
        renderSessionsList(msg.items || []);
        break;
      case 'files_list':
        renderFilesList(msg.items || []);
        break;
      case 'projects_list':
        renderProjectsList(msg.items || []);
        break;
      case 'welcome':
        if (msg.status) updateStatus(msg.status);
        // Auto-load sessions and files
        send({ type: 'sessions', text: 'list' });
        send({ type: 'files', text: 'list' });
        break;
    }
  }

  // ===== Video Rendering =====
  function renderFrame(base64Data) {
    const img = new Image();
    img.onload = () => {
      // Resize canvas to match image aspect ratio
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = img.width;
        canvas.height = img.height;
      }

      if (pendingFrame) cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        ctx.drawImage(img, 0, 0);
        pendingFrame = null;
      });

      // Show canvas, hide placeholder
      if (!canvas.classList.contains('visible')) {
        canvas.classList.add('visible');
        videoPlaceholder.classList.add('hidden');
        videoContainer.classList.add('has-video');
        liveBadge.classList.remove('hidden');
      }
    };
    img.src = 'data:image/jpeg;base64,' + base64Data;
  }

  // ===== Agent Output =====

  /**
   * Detect if message text looks like agent thinking/reasoning.
   * Thinking content is usually: English-only, no rich formatting,
   * and starts with reasoning patterns.
   */
  function isThinkingContent(html) {
    // Strip HTML tags to get plain text
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const plain = (tmp.textContent || '').trim();

    // Too short to be thinking
    if (plain.length < 10) return false;

    // If it contains complex HTML (lists, headers, code blocks), it's a real response
    if (/<(h[1-6]|ul|ol|li|pre|code|table|blockquote)\b/i.test(html)) return false;

    // Common thinking/reasoning patterns (English)
    const thinkingPatterns = [
      /^(I('ll| will| need| should| want| have| can| am| realize| think| believe|'ve|'m)\b)/i,
      /^(Let me\b)/i,
      /^(The user\b)/i,
      /^(Now I\b)/i,
      /^(Looking at\b)/i,
      /^(Based on\b)/i,
      /^(Since\b)/i,
      /^(First,?\b)/i,
      /^(This (is|means|looks|should|will|would|could)\b)/i,
      /^(OK|Okay|Alright),?\s/i,
      /^(Wait|Hmm|Actually),?\s/i,
    ];

    for (const pattern of thinkingPatterns) {
      if (pattern.test(plain)) return true;
    }

    return false;
  }

  function addAgentOutput(text, timestamp, type) {
    if (!text) return;

    messageCount++;
    outputCount.textContent = messageCount;

    const line = document.createElement('div');
    line.className = 'output-line';

    const time = document.createElement('span');
    time.className = 'output-time';
    time.textContent = formatTime(timestamp);

    const content = document.createElement('div');
    content.className = 'output-text';

    // Event messages (sent, screenshot etc) use plain text
    // Agent replies use HTML (rendered Markdown from IDE)
    if (type === 'event') {
      content.textContent = text;
      content.classList.add('text-blue');
    } else if (isThinkingContent(text)) {
      // Render thinking content as collapsible block
      const details = document.createElement('details');
      details.className = 'thinking-block';

      const summary = document.createElement('summary');
      summary.className = 'thinking-summary';
      summary.innerHTML = '💭 <span class="thinking-label">Thinking</span>';

      const body = document.createElement('div');
      body.className = 'thinking-body';
      body.innerHTML = text;

      details.appendChild(summary);
      details.appendChild(body);
      content.appendChild(details);
    } else {
      // Render as HTML (Markdown from Agent)
      content.classList.add('markdown-body');
      content.innerHTML = text;
    }

    line.appendChild(time);
    line.appendChild(content);
    agentOutput.appendChild(line);

    // Keep max 500 lines
    while (agentOutput.children.length > 500) {
      agentOutput.removeChild(agentOutput.firstChild);
    }

    // Auto scroll
    if (autoScroll) {
      agentOutput.scrollTop = agentOutput.scrollHeight;
    }
  }

  // Auto-scroll detection
  agentOutput.addEventListener('scroll', () => {
    const threshold = 50;
    const atBottom = agentOutput.scrollHeight - agentOutput.scrollTop - agentOutput.clientHeight < threshold;
    autoScroll = atBottom;
  });

  // ===== Status Updates =====
  function updateStatus(status) {
    if (!status) return;

    // FPS
    fpsCounter.textContent = `${status.fps || 0} FPS`;

    // CDP
    updateStatusCard('status-cdp', status.cdp, status.cdp ? 'Connected' : 'Disconnected', 'port 9222');

    // Feishu
    updateStatusCard('status-feishu', status.feishu, status.feishu ? 'Online' : 'Offline', '');

    // Auto Accept
    const aaCard = $('#status-autoaccept');
    if (aaCard) {
      aaCard.querySelector('.status-value').textContent = status.autoAccept ? 'ON' : 'OFF';
    }

    // Screencast
    updateStatusCard(
      'status-screencast',
      status.screencast,
      status.screencast ? 'Streaming' : 'Stopped',
      `${status.totalFrames || 0} frames`
    );

    // Uptime
    if (status.uptime !== undefined) {
      uptimeDisplay.textContent = `Uptime: ${formatUptime(status.uptime)}`;
    }
  }

  function updateStatusCard(id, isOn, value, detail) {
    const card = $(`#${id}`);
    if (!card) return;
    const dot = card.querySelector('.status-dot');
    if (dot) {
      dot.classList.toggle('on', isOn);
    }
    card.querySelector('.status-value').textContent = value;
    if (detail !== undefined) {
      card.querySelector('.status-detail').textContent = detail;
    }
  }

  function setConnectionState(state) {
    connectionBadge.className = 'badge';
    const badgeText = connectionBadge.querySelector('.badge-text');
    switch (state) {
      case 'connected':
        connectionBadge.classList.add('badge-connected');
        badgeText.textContent = 'Connected';
        break;
      case 'disconnected':
        connectionBadge.classList.add('badge-disconnected');
        badgeText.textContent = 'Disconnected';
        break;
      case 'connecting':
        connectionBadge.classList.add('badge-connecting');
        badgeText.textContent = 'Connecting';
        break;
    }
  }

  function startStatusPoll() {
    stopStatusPoll();
    statusPollTimer = setInterval(() => {
      send({ type: 'ping' });
    }, 3000);
  }

  function stopStatusPoll() {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }

  // ===== Actions =====
  function sendMessage() {
    const text = agentInput.value.trim();
    if (!text) return;
    send({ type: 'send', text });
    agentInput.value = '';
    addAgentOutput(`> ${text}`, Date.now(), 'event');
  }

  function takeScreenshot() {
    send({ type: 'screenshot' });
    showToast('Taking screenshot...');
  }

  function stopAgent() {
    send({ type: 'stop' });
    // Also send as action for belt-and-suspenders
    send({ type: 'action', text: 'stop' });
  }

  function togglePause() {
    paused = !paused;
    const btn = $('#btn-pause');
    btn.classList.toggle('active', paused);
    btn.title = paused ? 'Resume (Space)' : 'Pause (Space)';
    showToast(paused ? 'Paused' : 'Resumed');
  }

  function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    document.body.classList.toggle('fullscreen', isFullscreen);

    if (isFullscreen) {
      // Try native Fullscreen API (works on Android Chrome, desktop)
      const el = document.documentElement;
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {});
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }

      // Lock to landscape orientation
      lockLandscape();
      showExitFullscreenBtn();
      initPinchZoom();
    } else {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      }

      // Unlock orientation
      unlockOrientation();
      hideExitFullscreenBtn();
      resetPinchZoom();
    }
  }

  // Orientation lock helpers
  function lockLandscape() {
    // Android: use Screen Orientation API
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {
        // API not supported or not in fullscreen — use CSS fallback
        applyForceLandscape();
      });
    } else {
      // iOS Safari: CSS rotation fallback
      applyForceLandscape();
    }
  }

  function unlockOrientation() {
    if (screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch {}
    }
    document.body.classList.remove('force-landscape');
  }

  function isMobileDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  function applyForceLandscape() {
    // Only apply CSS rotation on mobile devices in portrait mode
    // Desktop browsers should never get the rotation fallback
    if (isMobileDevice() && window.innerHeight > window.innerWidth) {
      document.body.classList.add('force-landscape');
    }
  }

  // Listen for orientation changes to remove force-landscape when user rotates device
  window.addEventListener('orientationchange', () => {
    if (isFullscreen) {
      // Device rotated to landscape — remove CSS force
      setTimeout(() => {
        if (window.innerWidth > window.innerHeight) {
          document.body.classList.remove('force-landscape');
        }
      }, 200);
    }
  });

  // Exit fullscreen floating button (for mobile)
  let exitFsBtn = null;
  function showExitFullscreenBtn() {
    if (exitFsBtn) return;
    exitFsBtn = document.createElement('button');
    exitFsBtn.className = 'exit-fullscreen-btn';
    exitFsBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>
    </svg>`;
    exitFsBtn.title = 'Exit Fullscreen';
    exitFsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen();
    });
    document.body.appendChild(exitFsBtn);
    // Auto-hide after 3s, show on tap
    startExitBtnAutoHide();
  }

  function hideExitFullscreenBtn() {
    if (exitFsBtn) {
      exitFsBtn.remove();
      exitFsBtn = null;
    }
  }

  let exitBtnHideTimer = null;
  function startExitBtnAutoHide() {
    if (exitBtnHideTimer) clearTimeout(exitBtnHideTimer);
    if (exitFsBtn) exitFsBtn.classList.remove('faded');
    exitBtnHideTimer = setTimeout(() => {
      if (exitFsBtn) exitFsBtn.classList.add('faded');
    }, 3000);
  }

  // Show exit button again when tapping in fullscreen
  document.addEventListener('touchstart', () => {
    if (isFullscreen && exitFsBtn) startExitBtnAutoHide();
  }, { passive: true });
  document.addEventListener('mousemove', () => {
    if (isFullscreen && exitFsBtn) startExitBtnAutoHide();
  });

  function changeQuality(quality) {
    send({ type: 'config', config: { quality: parseInt(quality) } });
    showToast(`Quality: ${quality}%`);
  }

  function downloadScreenshot(base64Data) {
    const link = document.createElement('a');
    link.download = `anti-feishu-screenshot-${Date.now()}.png`;
    link.href = 'data:image/png;base64,' + base64Data;
    link.click();
    showToast('Screenshot saved');
  }

  // ===== Voice Input (Speech-to-Text) =====
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voiceBtn = $('#btn-voice');
  let recognition = null;
  let isRecording = false;

  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isRecording = true;
      voiceBtn.classList.add('recording');
      agentInput.placeholder = '🎙 Listening...';
      showToast('🎙 Start speaking...');
    };

    recognition.onresult = (event) => {
      let interimText = '';
      let finalText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }

      // Show interim results in input field
      if (finalText) {
        agentInput.value = finalText;
      } else if (interimText) {
        agentInput.value = interimText;
      }
    };

    recognition.onend = () => {
      isRecording = false;
      voiceBtn.classList.remove('recording');
      agentInput.placeholder = 'Send to Agent...';

      // Auto-send if there's text
      const text = agentInput.value.trim();
      if (text) {
        showToast(`📤 Sending: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`);
        sendMessage();
      }
    };

    recognition.onerror = (event) => {
      isRecording = false;
      voiceBtn.classList.remove('recording');
      agentInput.placeholder = 'Send to Agent...';

      if (event.error === 'no-speech') {
        showToast('No speech detected. Try again.');
      } else if (event.error === 'not-allowed') {
        showToast('Microphone permission denied.');
      } else {
        showToast(`Voice error: ${event.error}`);
      }
    };
  } else {
    // Browser doesn't support Speech Recognition
    voiceBtn.classList.add('unsupported');
    voiceBtn.title = 'Voice input not supported in this browser';
  }

  function toggleVoice() {
    if (!recognition) {
      showToast('Voice input not supported. Use Chrome or Safari via HTTPS.');
      return;
    }

    if (isRecording) {
      recognition.stop();
    } else {
      agentInput.value = '';
      try {
        recognition.start();
      } catch (err) {
        // Common on HTTP (non-secure context)
        if (location.protocol === 'http:' && location.hostname !== 'localhost') {
          const httpsUrl = `https://${location.hostname}:${parseInt(location.port) + 1}`;
          showToast(`🔒 Voice requires HTTPS. Open: ${httpsUrl}`, 5000);
        } else {
          showToast(`Voice error: ${err.message}`);
        }
      }
    }
  }

  // ===== Image Upload =====
  const imageInput = $('#image-input');
  const imageBtn = $('#btn-image');
  let pendingImage = null; // { base64, name, size }

  imageBtn.addEventListener('click', () => {
    imageInput.click();
  });

  imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Compress and convert to base64
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        // Resize if too large (max 1200px)
        const maxSize = 1200;
        let w = img.width, h = img.height;
        if (w > maxSize || h > maxSize) {
          const ratio = Math.min(maxSize / w, maxSize / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }

        const cvs = document.createElement('canvas');
        cvs.width = w;
        cvs.height = h;
        cvs.getContext('2d').drawImage(img, 0, 0, w, h);
        const base64 = cvs.toDataURL('image/jpeg', 0.85).split(',')[1];

        pendingImage = {
          base64,
          name: file.name,
          size: Math.round(base64.length * 0.75 / 1024), // approx KB
        };

        showImagePreview(pendingImage);
        showToast(`📷 Image ready (${pendingImage.size}KB)`);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);

    // Reset input so same file can be re-selected
    imageInput.value = '';
  });

  function showImagePreview(imgData) {
    removeImagePreview();

    const bar = document.createElement('div');
    bar.className = 'image-preview-bar';
    bar.id = 'image-preview';

    const thumb = document.createElement('img');
    thumb.src = 'data:image/jpeg;base64,' + imgData.base64;

    const info = document.createElement('span');
    info.className = 'preview-info';
    info.textContent = `${imgData.name} (${imgData.size}KB)`;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'preview-remove';
    removeBtn.innerHTML = '✕';
    removeBtn.addEventListener('click', () => {
      pendingImage = null;
      removeImagePreview();
    });

    bar.appendChild(thumb);
    bar.appendChild(info);
    bar.appendChild(removeBtn);

    // Insert before input row
    const inputRow = $('#agent-input-row');
    inputRow.parentNode.insertBefore(bar, inputRow);
  }

  function removeImagePreview() {
    const existing = $('#image-preview');
    if (existing) existing.remove();
  }

  // Override sendMessage to include image
  const origSendMessage = sendMessage;
  sendMessage = function() {
    const text = agentInput.value.trim();

    if (pendingImage) {
      send({
        type: 'image',
        data: pendingImage.base64,
        name: pendingImage.name,
        text: text || '',
      });
      addAgentOutput(`📷 Image sent${text ? ': ' + text : ''}`, Date.now(), 'event');
      pendingImage = null;
      removeImagePreview();
      agentInput.value = '';
    } else if (text.startsWith('/file ')) {
      // Request file from server
      const filePath = text.slice(6).trim();
      if (filePath) {
        send({ type: 'file', text: filePath });
        addAgentOutput(`📄 Requesting: ${filePath}`, Date.now(), 'event');
      }
      agentInput.value = '';
    } else if (text) {
      send({ type: 'send', text });
      agentInput.value = '';
      addAgentOutput(`> ${text}`, Date.now(), 'event');
    }
  };

  // Show file content in agent output
  function showFileContent(filename, content, language, timestamp) {
    const lineCount = content.split('\n').length;
    const sizeKB = Math.round(new Blob([content]).size / 1024);

    // Create file viewer element
    const wrapper = document.createElement('div');
    wrapper.className = 'file-viewer';

    const header = document.createElement('div');
    header.className = 'file-viewer-header';
    header.innerHTML = `
      <span class="file-viewer-name">📄 ${filename}</span>
      <span class="file-viewer-meta">${lineCount} lines · ${sizeKB}KB · ${language}</span>
      <button class="file-viewer-copy" title="Copy">📋</button>
    `;

    const codeBlock = document.createElement('pre');
    codeBlock.className = 'file-viewer-code';
    const code = document.createElement('code');
    code.textContent = content;
    codeBlock.appendChild(code);

    wrapper.appendChild(header);
    wrapper.appendChild(codeBlock);

    // Copy button
    header.querySelector('.file-viewer-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(content).then(() => {
        showToast('📋 Copied to clipboard');
      });
    });

    // Append to agent output
    const timeStr = formatTime(timestamp);
    const entry = document.createElement('div');
    entry.className = 'agent-msg';
    if (timeStr) {
      const ts = document.createElement('span');
      ts.className = 'agent-ts';
      ts.textContent = timeStr;
      entry.appendChild(ts);
    }
    entry.appendChild(wrapper);
    agentOutput.appendChild(entry);
    agentOutput.scrollTop = agentOutput.scrollHeight;
    updateMessageBadge();
  }

  // ===== Management Panel =====
  const mgmtTabs = document.querySelectorAll('.mgmt-tab');
  const mgmtContents = document.querySelectorAll('.mgmt-content');

  mgmtTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      mgmtTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      mgmtContents.forEach(c => {
        c.style.display = c.id === 'mgmt-' + target ? 'block' : 'none';
      });
      // Refresh data when switching tabs
      if (target === 'sessions') send({ type: 'sessions', text: 'list' });
      if (target === 'workspace') send({ type: 'files', text: 'list' });
      if (target === 'projects') send({ type: 'projects', text: 'list' });
    });
  });

  function renderSessionsList(items) {
    const container = $('#sessions-list');
    if (items.length === 0) {
      container.innerHTML = '<div class="mgmt-empty">No sessions found</div>';
      return;
    }
    container.innerHTML = '';
    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'mgmt-item' + (item.active ? ' active' : '');
      el.innerHTML = `
        <span class="mgmt-item-icon">💬</span>
        <span class="mgmt-item-title">${escapeHtml(item.title)}</span>
        <div class="mgmt-item-actions">
          <button class="mgmt-item-btn" title="Switch" data-action="switch" data-idx="${item.index}">▶</button>
          <button class="mgmt-item-btn danger" title="Close" data-action="close" data-idx="${item.index}">✕</button>
        </div>
      `;
      el.querySelector('[data-action="switch"]').addEventListener('click', (e) => {
        e.stopPropagation();
        send({ type: 'sessions', text: 'switch:' + item.index });
      });
      el.querySelector('[data-action="close"]').addEventListener('click', (e) => {
        e.stopPropagation();
        send({ type: 'sessions', text: 'close:' + item.index });
      });
      el.addEventListener('click', () => {
        send({ type: 'sessions', text: 'switch:' + item.index });
      });
      container.appendChild(el);
    });
  }

  function renderFilesList(items) {
    const container = $('#files-list');
    if (items.length === 0) {
      container.innerHTML = '<div class="mgmt-empty">No files open</div>';
      return;
    }
    container.innerHTML = '';
    items.forEach(item => {
      const ext = item.title.split('.').pop() || '';
      const iconMap = {
        ts: '🔷', js: '🟡', css: '🎨', html: '🌐', json: '📋',
        md: '📝', py: '🐍', rs: '🦀', go: '🔵', toml: '⚙️',
      };
      const icon = iconMap[ext] || '📄';
      const el = document.createElement('div');
      el.className = 'mgmt-item' + (item.active ? ' active' : '');
      el.innerHTML = `
        <span class="mgmt-item-icon">${icon}</span>
        <span class="mgmt-item-title">${escapeHtml(item.title)}</span>
        <div class="mgmt-item-actions">
          <button class="mgmt-item-btn" title="Switch" data-action="switch" data-idx="${item.index}">▶</button>
          <button class="mgmt-item-btn danger" title="Close" data-action="close" data-idx="${item.index}">✕</button>
        </div>
      `;
      el.querySelector('[data-action="switch"]').addEventListener('click', (e) => {
        e.stopPropagation();
        send({ type: 'files', text: 'switch:' + item.index });
      });
      el.querySelector('[data-action="close"]').addEventListener('click', (e) => {
        e.stopPropagation();
        send({ type: 'files', text: 'close:' + item.index });
      });
      el.addEventListener('click', () => {
        send({ type: 'files', text: 'switch:' + item.index });
      });
      container.appendChild(el);
    });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderProjectsList(items) {
    const container = $('#projects-list');
    if (items.length === 0) {
      container.innerHTML = '<div class="mgmt-empty">No workspaces found</div>';
      return;
    }
    container.innerHTML = '';
    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'mgmt-item' + (item.active ? ' active' : '');
      const icon = item.active ? '🟢' : '🔵';
      el.innerHTML = `
        <span class="mgmt-item-icon">${icon}</span>
        <span class="mgmt-item-title">${escapeHtml(item.title)}</span>
        <div class="mgmt-item-actions">
          <button class="mgmt-item-btn" title="Switch" data-action="switch" data-idx="${item.index}">▶</button>
        </div>
      `;
      el.querySelector('[data-action="switch"]').addEventListener('click', (e) => {
        e.stopPropagation();
        send({ type: 'projects', text: 'switch:' + item.index });
        showToast('🔄 Switching to: ' + item.title);
      });
      el.addEventListener('click', () => {
        if (!item.active) {
          send({ type: 'projects', text: 'switch:' + item.index });
          showToast('🔄 Switching to: ' + item.title);
        }
      });
      container.appendChild(el);
    });
  }

  // Management buttons
  $('#btn-new-session').addEventListener('click', () => {
    send({ type: 'sessions', text: 'new' });
  });
  $('#btn-refresh-sessions').addEventListener('click', () => {
    send({ type: 'sessions', text: 'list' });
  });
  $('#btn-refresh-files').addEventListener('click', () => {
    send({ type: 'files', text: 'list' });
  });
  $('#btn-refresh-projects').addEventListener('click', () => {
    send({ type: 'projects', text: 'list' });
  });

  // ===== Event Bindings =====
  // Send button
  $('#btn-send').addEventListener('click', sendMessage);
  agentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Toolbar buttons
  $('#btn-pause').addEventListener('click', togglePause);
  $('#btn-screenshot').addEventListener('click', takeScreenshot);
  $('#btn-stop-agent').addEventListener('click', stopAgent);
  $('#btn-stop-gen').addEventListener('click', stopAgent);
  $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('#fab-screenshot').addEventListener('click', takeScreenshot);
  $('#btn-voice').addEventListener('click', toggleVoice);

  // Quick Actions buttons
  document.querySelectorAll('#quick-actions .action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (!action) return;
      send({ type: 'action', text: action });
      showToast(`⚡ ${btn.title || action}`);
    });
  });

  // ===== Pinch-to-Zoom (Fullscreen) =====
  let pinchScale = 1;
  let pinchTranslateX = 0;
  let pinchTranslateY = 0;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchStartMidX = 0;
  let pinchStartMidY = 0;
  let pinchStartTransX = 0;
  let pinchStartTransY = 0;
  let isPinching = false;
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartTransX = 0;
  let panStartTransY = 0;

  function getTouchDist(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function applyPinchTransform() {
    const s = Math.max(1, Math.min(5, pinchScale));
    pinchScale = s;
    const rect = canvas.getBoundingClientRect();
    const maxTx = rect.width * (s - 1) / 2;
    const maxTy = rect.height * (s - 1) / 2;
    pinchTranslateX = Math.max(-maxTx, Math.min(maxTx, pinchTranslateX));
    pinchTranslateY = Math.max(-maxTy, Math.min(maxTy, pinchTranslateY));
    canvas.style.transform = `translate(${pinchTranslateX}px, ${pinchTranslateY}px) scale(${s})`;
    canvas.style.transformOrigin = 'center center';
  }

  function initPinchZoom() {
    pinchScale = 1;
    pinchTranslateX = 0;
    pinchTranslateY = 0;
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';

    videoContainer.addEventListener('touchstart', onPinchTouchStart, { passive: false });
    videoContainer.addEventListener('touchmove', onPinchTouchMove, { passive: false });
    videoContainer.addEventListener('touchend', onPinchTouchEnd, { passive: false });
  }

  function resetPinchZoom() {
    pinchScale = 1;
    pinchTranslateX = 0;
    pinchTranslateY = 0;
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';

    videoContainer.removeEventListener('touchstart', onPinchTouchStart);
    videoContainer.removeEventListener('touchmove', onPinchTouchMove);
    videoContainer.removeEventListener('touchend', onPinchTouchEnd);
  }

  function onPinchTouchStart(e) {
    if (!isFullscreen) return;
    if (e.touches.length === 2) {
      isPinching = true;
      isPanning = false;
      pinchStartDist = getTouchDist(e.touches[0], e.touches[1]);
      pinchStartScale = pinchScale;
      pinchStartMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      pinchStartMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      pinchStartTransX = pinchTranslateX;
      pinchStartTransY = pinchTranslateY;
      e.preventDefault();
    } else if (e.touches.length === 1 && pinchScale > 1.05) {
      isPanning = true;
      isPinching = false;
      panStartX = e.touches[0].clientX;
      panStartY = e.touches[0].clientY;
      panStartTransX = pinchTranslateX;
      panStartTransY = pinchTranslateY;
    }
  }

  function onPinchTouchMove(e) {
    if (!isFullscreen) return;
    if (isPinching && e.touches.length === 2) {
      e.preventDefault();
      const dist = getTouchDist(e.touches[0], e.touches[1]);
      pinchScale = pinchStartScale * (dist / pinchStartDist);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      pinchTranslateX = pinchStartTransX + (midX - pinchStartMidX);
      pinchTranslateY = pinchStartTransY + (midY - pinchStartMidY);
      applyPinchTransform();
    } else if (isPanning && e.touches.length === 1 && pinchScale > 1.05) {
      e.preventDefault();
      pinchTranslateX = panStartTransX + (e.touches[0].clientX - panStartX);
      pinchTranslateY = panStartTransY + (e.touches[0].clientY - panStartY);
      applyPinchTransform();
    }
  }

  function onPinchTouchEnd(e) {
    if (!isFullscreen) return;
    if (e.touches.length < 2) isPinching = false;
    if (e.touches.length === 0) {
      isPanning = false;
      if (pinchScale < 1.1) {
        pinchScale = 1;
        pinchTranslateX = 0;
        pinchTranslateY = 0;
        canvas.style.transition = 'transform 0.2s ease-out';
        applyPinchTransform();
        setTimeout(() => { canvas.style.transition = ''; }, 220);
      }
    }
  }

  // ===== Remote Control =====
  let remoteMode = false;
  let isDragging = false;
  let suppressClick = false;
  let dragStartX = 0;
  let dragStartY = 0;
  const remoteBtn = $('#btn-remote');

  remoteBtn.addEventListener('click', () => {
    remoteMode = !remoteMode;
    remoteBtn.classList.toggle('active', remoteMode);
    canvas.style.cursor = remoteMode ? 'crosshair' : 'default';
    videoContainer.classList.toggle('remote-active', remoteMode);
    showToast(remoteMode ? '🖱️ Remote control ON (magnifier enabled)' : '🖱️ Remote control OFF');
  });

  // Throttle for move events
  let lastMoveTime = 0;
  const moveThrottleMs = 50;

  // Get normalized coordinates from canvas event
  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
      clientX = e.changedTouches[0].clientX;
      clientY = e.changedTouches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  }

  // ===== Magnifier =====
  const MAGNIFIER_SIZE = 130;     // CSS px
  const MAGNIFIER_ZOOM = 2.5;     // Zoom factor
  const MAGNIFIER_OFFSET_Y = -80; // Above finger
  const DRAG_HOLD_MS = 800;       // Hold duration to start drag

  let magnifierEl = null;
  let magnifierCanvas = null;
  let magnifierCtx = null;
  let magnifierLine = null;
  let holdTimer = null;
  let isMagnifierDrag = false; // true if long-press triggered drag mode
  let touchActive = false;

  function createMagnifier() {
    if (magnifierEl) return;
    console.log('[magnifier] createMagnifier called');

    magnifierEl = document.createElement('div');
    magnifierEl.className = 'magnifier';

    // Internal canvas for magnified content
    const mCvs = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    mCvs.width = MAGNIFIER_SIZE * dpr;
    mCvs.height = MAGNIFIER_SIZE * dpr;
    magnifierCanvas = mCvs;
    magnifierCtx = mCvs.getContext('2d');

    // Crosshair overlay
    const crosshair = document.createElement('div');
    crosshair.className = 'magnifier-crosshair';

    // Center dot
    const dot = document.createElement('div');
    dot.className = 'magnifier-dot';

    magnifierEl.appendChild(mCvs);
    magnifierEl.appendChild(crosshair);
    magnifierEl.appendChild(dot);
    document.body.appendChild(magnifierEl);

    // Connecting line (SVG)
    magnifierLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    magnifierLine.classList.add('magnifier-line');
    magnifierLine.style.position = 'fixed';
    magnifierLine.style.inset = '0';
    magnifierLine.style.width = '100%';
    magnifierLine.style.height = '100%';
    magnifierLine.style.pointerEvents = 'none';
    magnifierLine.style.zIndex = '10000';
    magnifierLine.innerHTML = '<line x1="0" y1="0" x2="0" y2="0" />';
    document.body.appendChild(magnifierLine);

    // Animate in
    requestAnimationFrame(() => {
      magnifierEl.classList.add('visible');
    });
  }

  function destroyMagnifier() {
    if (magnifierEl) {
      magnifierEl.classList.remove('visible');
      const el = magnifierEl;
      const line = magnifierLine;
      setTimeout(() => {
        el.remove();
        if (line) line.remove();
      }, 150);
      magnifierEl = null;
      magnifierCanvas = null;
      magnifierCtx = null;
      magnifierLine = null;
    }
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    isMagnifierDrag = false;
    touchActive = false;
  }

  function updateMagnifier(clientX, clientY) {
    if (!magnifierEl || !magnifierCtx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const mSize = MAGNIFIER_SIZE * dpr;

    // Position: show magnifier offset to the opposite side of the finger
    // Not too far (edge), not too close (under hand)
    const OFFSET_X = 80; // horizontal offset from finger
    const touchInLeftHalf = clientX < window.innerWidth / 2;

    let magX;
    let magY = clientY - MAGNIFIER_SIZE / 2;

    if (touchInLeftHalf) {
      // Finger on left → magnifier to the right of finger
      magX = clientX + OFFSET_X - MAGNIFIER_SIZE / 2;
    } else {
      // Finger on right → magnifier to the left of finger
      magX = clientX - OFFSET_X - MAGNIFIER_SIZE / 2;
    }

    // Clamp to viewport
    magX = Math.max(4, Math.min(window.innerWidth - MAGNIFIER_SIZE - 4, magX));
    magY = Math.max(4, Math.min(window.innerHeight - MAGNIFIER_SIZE - 4, magY));

    console.log(`[magnifier] pos: (${Math.round(magX)}, ${Math.round(magY)}), touch: (${Math.round(clientX)}, ${Math.round(clientY)}), viewW: ${window.innerWidth}`);
    magnifierEl.style.left = magX + 'px';
    magnifierEl.style.top = magY + 'px';

    // Update connecting line
    if (magnifierLine) {
      const lineEl = magnifierLine.querySelector('line');
      if (lineEl) {
        lineEl.setAttribute('x1', String(clientX));
        lineEl.setAttribute('y1', String(clientY));
        lineEl.setAttribute('x2', String(magX + MAGNIFIER_SIZE / 2));
        lineEl.setAttribute('y2', String(magY + MAGNIFIER_SIZE / 2));
      }
    }

    // Calculate source region on the canvas buffer
    // Touch position relative to canvas element
    const relX = (clientX - rect.left) / rect.width;
    const relY = (clientY - rect.top) / rect.height;

    // Source position in canvas buffer pixels
    const srcCenterX = relX * canvas.width;
    const srcCenterY = relY * canvas.height;

    // Source region size (how much of the original to show)
    const srcSize = mSize / MAGNIFIER_ZOOM;
    const srcX = srcCenterX - srcSize / 2;
    const srcY = srcCenterY - srcSize / 2;

    // Draw magnified portion
    magnifierCtx.clearRect(0, 0, mSize, mSize);
    magnifierCtx.imageSmoothingEnabled = false;
    try {
      magnifierCtx.drawImage(
        canvas,
        srcX, srcY, srcSize, srcSize,  // source rect
        0, 0, mSize, mSize             // dest rect (full magnifier canvas)
      );
    } catch {
      // Canvas might not be ready
    }
  }

  // ===== Touch events with magnifier =====
  let jitterX = 0;
  let jitterY = 0;

  function startHoldTimer(coords, touchX, touchY) {
    if (holdTimer) clearTimeout(holdTimer);
    jitterX = touchX;
    jitterY = touchY;

    holdTimer = setTimeout(() => {
      if (touchActive && !isMagnifierDrag) {
        isMagnifierDrag = true;
        // Send mousedown at current position
        send({ type: 'mouse', action: 'down', x: coords.x, y: coords.y });
        isDragging = true;
        // Haptic feedback if available
        if (navigator.vibrate) navigator.vibrate(30);
        showToast('🔗 Drag mode', 1000);
      }
    }, DRAG_HOLD_MS);
  }

  canvas.addEventListener('touchstart', (e) => {
    if (!remoteMode) return;
    e.preventDefault();

    const touch = e.touches[0];
    const coords = getCanvasCoords(e);
    touchActive = true;
    isDragging = false;
    isMagnifierDrag = false;
    dragStartX = coords.x;
    dragStartY = coords.y;

    // Show magnifier
    createMagnifier();
    updateMagnifier(touch.clientX, touch.clientY);

    // Initial hover
    send({ type: 'mouse', action: 'move', x: coords.x, y: coords.y });

    // Start hold timer for drag mode
    startHoldTimer(coords, touch.clientX, touch.clientY);
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (!remoteMode || !touchActive) return;
    e.preventDefault();

    const touch = e.touches[0];
    const coords = getCanvasCoords(e);

    // Update magnifier visual
    updateMagnifier(touch.clientX, touch.clientY);

    const now = Date.now();
    if (now - lastMoveTime > moveThrottleMs) {
      lastMoveTime = now;
      send({ type: 'mouse', action: 'move', x: coords.x, y: coords.y });
    }

    // Reset hold timer while sliding (if not already dragging)
    // Add jitter tolerance: only reset if moved > 5 pixels
    if (!isMagnifierDrag) {
      if (Math.abs(touch.clientX - jitterX) > 5 || Math.abs(touch.clientY - jitterY) > 5) {
        startHoldTimer(coords, touch.clientX, touch.clientY);
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    if (!remoteMode || !touchActive) return;
    e.preventDefault();

    const coords = getCanvasCoords(e);

    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }

    if (isMagnifierDrag) {
      // Completed a drag
      send({ type: 'mouse', action: 'up', x: coords.x, y: coords.y });
    } else {
      // Not dragging. Decide between click and hover release.
      const dx = Math.abs(coords.x - dragStartX);
      const dy = Math.abs(coords.y - dragStartY);
      if (dx < 0.01 && dy < 0.01) {
        // Quick tap without significant sliding
        send({ type: 'mouse', action: 'click', x: coords.x, y: coords.y });
        const touch = e.changedTouches[0];
        if (touch) showClickIndicator(touch.clientX, touch.clientY);
      }
      // If dx >= 0.01, it was a slide/hover action. Lifting finger does nothing (mouse stays where it is).
    }

    isDragging = false;
    destroyMagnifier();
  }, { passive: false });

  // Mouse events on canvas (desktop — no magnifier needed)
  canvas.addEventListener('click', (e) => {
    if (!remoteMode) return;
    // Suppress click that fires after a drag
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    e.preventDefault();
    const coords = getCanvasCoords(e);
    send({ type: 'mouse', action: 'click', x: coords.x, y: coords.y });
    showClickIndicator(e.clientX, e.clientY);
  });

  // Mouse drag for desktop — deferred: don't send 'down' until actual drag detected
  let dragActivated = false; // true once movement exceeds threshold
  const DRAG_THRESHOLD = 0.01; // normalized coords (~15-20px)

  canvas.addEventListener('mousedown', (e) => {
    if (!remoteMode || e.button !== 0) return;
    const coords = getCanvasCoords(e);
    isDragging = true;
    dragActivated = false;
    suppressClick = false;
    dragStartX = coords.x;
    dragStartY = coords.y;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!remoteMode || !isDragging) return;
    const coords = getCanvasCoords(e);
    const dx = Math.abs(coords.x - dragStartX);
    const dy = Math.abs(coords.y - dragStartY);

    // Only activate drag once movement exceeds threshold
    if (!dragActivated) {
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        dragActivated = true;
        // Send deferred mousedown at the START position
        send({ type: 'mouse', action: 'down', x: dragStartX, y: dragStartY });
      } else {
        return; // Not yet a drag, skip
      }
    }

    const now = Date.now();
    if (now - lastMoveTime < moveThrottleMs) return;
    lastMoveTime = now;
    send({ type: 'mouse', action: 'move', x: coords.x, y: coords.y });
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!remoteMode || !isDragging) return;

    if (dragActivated) {
      // Was a real drag — send mouseup, suppress click
      const coords = getCanvasCoords(e);
      send({ type: 'mouse', action: 'up', x: coords.x, y: coords.y });
      suppressClick = true;
    }
    // If not dragActivated, it was a simple click — let click handler fire
    isDragging = false;
    dragActivated = false;
  });

  // Visual feedback for clicks
  function showClickIndicator(clientX, clientY) {
    const dot = document.createElement('div');
    dot.className = 'click-indicator';
    dot.style.left = clientX + 'px';
    dot.style.top = clientY + 'px';
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 600);
  }

  // Quality
  qualitySelect.addEventListener('change', (e) => {
    changeQuality(e.target.value);
  });

  // Double-click fullscreen
  videoContainer.addEventListener('dblclick', toggleFullscreen);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts when typing in input
    if (e.target === agentInput) return;

    switch (e.key.toLowerCase()) {
      case 'f':
        toggleFullscreen();
        break;
      case 's':
        takeScreenshot();
        break;
      case ' ':
        e.preventDefault();
        togglePause();
        break;
      case '/':
        e.preventDefault();
        agentInput.focus();
        break;
      case 'escape':
        if (isFullscreen) toggleFullscreen();
        break;
    }
  });

  // Fullscreen change handler (native API exit via Esc or system gesture)
  function onFullscreenExit() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      isFullscreen = false;
      document.body.classList.remove('fullscreen');
      hideExitFullscreenBtn();
    }
  }
  document.addEventListener('fullscreenchange', onFullscreenExit);
  document.addEventListener('webkitfullscreenchange', onFullscreenExit);

  // ===== Helpers =====
  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function showToast(text, duration) {
    duration = duration || 2500;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = text;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ===== Init =====
  connectWs();

})();
