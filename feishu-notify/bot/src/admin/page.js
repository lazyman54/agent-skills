'use strict'

function getPageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin - feishu-claude-bot</title>
<style>
  :root {
    --sidebar-w: 320px;
    --bg: #f0f2f5;
    --sidebar-bg: #fff;
    --chat-bg: #f0f2f5;
    --border: #e5e5e5;
    --text: #1a1a1a;
    --text-secondary: #8e8e93;
    --primary: #0984e3;
    --user-bubble: #0984e3;
    --user-text: #fff;
    --assistant-bubble: #fff;
    --assistant-text: #1a1a1a;
    --hover: #f5f7fa;
    --active: #e8f0fe;
    --radius: 12px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; }

  /* Auth overlay */
  .auth-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
  .auth-overlay.hidden { display: none; }
  .auth-card { background: #fff; border-radius: 16px; padding: 40px 36px; width: 400px; box-shadow: 0 20px 60px rgba(0,0,0,0.15); text-align: center; }
  .auth-card h2 { font-size: 20px; margin-bottom: 6px; }
  .auth-card p { font-size: 13px; color: var(--text-secondary); margin-bottom: 24px; }
  .auth-card input { width: 100%; padding: 10px 14px; border: 1.5px solid var(--border); border-radius: 10px; font-size: 14px; font-family: monospace; outline: none; transition: border-color .2s; }
  .auth-card input:focus { border-color: var(--primary); }
  .auth-card .auth-btn { width: 100%; margin-top: 16px; padding: 10px; border: none; border-radius: 10px; background: var(--primary); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  .auth-card .auth-btn:hover { opacity: 0.9; }
  .auth-card .auth-err { color: #e74c3c; font-size: 13px; margin-top: 10px; min-height: 18px; }

  /* Layout */
  .app { display: flex; height: 100vh; }

  /* Sidebar */
  .sidebar { width: var(--sidebar-w); min-width: var(--sidebar-w); background: var(--sidebar-bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
  .sidebar-header { padding: 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .sidebar-header h1 { font-size: 16px; font-weight: 700; }
  .sidebar-search { padding: 8px 12px; }
  .sidebar-search input { width: 100%; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; outline: none; background: var(--bg); }
  .sidebar-search input:focus { border-color: var(--primary); background: #fff; }
  .session-list { flex: 1; overflow-y: auto; }
  .session-item { padding: 12px 16px; cursor: pointer; border-bottom: 1px solid #f0f0f0; transition: background .15s; }
  .session-item:hover { background: var(--hover); }
  .session-item.active { background: var(--active); }
  .session-item .si-key { font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 12px; word-break: break-all; display: flex; align-items: center; gap: 6px; }
  .session-item .si-meta { display: flex; gap: 10px; margin-top: 4px; font-size: 11px; color: var(--text-secondary); }
  .processing-dot { width: 8px; height: 8px; border-radius: 50%; background: #00b894; display: inline-block; animation: pulse 1.2s ease-in-out infinite; flex-shrink: 0; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .processing-banner { padding: 10px 14px; background: #e0f7e9; border-radius: 8px; font-size: 12px; color: #1e6e3a; display: flex; align-items: center; gap: 8px; }
  .processing-banner .processing-dot { background: #1e6e3a; }
  .si-badge { display: inline-block; background: #eee; border-radius: 4px; padding: 1px 6px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
  .logout-btn { margin: 12px 16px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: none; cursor: pointer; font-size: 13px; color: var(--text-secondary); }
  .logout-btn:hover { background: var(--hover); }

  /* Sidebar tabs */
  .sidebar-tabs { display: flex; border-bottom: 1px solid var(--border); }
  .sidebar-tab { flex: 1; padding: 10px 0; text-align: center; font-size: 13px; font-weight: 600; cursor: pointer; border-bottom: 2px solid transparent; color: var(--text-secondary); transition: all .2s; }
  .sidebar-tab:hover { color: var(--text); background: var(--hover); }
  .sidebar-tab.active { color: var(--primary); border-bottom-color: var(--primary); }

  /* Cron jobs */
  #panelSessions { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
  .cron-list { flex: 1; overflow-y: auto; }
  .cron-item { padding: 12px 16px; border-bottom: 1px solid #f0f0f0; cursor: pointer; transition: background .15s; }
  .cron-item:hover { background: var(--hover); }
  .cron-item.active { background: var(--active); }
  .cron-item .ci-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .cron-item .ci-id { font-weight: 700; font-size: 13px; }
  .cron-item .ci-spec { font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 12px; color: var(--primary); background: #e8f4fd; padding: 2px 6px; border-radius: 4px; }
  .cron-item .ci-prompt { margin-top: 6px; font-size: 12px; color: var(--text-secondary); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .cron-item .ci-meta { display: flex; gap: 8px; margin-top: 6px; font-size: 11px; color: var(--text-secondary); align-items: center; }
  .cron-trigger-btn { padding: 4px 12px; border: 1px solid var(--primary); border-radius: 6px; background: none; color: var(--primary); font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: all .15s; }
  .cron-trigger-btn:hover { background: var(--primary); color: #fff; }
  .cron-trigger-btn.triggered { border-color: #00b894; color: #00b894; pointer-events: none; }
  .cron-trigger-btn.running { border-color: #fdcb6e; color: #d68910; pointer-events: none; }
  .running-dot { width: 6px; height: 6px; border-radius: 50%; background: #00b894; display: inline-block; animation: pulse 1.2s ease-in-out infinite; }

  /* Chat area */
  .chat-area { flex: 1; display: flex; flex-direction: column; background: var(--chat-bg); }
  .chat-header { padding: 14px 24px; background: #fff; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; min-height: 54px; }
  .chat-header .ch-title { font-size: 14px; font-weight: 600; }
  .chat-header .ch-info { font-size: 12px; color: var(--text-secondary); }
  .delete-session-btn { padding: 6px 14px; border: 1px solid #e74c3c; border-radius: 8px; background: none; color: #e74c3c; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .delete-session-btn:hover { background: #e74c3c; color: #fff; }
  .delete-session-btn.hidden { display: none; }
  .chat-messages { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; }
  .chat-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-size: 14px; flex-direction: column; gap: 8px; }
  .chat-empty svg { width: 48px; height: 48px; opacity: 0.3; }

  /* Bubbles */
  .msg-group { display: flex; flex-direction: column; gap: 2px; }
  .msg-group.user { align-items: flex-end; }
  .msg-group.assistant { align-items: flex-start; max-width: 85%; }
  .msg-label { font-size: 11px; font-weight: 600; color: var(--text-secondary); margin: 0 4px 2px; display: flex; align-items: center; gap: 6px; }
  .msg-label .msg-time { font-weight: 400; font-size: 10px; }
  .bubble { max-width: 75%; padding: 10px 14px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .msg-group.user .bubble { background: var(--user-bubble); color: var(--user-text); border-radius: var(--radius) var(--radius) 4px var(--radius); }
  .msg-group.assistant .bubble { background: var(--assistant-bubble); color: var(--assistant-text); border-radius: var(--radius) var(--radius) var(--radius) 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); max-width: 100%; }
  .bubble .truncated-note { display: block; margin-top: 8px; font-size: 11px; opacity: 0.6; font-style: italic; }

  /* Steps panel */
  .steps-toggle { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px; padding: 4px 10px; font-size: 12px; color: var(--primary); cursor: pointer; border: 1px solid #d0e3f7; border-radius: 6px; background: #f0f7ff; user-select: none; }
  .steps-toggle:hover { background: #e0efff; }
  .steps-toggle .arrow { display: inline-block; transition: transform .2s; font-size: 10px; }
  .steps-toggle .arrow.open { transform: rotate(90deg); }
  .steps-panel { margin-top: 8px; border: 1px solid #e8e8e8; border-radius: 8px; background: #fafbfc; overflow: hidden; max-width: 100%; }
  .steps-panel.collapsed { display: none; }

  .step-item { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; font-size: 12px; line-height: 1.5; }
  .step-item:last-child { border-bottom: none; }
  .step-type { display: inline-block; font-size: 10px; font-weight: 700; border-radius: 3px; padding: 1px 5px; margin-right: 6px; vertical-align: middle; }
  .step-type.thinking { background: #ffeaa7; color: #6c5900; }
  .step-type.tool_use { background: #dfe6e9; color: #2d3436; }
  .step-type.tool_result { background: #e0f7e9; color: #1e6e3a; }
  .step-type.text { background: #e8f4fd; color: #0770c2; }
  .step-tool-name { font-weight: 600; color: #2d3436; }
  .step-content { margin-top: 4px; padding: 6px 8px; background: #f5f5f5; border-radius: 4px; font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; color: #444; }
  .step-content.expandable { max-height: 60px; cursor: pointer; position: relative; }
  .step-content.expandable::after { content: "click to expand"; position: absolute; bottom: 0; right: 0; background: linear-gradient(to right, transparent, #f5f5f5 30%); padding: 0 8px; font-style: italic; color: #999; font-size: 10px; }
  .step-content.expanded { max-height: 400px; cursor: pointer; }
  .step-content.expanded::after { display: none; }
</style>
</head>
<body>

<div class="auth-overlay" id="authOverlay">
  <div class="auth-card">
    <h2>feishu-claude-bot</h2>
    <p>Enter admin token to access the dashboard</p>
    <input type="password" id="tokenInput" placeholder="Admin token" />
    <button class="auth-btn" id="loginBtn">Login</button>
    <div class="auth-err" id="authErr"></div>
  </div>
</div>

<div class="app">
  <div class="sidebar">
    <div class="sidebar-header">
      <h1 id="sidebarTitle">Sessions</h1>
      <span id="sessionCount" style="font-size:12px;color:var(--text-secondary)">0</span>
    </div>
    <div class="sidebar-tabs">
      <div class="sidebar-tab active" id="tabSessions" data-tab="sessions">Sessions</div>
      <div class="sidebar-tab" id="tabCron" data-tab="cron">Cron Jobs</div>
    </div>
    <div id="panelSessions">
      <div class="sidebar-search">
        <input type="text" id="searchInput" placeholder="Search sessions..." />
      </div>
      <div class="session-list" id="sessionList"></div>
    </div>
    <div id="panelCron" style="display:none;flex:1;overflow-y:auto;">
      <div class="cron-list" id="cronList"></div>
    </div>
    <button class="logout-btn" id="logoutBtn">Logout</button>
  </div>
  <div class="chat-area">
    <div class="chat-header">
      <div>
        <div class="ch-title" id="chTitle">Select a session</div>
        <div class="ch-info" id="chInfo"></div>
      </div>
      <button class="delete-session-btn hidden" id="deleteSessionBtn">Delete Session</button>
    </div>
    <div class="chat-messages" id="chatMessages">
      <div class="chat-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        <span>Select a session to view messages</span>
      </div>
    </div>
  </div>
</div>

<script>
(function() {
  var token = localStorage.getItem('admin_token') || '';
  var sessions = [];
  var activeKey = null;
  var refreshTimer = null;

  var $overlay = document.getElementById('authOverlay');
  var $tokenInput = document.getElementById('tokenInput');
  var $loginBtn = document.getElementById('loginBtn');
  var $authErr = document.getElementById('authErr');
  var $sessionList = document.getElementById('sessionList');
  var $searchInput = document.getElementById('searchInput');
  var $chatMessages = document.getElementById('chatMessages');
  var $chTitle = document.getElementById('chTitle');
  var $chInfo = document.getElementById('chInfo');
  var $sessionCount = document.getElementById('sessionCount');
  var $logoutBtn = document.getElementById('logoutBtn');
  var $deleteBtn = document.getElementById('deleteSessionBtn');
  var $tabSessions = document.getElementById('tabSessions');
  var $tabCron = document.getElementById('tabCron');
  var $panelSessions = document.getElementById('panelSessions');
  var $panelCron = document.getElementById('panelCron');
  var $cronList = document.getElementById('cronList');
  var $sidebarTitle = document.getElementById('sidebarTitle');
  var currentTab = 'sessions';
  var cronJobs = [];

  function headers() { return { 'Authorization': 'Bearer ' + token }; }

  function showLogin(msg) {
    token = '';
    $overlay.classList.remove('hidden');
    if (msg) $authErr.textContent = msg;
  }

  function verifyAndStart(t, isAuto) {
    token = t;
    fetch('/admin/api/sessions', { headers: headers() })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) {
          localStorage.removeItem('admin_token');
          showLogin(isAuto ? '' : data.error);
          return;
        }
        localStorage.setItem('admin_token', token);
        $overlay.classList.add('hidden');
        $authErr.textContent = '';
        sessions = data.sessions || [];
        startApp();
      })
      .catch(function() {
        showLogin(isAuto ? '' : 'Network error');
      });
  }

  // 自动登录：有缓存 token 则先验证，失败弹登录框
  if (token) { verifyAndStart(token, true); }

  $loginBtn.onclick = function() { tryLogin(); };
  $tokenInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') tryLogin(); });
  function tryLogin() {
    var t = $tokenInput.value.trim();
    if (!t) return;
    $authErr.textContent = '';
    verifyAndStart(t, false);
  }

  $logoutBtn.onclick = function() {
    token = '';
    localStorage.removeItem('admin_token');
    clearInterval(refreshTimer);
    $overlay.classList.remove('hidden');
    $tokenInput.value = '';
    $authErr.textContent = '';
  };

  $deleteBtn.onclick = function() {
    if (!activeKey) return;
    if (!confirm('确认删除此会话？关联的临时文件也会被清理。')) return;
    fetch('/admin/api/sessions?key=' + encodeURIComponent(activeKey), { method: 'DELETE', headers: headers() })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) { alert(data.error); return; }
        activeKey = null;
        $chTitle.textContent = 'Select a session';
        $chInfo.textContent = '';
        $deleteBtn.classList.add('hidden');
        $chatMessages.innerHTML = '<div class="chat-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg><span>Select a session to view messages</span></div>';
        loadSessions();
      });
  };

  var fastPollTimer = null;
  // 记住用户手动切换的展开/折叠状态，key: "steps-{msgIdx}", value: true(open)/false(closed)
  var userToggledSteps = {};
  // 记住 step-content 展开状态，key: "content-{msgIdx}-{stepIdx}", value: true(expanded)
  var userExpandedContents = {};

  function startApp() {
    loadSessions();
    refreshTimer = setInterval(function() {
      if (currentTab === 'sessions') loadSessions();
      else loadCronJobs();
    }, 15000);
  }

  // --- Tab switching ---
  $tabSessions.onclick = function() { switchTab('sessions'); };
  $tabCron.onclick = function() { switchTab('cron'); };

  function switchTab(tab) {
    currentTab = tab;
    $tabSessions.classList.toggle('active', tab === 'sessions');
    $tabCron.classList.toggle('active', tab === 'cron');
    $panelSessions.style.display = tab === 'sessions' ? '' : 'none';
    $panelCron.style.display = tab === 'cron' ? '' : 'none';
    $sidebarTitle.textContent = tab === 'sessions' ? 'Sessions' : 'Cron Jobs';
    $sessionCount.textContent = tab === 'sessions' ? sessions.length : cronJobs.length;
    if (tab === 'cron') loadCronJobs();
  }

  // --- Cron Jobs ---
  function loadCronJobs() {
    fetch('/admin/api/cron/jobs', { headers: headers() })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data || data.error) return;
        cronJobs = data.jobs || [];
        if (currentTab === 'cron') $sessionCount.textContent = cronJobs.length;
        renderCronList();
      });
  }

  var activeCronId = null;

  function renderCronList() {
    if (cronJobs.length === 0) {
      $cronList.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:13px">No cron jobs</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < cronJobs.length; i++) {
      var j = cronJobs[i];
      var isActive = activeCronId === j.id;
      var runDot = j.running ? '<span class="running-dot"></span> Running' : '';
      var btnClass = j.running ? 'cron-trigger-btn running' : 'cron-trigger-btn';
      var btnText = j.running ? 'Running...' : 'Trigger';
      html += '<div class="cron-item' + (isActive ? ' active' : '') + '" data-cron-id="' + esc(j.id) + '">'
        + '<div class="ci-header">'
        + '<span class="ci-id">#' + esc(j.id) + '</span>'
        + '<span class="ci-spec">' + esc(j.spec) + '</span>'
        + '<button class="' + btnClass + '" data-trigger-id="' + esc(j.id) + '">' + btnText + '</button>'
        + '</div>'
        + '<div class="ci-prompt">' + esc(j.prompt) + '</div>'
        + '<div class="ci-meta">'
        + '<span>by ' + esc(j.userId) + '</span>'
        + (runDot ? '<span>' + runDot + '</span>' : '')
        + '</div></div>';
    }
    $cronList.innerHTML = html;

    // Bind click events
    var items = $cronList.querySelectorAll('.cron-item');
    for (var k = 0; k < items.length; k++) {
      items[k].onclick = (function(el) {
        return function(e) {
          if (e.target.classList.contains('cron-trigger-btn')) return;
          selectCronJob(el.getAttribute('data-cron-id'));
        };
      })(items[k]);
    }
    var btns = $cronList.querySelectorAll('.cron-trigger-btn');
    for (var b = 0; b < btns.length; b++) {
      btns[b].onclick = (function(el) {
        return function(e) {
          e.stopPropagation();
          triggerCronJob(el.getAttribute('data-trigger-id'), el);
        };
      })(btns[b]);
    }
  }

  function selectCronJob(id) {
    activeCronId = id;
    var job = cronJobs.find(function(j) { return j.id === id; });
    if (!job) return;
    renderCronList();
    // Show full prompt in chat area
    $chTitle.textContent = 'Cron Job #' + id + '  (' + job.spec + ')';
    $chInfo.textContent = 'Created by ' + job.userId + '  ·  ' + new Date(job.createdAt).toLocaleString();
    $deleteBtn.classList.add('hidden');
    activeKey = null;
    $chatMessages.innerHTML = '<div class="msg-group assistant">'
      + '<div class="msg-label">Prompt</div>'
      + '<div class="bubble" style="max-width:100%;white-space:pre-wrap">' + esc(job.prompt) + '</div></div>';
  }

  function triggerCronJob(id, btnEl) {
    btnEl.textContent = 'Triggering...';
    btnEl.classList.add('triggered');
    fetch('/admin/api/cron/trigger?id=' + encodeURIComponent(id), { method: 'POST', headers: headers() })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          btnEl.textContent = 'Triggered!';
          setTimeout(function() {
            btnEl.textContent = 'Trigger';
            btnEl.classList.remove('triggered');
            loadCronJobs();
          }, 3000);
        } else {
          btnEl.textContent = 'Failed';
          setTimeout(function() { btnEl.textContent = 'Trigger'; btnEl.classList.remove('triggered'); }, 2000);
        }
      })
      .catch(function() {
        btnEl.textContent = 'Error';
        setTimeout(function() { btnEl.textContent = 'Trigger'; btnEl.classList.remove('triggered'); }, 2000);
      });
  }

  function startFastPoll() {
    stopFastPoll();
    fastPollTimer = setInterval(function() {
      if (!activeKey) { stopFastPoll(); return; }
      var active = sessions.find(function(s) { return s.rawKey === activeKey; });
      if (!active || !active.processing) { stopFastPoll(); return; }
      loadMessages(activeKey);
    }, 3000);
  }

  function stopFastPoll() {
    if (fastPollTimer) { clearInterval(fastPollTimer); fastPollTimer = null; }
  }

  function loadSessions() {
    fetch('/admin/api/sessions', { headers: headers() })
      .then(function(r) {
        if (r.status === 401 || r.status === 429) {
          clearInterval(refreshTimer);
          localStorage.removeItem('admin_token');
          showLogin(r.status === 429 ? 'Too many attempts, try later' : 'Session expired');
          return null;
        }
        return r.json();
      })
      .then(function(data) {
        if (!data || data.error) return;
        sessions = data.sessions || [];
        $sessionCount.textContent = sessions.length;
        renderSessionList();
        if (activeKey) {
          loadMessages(activeKey);
          var active = sessions.find(function(s) { return s.rawKey === activeKey; });
          if (active && active.processing) startFastPoll(); else stopFastPoll();
        }
      });
  }

  $searchInput.addEventListener('input', function() { renderSessionList(); });

  function renderSessionList() {
    var q = $searchInput.value.trim().toLowerCase();
    var html = '';
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      if (q && s.key.toLowerCase().indexOf(q) === -1 && s.model.toLowerCase().indexOf(q) === -1) continue;
      var isActive = (activeKey === s.rawKey);
      var procDot = s.processing ? '<span class="processing-dot"></span>' : '';
      html += '<div class="session-item' + (isActive ? ' active' : '') + '" data-idx="' + i + '">'
        + '<div class="si-key">' + procDot + esc(s.key) + '</div>'
        + '<div class="si-meta"><span class="si-badge">' + esc(s.model) + '</span>'
        + '<span>' + (s.messageCount || 0) + ' msgs</span>'
        + '<span>' + esc(s.age) + '</span></div></div>';
    }
    if (!html) html = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:13px">' + (q ? 'No match' : 'No active sessions') + '</div>';
    $sessionList.innerHTML = html;
    var items = $sessionList.querySelectorAll('.session-item');
    for (var j = 0; j < items.length; j++) {
      items[j].onclick = (function(el) { return function() { selectSession(parseInt(el.getAttribute('data-idx'))); }; })(items[j]);
    }
  }

  function selectSession(idx) {
    var s = sessions[idx];
    if (!s) return;
    // 切换会话时清除旧的展开状态
    userToggledSteps = {};
    userExpandedContents = {};
    activeKey = s.rawKey;
    $chTitle.textContent = s.key;
    $chInfo.textContent = s.model + '  ·  ' + (s.messageCount || 0) + ' messages  ·  ' + s.age;
    $deleteBtn.classList.remove('hidden');
    renderSessionList();
    loadMessages(s.rawKey);
    if (s.processing) startFastPoll(); else stopFastPoll();
  }

  function loadMessages(rawKey) {
    fetch('/admin/api/messages?key=' + encodeURIComponent(rawKey), { headers: headers() })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) { $chatMessages.innerHTML = '<div class="chat-empty"><span>' + esc(data.error) + '</span></div>'; return; }
        var msgs = data.messages || [];
        if (msgs.length === 0) { $chatMessages.innerHTML = '<div class="chat-empty"><span>No messages yet</span></div>'; return; }
        var html = '';
        for (var j = 0; j < msgs.length; j++) {
          var m = msgs[j];
          var role = m.role || 'assistant';
          var time = m.ts ? formatTime(m.ts) : '';
          var isProcessing = m.processing;
          var text = m.text || '';
          var truncated = false;
          if (text.length > 3000) { text = text.slice(0, 3000); truncated = true; }
          html += '<div class="msg-group ' + role + '">'
            + '<div class="msg-label">' + (role === 'user' ? 'User' : 'Assistant')
            + '<span class="msg-time">' + esc(time) + '</span></div>';
          if (isProcessing && !text) {
            html += '<div class="processing-banner"><span class="processing-dot"></span> Processing...</div>';
          } else {
            html += '<div class="bubble">' + esc(text)
              + (truncated ? '<span class="truncated-note">... truncated (' + m.text.length + ' chars)</span>' : '')
              + '</div>';
          }
          // Steps — processing 中的消息默认展开
          if (role === 'assistant' && m.steps && m.steps.length > 0) {
            html += renderSteps(m.steps, j, isProcessing);
          }
          html += '</div>';
        }
        var wasAtBottom = $chatMessages.scrollHeight - $chatMessages.scrollTop - $chatMessages.clientHeight < 80;
        $chatMessages.innerHTML = html;
        if (wasAtBottom) $chatMessages.scrollTop = $chatMessages.scrollHeight;
        bindStepEvents();
      });
  }

  function renderSteps(steps, msgIdx, autoOpen) {
    var id = 'steps-' + msgIdx;
    // 用户手动切换过的，用用户的状态；否则用默认值
    var isOpen = (id in userToggledSteps) ? userToggledSteps[id] : !!autoOpen;
    var html = '<div class="steps-toggle" data-target="' + id + '">'
      + '<span class="arrow' + (isOpen ? ' open' : '') + '">&#9654;</span> Execution details (' + steps.length + ' steps)</div>';
    html += '<div class="steps-panel' + (isOpen ? '' : ' collapsed') + '" id="' + id + '">';
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      html += '<div class="step-item">';
      var contentKey = 'content-' + msgIdx + '-' + i;
      var isExpanded = !!userExpandedContents[contentKey];
      var cClass = isExpanded ? 'expanded' : 'expandable';
      if (s.type === 'thinking') {
        html += '<span class="step-type thinking">THINKING</span>';
        if (s.content) html += '<div class="step-content ' + cClass + '" data-ckey="' + contentKey + '">' + esc(s.content) + '</div>';
      } else if (s.type === 'tool_use') {
        html += '<span class="step-type tool_use">TOOL</span> <span class="step-tool-name">' + esc(s.tool) + '</span>';
        if (s.input) html += '<div class="step-content ' + cClass + '" data-ckey="' + contentKey + '">' + esc(s.input) + '</div>';
      } else if (s.type === 'tool_result') {
        html += '<span class="step-type tool_result">RESULT</span>';
        if (s.content) html += '<div class="step-content ' + cClass + '" data-ckey="' + contentKey + '">' + esc(s.content) + '</div>';
      } else if (s.type === 'text') {
        html += '<span class="step-type text">TEXT</span>';
        if (s.content) html += '<div class="step-content ' + cClass + '" data-ckey="' + contentKey + '">' + esc(s.content) + '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function bindStepEvents() {
    var toggles = document.querySelectorAll('.steps-toggle');
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].onclick = (function(el) {
        return function() {
          var targetId = el.getAttribute('data-target');
          var target = document.getElementById(targetId);
          if (!target) return;
          var arrow = el.querySelector('.arrow');
          if (target.classList.contains('collapsed')) {
            target.classList.remove('collapsed');
            arrow.classList.add('open');
            userToggledSteps[targetId] = true;
          } else {
            target.classList.add('collapsed');
            arrow.classList.remove('open');
            userToggledSteps[targetId] = false;
          }
        };
      })(toggles[i]);
    }
    // 绑定 step-content 展开/折叠事件，保存状态
    var contents = document.querySelectorAll('.step-content');
    for (var j = 0; j < contents.length; j++) {
      contents[j].onclick = (function(el) {
        return function() {
          var ckey = el.getAttribute('data-ckey');
          el.classList.toggle('expanded');
          el.classList.toggle('expandable');
          if (ckey) userExpandedContents[ckey] = el.classList.contains('expanded');
        };
      })(contents[j]);
    }
  }

  function formatTime(ts) {
    var d = new Date(ts);
    var pad = function(n) { return n < 10 ? '0' + n : n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }
})();
</script>
</body>
</html>`
}

module.exports = { getPageHtml }
