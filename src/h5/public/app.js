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
      case 'welcome':
        if (msg.status) updateStatus(msg.status);
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
      videoContainer.requestFullscreen?.() ||
        videoContainer.webkitRequestFullscreen?.();
    } else {
      document.exitFullscreen?.() ||
        document.webkitExitFullscreen?.();
    }
  }

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

  // Fullscreen change handler
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      isFullscreen = false;
      document.body.classList.remove('fullscreen');
    }
  });

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
