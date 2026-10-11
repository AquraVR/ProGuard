/* ProGuard — Discord security dashboard
   API access is handled by the Cloudflare Worker.
   The Worker must independently authorize every privileged operation.
*/
(() => {
  'use strict';

  const CONFIG = {
    apiTimeout: 15000,
    commandPollAttempts: 12,
    commandPollInterval: 1500,
    ownerId: '1406333881023594576',
    loginPath: '/auth/discord',
    logoutPath: '/auth/logout'
  };

  const state = {
    user: null,
    isOwner: false,
    guilds: [],
    guildId: null,
    guildInstalled: null,
    reports: [],
    cases: [],
    audit: [],
    settings: {},
    modal: null,
    loading: false,
    refreshTimer: null,
    requestController: null
  };

  const $ = (id) => document.getElementById(id);

  const all = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector));

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);

  const numberValue = (value) =>
    value !== null &&
    value !== undefined &&
    value !== '' &&
    Number.isFinite(Number(value));

  const fmt = (value) =>
    numberValue(value) ? Number(value).toLocaleString() : '—';

  const setText = (id, value) => {
    const node = $(id);
    if (node) node.textContent =
      value === null || value === undefined || value === ''
        ? '—'
        : String(value);
  };

  const setHTML = (id, html) => {
    const node = $(id);
    if (node) node.innerHTML = html;
  };

  const setWidth = (id, percent) => {
    const node = $(id);
    if (node) {
      node.style.width =
        `${Math.max(0, Math.min(100, Number(percent) || 0)}%)`;
    }
  };

  const setDisabled = (id, disabled) => {
    const node = $(id);
    if (node) node.disabled = Boolean(disabled);
  };

  const setHidden = (id, hidden) => {
    const node = $(id);
    if (node) node.classList.toggle('hidden', Boolean(hidden));
  };

  const setValue = (id, value) => {
    const node = $(id);
    if (node) node.value = value ?? '';
  };

  const getValue = (id, fallback = '') =>
    $(id)?.value ?? fallback;

  const dateText = (value) => {
    if (!value) return '—';

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  };

  const relative = (value) => {
    if (!value) return 'No heartbeat received';

    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return String(value);

    const difference = Math.max(0, Date.now() - timestamp);

    if (difference < 60000) return 'Updated just now';
    if (difference < 3600000) {
      return `${Math.floor(difference / 60000)}m ago`;
    }
    if (difference < 86400000) {
      return `${Math.floor(difference / 3600000)}h ago`;
    }

    return `${Math.floor(difference / 86400000)}d ago`;
  };

  const guildName = () =>
    state.guilds.find((guild) => guild.id === state.guildId)?.name ||
    'Select a server';

  const isInstalled = (guild) =>
    guild?.botInstalled === 'installed' ||
    guild?.installed === true;

  const isMissing = (guild) =>
    guild?.botInstalled === 'missing' ||
    guild?.installed === false;

  const currentGuild = () =>
    state.guilds.find((guild) => guild.id === state.guildId) || null;

  function toast(title, message, type = 'success') {
    let region = $('toastRegion');

    if (!region) {
      region = document.createElement('div');
      region.id = 'toastRegion';
      region.className = 'toast-region';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'false');
      document.body.appendChild(region);
    }

    const node = document.createElement('div');
    node.className = `toast${type === 'error' ? ' error' : ''}`;
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const mark = document.createElement('span');
    mark.className = 'toast-mark';
    mark.textContent = type === 'error' ? '!' : '✓';

    const content = document.createElement('div');
    const heading = document.createElement('b');
    heading.textContent = title;

    const detail = document.createElement('p');
    detail.textContent = message;

    content.append(heading, detail);
    node.append(mark, content);
    region.appendChild(node);

    window.setTimeout(() => {
      node.classList.add('toast-leaving');
      window.setTimeout(() => node.remove(), 250);
    }, 4500);
  }

  function showError(message) {
    setHidden('connectionBanner', false);
    setText('connectionMessage', message);
    setText('liveLabel', 'CONNECTION ISSUE');
  }

  function hideError() {
    setHidden('connectionBanner', true);
    setText('liveLabel', 'API CONNECTED');
  }

  function setFooterStatus(message) {
    setText('footerStatus', message);
  }

  /* -------------------------------------------------------------
     API client
     ------------------------------------------------------------- */

  async function api(path, options = {}) {
    const {
      method = 'GET',
      body,
      guildId = state.guildId,
      query = {},
      timeout = CONFIG.apiTimeout
    } = options;

    const url = new URL(path, window.location.origin);

    if (guildId) {
      url.searchParams.set('guild_id', String(guildId));
    }

    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeout);

    const headers = {
      Accept: 'application/json'
    };

    const init = {
      method,
      credentials: 'same-origin',
      headers,
      signal: controller.signal,
      cache: 'no-store'
    };

    if (method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
      headers['X-ProGuard-Request'] = '1';
      init.body = JSON.stringify(body ?? {});
    }

    try {
      const response = await fetch(url, init);
      const contentType = response.headers.get('content-type') || '';

      let data;

      if (contentType.includes('application/json')) {
        data = await response.json().catch(() => ({}));
      } else {
        const text = await response.text().catch(() => '');
        data = { message: text.slice(0, 500) };
      }

      if (!response.ok) {
        const error = new Error(
          data.message ||
          data.error ||
          `Request failed (${response.status})`
        );

        error.status = response.status;
        error.code = data.error;
        throw error;
      }

      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('The request timed out. Please try again.');
      }

      if (error instanceof TypeError) {
        throw new Error('Unable to reach the ProGuard API.');
      }

      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  /* -------------------------------------------------------------
     Session and Discord account
     ------------------------------------------------------------- */

  function setAvatar(id, user) {
    const node = $(id);
    if (!node) return;

    node.style.backgroundImage = '';
    node.style.backgroundSize = '';
    node.style.backgroundPosition = '';
    node.textContent = '?';

    if (!user) return;

    const name = user.global_name || user.username || 'Discord user';
    node.textContent = name.slice(0, 1).toUpperCase();

    if (user.avatar && user.id) {
      const extension = String(user.avatar).startsWith('a_')
        ? 'gif'
        : 'png';

      const avatarURL =
        `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/` +
        `${encodeURIComponent(user.avatar)}.${extension}?size=128`;

      node.style.backgroundImage =
        `url("${avatarURL.replace(/["\\]/g, '')}")`;
      node.style.backgroundSize = 'cover';
      node.style.backgroundPosition = 'center';
    }
  }

  function renderUser() {
    const user = state.user;

    if (!user) {
      setText('userName', 'Not signed in');
      setText('userRole', 'Sign in with Discord');
      setText('userAction', '↗');

      setAvatar('userAvatar', null);
      setAvatar('topAvatar', null);

      setHidden('adminNav', true);
      setHidden('ownerGateBanner', false);

      setText('loginButton', 'Sign in with Discord');
      setText('topLoginButton', 'Sign in');

      return;
    }

    const displayName =
      user.global_name ||
      user.username ||
      'Discord user';

    setText('userName', displayName);
    setText('userRole', state.isOwner ? 'Owner' : 'Discord account');
    setText('userAction', '⌄');

    setAvatar('userAvatar', user);
    setAvatar('topAvatar', user);

    setHidden('adminNav', !state.isOwner);
    setHidden('ownerGateBanner', state.isOwner);

    setText('loginButton', 'Sign out');
    setText('topLoginButton', 'Sign out');
  }

  async function loadSession() {
    try {
      const data = await api('/api/me', { guildId: null });

      state.user = data.user || null;

      /*
       * The Worker is authoritative. A client-side owner ID check is
       * never used to grant access to owner-only endpoints.
       */
      state.isOwner = data.isOwner === true;

      renderUser();
      setFooterStatus(state.user ? 'Signed in' : 'Sign-in required');

      return Boolean(state.user);
    } catch (error) {
      state.user = null;
      state.isOwner = false;
      renderUser();

      if (error.status && error.status !== 401) {
        console.error('[ProGuard] Session check failed:', error);
      }

      return false;
    }
  }

  function login() {
    window.location.assign(CONFIG.loginPath);
  }

  async function logout() {
    try {
      await api(CONFIG.logoutPath, {
        method: 'POST',
        guildId: null
      });
    } catch (error) {
      console.warn('[ProGuard] Logout request failed:', error);
    }

    state.user = null;
    state.isOwner = false;
    state.guilds = [];
    state.guildId = null;
    state.reports = [];
    state.cases = [];
    state.audit = [];
    state.settings = {};

    renderUser();
    renderServers();
    clearDashboard();

    toast('Signed out', 'Your dashboard session has ended.');
    setFooterStatus('Signed out');

    window.setTimeout(() => {
      window.location.assign('/');
    }, 350);
  }

  function clearDashboard() {
    const empty = '<tr><td colspan="8"><div class="empty-row"><b>Sign in to load data</b></div></td></tr>';

    for (const id of [
      'latestReportsBody',
      'allReportsBody',
      'casesBody'
    ]) {
      setHTML(id, empty);
    }

    setText('metricOpenReports', '—');
    setText('metricResolved', '—');
    setText('metricEvents', '—');
    setText('metricUptime', '—');
    setText('analyticsTotalEvents', '—');
    setText('analyticsReports', '—');
    setText('analyticsResolution', '—');
    setText('analyticsResponse', '—');
    setText('botDisplayName', 'ProGuard Bot');
    setText('botDetailName', 'ProGuard Bot');
    setText('botLastSeen', 'No heartbeat received');
    setText('botDetailSeen', 'No heartbeat received');
  }

  /* -------------------------------------------------------------
     Server selection
     ------------------------------------------------------------- */

  function renderServers() {
    const button = $('serverSelect');
    const name = guildName();

    if (button) {
      const label = button.querySelector('.server-info b') ||
        button.querySelector('b');

      if (label) label.textContent = name;

      const initials = name
        .split(/\s+/)
        .map((word) => word[0] || '')
        .join('')
        .slice(0, 2)
        .toUpperCase();

      const avatar = button.querySelector('.server-avatar');
      if (avatar) avatar.textContent = initials || 'PG';
      button.disabled = state.guilds.length === 0;
    }

    const menu = $('serverMenu');
    if (!menu) return;

    if (!state.guilds.length) {
      menu.innerHTML = `
        <div class="empty-row">
          <b>No servers available</b>
          <small>No manageable Discord servers were returned.</small>
        </div>`;
      return;
    }

    menu.innerHTML = state.guilds.map((guild) => {
      let label = 'Bot status unknown';

      if (isInstalled(guild)) label = 'Bot installed';
      else if (isMissing(guild)) label = 'Bot not installed';

      return `
        <button
          type="button"
          role="option"
          data-guild="${esc(guild.id)}"
          aria-selected="${guild.id === state.guildId ? 'true' : 'false'}"
        >
          <span>${esc(guild.name || 'Unnamed server')}</span>
          <small>${esc(label)}</small>
        </button>`;
    }).join('');
  }

  async function loadGuilds() {
    const data = await api('/api/guilds', { guildId: null });

    state.guilds = Array.isArray(data.guilds) ? data.guilds : [];

    if (!state.guilds.some((guild) => guild.id === state.guildId)) {
      const selected =
        state.guilds.find(isInstalled) ||
        state.guilds[0] ||
        null;

      state.guildId = selected?.id || null;
    }

    renderServers();
  }

  async function selectGuild(guildId) {
    if (!state.guilds.some((guild) => guild.id === guildId)) return;
    if (state.guildId === guildId) return;

    state.guildId = guildId;
    setHidden('serverMenu', true);
    renderServers();

    state.reports = [];
    state.cases = [];

    await refreshAll();
  }

  function renderInstallPrompt(guild) {
    if (!guild || !isMissing(guild)) {
      setHidden('installBotPrompt', true);
      return;
    }

    setHidden('installBotPrompt', false);

    const installLink = $('installBotLink');
    if (installLink) {
      installLink.href = guild.installUrl || guild.inviteUrl || '#';
      installLink.target = '_blank';
      installLink.rel = 'noopener noreferrer';
    }

    setText(
      'installBotMessage',
      'ProGuard is not added to this server.'
    );
  }

  /* -------------------------------------------------------------
     Bot status
     ------------------------------------------------------------- */

  const BOT_LABEL = {
    online: 'ONLINE',
    offline: 'OFFLINE',
    stale: 'STALE',
    unknown: 'UNKNOWN'
  };

  const BOT_CLASS = {
    online: 'online',
    offline: 'offline',
    stale: 'unknown',
    unknown: 'unknown'
  };

  function setService(id, status) {
    const node = $(id);
    if (!node) return;

    const value = String(status || 'unknown').toLowerCase();

    node.textContent = value.toUpperCase();
    node.classList.toggle('ok', value === 'online' || value === 'healthy');
    node.classList.toggle(
      'error',
      value === 'offline' || value === 'error' || value === 'failed'
    );
  }

  function renderBot(bot = {}) {
    const status = String(bot.status || 'unknown').toLowerCase();
    const label = BOT_LABEL[status] || 'UNKNOWN';

    for (const id of ['botStatusBadge', 'botDetailBadge']) {
      const node = $(id);
      if (!node) continue;

      node.className = `status-badge ${BOT_CLASS[status] || 'unknown'}`;
      node.textContent = label;
    }

    const name = bot.botName || 'ProGuard Bot';

    setText('botDisplayName', name);
    setText('botDetailName', name);
    setText(
      'botActivity',
      status === 'online'
        ? 'Connected and reporting'
        : status === 'stale'
          ? 'Heartbeat is stale; status may be outdated'
          : status === 'offline'
            ? 'The bot reports that it is offline'
            : 'Waiting for a verified heartbeat'
    );

    setText('botLastSeen', relative(bot.lastHeartbeat));
    setText(
      'botDetailSeen',
      bot.lastHeartbeat
        ? `Last heartbeat ${relative(bot.lastHeartbeat)}`
        : 'No heartbeat received'
    );

    setText(
      'botLatency',
      numberValue(bot.latencyMs) ? `${bot.latencyMs} ms` : '—'
    );

    setText('botGuilds', numberValue(bot.guildCount) ? bot.guildCount : '—');
    setText('botVersion', bot.version || '—');
    setText('detailProcessState', label);

    setText(
      'detailLatency',
      numberValue(bot.latencyMs) ? `${bot.latencyMs} ms` : '—'
    );

    setText(
      'detailHeartbeat',
      bot.lastHeartbeat ? dateText(bot.lastHeartbeat) : '—'
    );

    setText(
      'protectionText',
      status === 'online'
        ? 'Bot reporting healthy'
        : status === 'stale'
          ? 'Bot heartbeat is stale'
          : status === 'offline'
            ? 'Bot reports offline'
            : 'Status unavailable'
    );

    $('protectionPip')?.classList.toggle('online', status === 'online');

    setService(
      'runtimeServiceStatus',
      status === 'online'
        ? 'online'
        : status === 'offline' || status === 'stale'
          ? 'offline'
          : 'unknown'
    );
  }

  async function loadBot() {
    if (!state.guildId) return null;

    const data = await api('/api/bot/status');
    renderBot(data.bot || {});

    state.guildInstalled = data.guild?.installed;
    renderInstallPrompt(currentGuild());

    return data;
  }

  /* -------------------------------------------------------------
     Charts
     ------------------------------------------------------------- */

  function renderChart(containerId, axisId, points) {
    const container = $(containerId);
    const axis = $(axisId);

    if (!container || !axis) return;

    if (
      !Array.isArray(points) ||
      !points.length ||
      points.every((point) =>
        !(Number(point.events) || 0) &&
        !(Number(point.resolved) || 0)
      )
    ) {
      container.innerHTML = `
        <div class="chart-empty">
          <span class="chart-empty-icon">⌁</span>
          <b>No activity in this period</b>
          <small>Activity will appear when the API records events.</small>
        </div>`;

      axis.innerHTML = '<span>—</span><span>—</span><span>—</span>';
      return;
    }

    const width = 700;
    const height = 200;
    const padding = { left: 8, right: 8, top: 12, bottom: 12 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;

    const events = points.map((point) => Number(point.events) || 0);
    const resolved = points.map((point) => Number(point.resolved) || 0);
    const max = Math.max(1, ...events, ...resolved);

    const x = (index) =>
      padding.left +
      (points.length === 1
        ? innerWidth / 2
        : index * innerWidth / (points.length - 1));

    const y = (value) =>
      padding.top + innerHeight - (value / max) * innerHeight;

    const makePath = (values) =>
      values.map((value, index) =>
        `${index ? 'L' : 'M'} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`
      ).join(' ');

    const eventPath = makePath(events);
    const resolvedPath = makePath(resolved);

    const areaPath =
      `${eventPath} L ${x(points.length - 1)} ${height - padding.bottom}` +
      ` L ${x(0)} ${height - padding.bottom} Z`;

    const grid = [0, 0.25, 0.5, 0.75, 1].map((step) => {
      const lineY = padding.top + innerHeight * step;
      return `<line x1="${padding.left}" y1="${lineY}" x2="${width - padding.right}" y2="${lineY}" stroke="#202b3b" stroke-dasharray="3 5"/>`;
    }).join('');

    const dots = events.map((value, index) =>
      `<circle cx="${x(index)}" cy="${y(value)}" r="2.8" fill="#80bbff" stroke="#101722" stroke-width="1.5"/>`
    ).join('');

    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Security activity chart">
        <defs>
          <linearGradient id="${esc(containerId)}Area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#5da4ff" stop-opacity=".22"/>
            <stop offset="100%" stop-color="#5da4ff" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid}
        <path d="${areaPath}" fill="url(#${esc(containerId)}Area)"/>
        <path d="${resolvedPath}" fill="none" stroke="#4b5e78" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="${eventPath}" fill="none" stroke="#75b4ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}
      </svg>`;

    const labels = points.map((point) => {
      const date = new Date(point.label);
      return Number.isNaN(date.getTime())
        ? String(point.label || '—')
        : date.toLocaleDateString([], {
            month: 'short',
            day: 'numeric'
          });
    });

    const last = points.length - 1;
    const indices = [...new Set([
      0,
      Math.round(last / 4),
      Math.round(last / 2),
      Math.round((3 * last) / 4),
      last
    ])];

    axis.innerHTML = indices
      .map((index) => `<span>${esc(labels[index] || '—')}</span>`)
      .join('');
  }

  /* -------------------------------------------------------------
     Reports and cases
     ------------------------------------------------------------- */

  function priorityClass(priority) {
    const value = String(priority || 'medium').toLowerCase();

    return ['critical', 'high', 'medium', 'low'].includes(value)
      ? `priority-${value}`
      : 'priority-medium';
  }

  function stateClass(status) {
    const value = String(status || 'open').toLowerCase();

    return [
      'open',
      'reviewing',
      'resolved',
      'dismissed',
      'investigating',
      'recorded'
    ].includes(value)
      ? value
      : 'open';
  }

  function statusPill(status) {
    const value = String(status || 'open').toLowerCase();

    return `<span class="state-pill ${stateClass(value)}">${esc(
      value.replace(/[_-]/g, ' ')
    )}</span>`;
  }

  function renderLatestReports() {
    const active = state.reports
      .filter((report) =>
        !['resolved', 'dismissed'].includes(
          String(report.status || '').toLowerCase()
        )
      )
      .slice(0, 5);

    const waiting = state.reports.filter((report) =>
      ['open', 'reviewing'].includes(
        String(report.status || '').toLowerCase()
      )
    ).length;

    setText('reportNavCount', waiting);

    const node = $('latestReportsBody');
    if (!node) return;

    node.innerHTML = active.length
      ? active.map((report) => `
          <tr>
            <td><span class="report-id">#${esc(report.id)}</span></td>
            <td class="reason-cell">${esc(report.reason || report.description || 'No reason supplied')}</td>
            <td><span class="priority-pill ${priorityClass(report.priority)}">${esc(report.priority || 'medium')}</span></td>
            <td>${statusPill(report.status)}</td>
            <td><button type="button" class="row-action" data-report-open="${esc(report.id)}" aria-label="Open report">↗</button></td>
          </tr>
        `).join('')
      : `
          <tr>
            <td colspan="5">
              <div class="empty-row">
                <span>✓</span>
                <b>No open reports</b>
                <small>New reports will appear here when recorded by the API.</small>
              </div>
            </td>
          </tr>`;
  }

  function renderReports() {
    const search = getValue('reportSearch').toLowerCase().trim();
    const statusFilter = getValue('reportStatusFilter', 'all');
    const priorityFilter = getValue('reportPriorityFilter', 'all');

    const rows = state.reports.filter((report) => {
      const searchable = [
        report.id,
        report.reporter,
        report.reportedUser,
        report.reason,
        report.description
      ].join(' ').toLowerCase();

      return (
        (!search || searchable.includes(search)) &&
        (statusFilter === 'all' || report.status === statusFilter) &&
        (priorityFilter === 'all' || report.priority === priorityFilter)
      );
    });

    setText('allReportsCount', rows.length);
    setText(
      'reportTableMeta',
      `${rows.length} record${rows.length === 1 ? '' : 's'}`
    );

    const node = $('allReportsBody');
    if (!node) return;

    node.innerHTML = rows.length
      ? rows.map((report) => `
          <tr>
            <td><span class="report-id">#${esc(report.id)}</span></td>
            <td>${esc(report.reporter || 'Unknown')}</td>
            <td class="reason-cell" title="${esc(report.reason || '')}">${esc(report.reason || report.description || '—')}</td>
            <td><span class="priority-pill ${priorityClass(report.priority)}">${esc(report.priority || 'medium')}</span></td>
            <td>${statusPill(report.status)}</td>
            <td>${esc(dateText(report.createdAt))}</td>
            <td><button type="button" class="row-action" data-report-open="${esc(report.id)}" aria-label="Review report">↗</button></td>
          </tr>
        `).join('')
      : `
          <tr>
            <td colspan="7">
              <div class="empty-row">
                <span>⌁</span>
                <b>No matching reports</b>
                <small>Try changing your search or filters.</small>
              </div>
            </td>
          </tr>`;
  }

  function renderCases() {
    const filter = getValue('caseStatusFilter', 'all');

    const rows = state.cases.filter((item) =>
      filter === 'all' || item.status === filter
    );

    const count = (status) =>
      state.cases.filter((item) => item.status === status).length;

    setText('activeCasesMetric', count('open') + count('investigating'));
    setText('resolvedCasesMetric', count('resolved'));
    setText('dismissedCasesMetric', count('dismissed'));

    const node = $('casesBody');
    if (!node) return;

    node.innerHTML = rows.length
      ? rows.map((item) => `
          <tr>
            <td><span class="report-id">#${esc(item.id)}</span></td>
            <td>${esc(item.subject || 'Untitled case')}</td>
            <td>${esc(item.action || '—')}</td>
            <td>${statusPill(item.status)}</td>
            <td>${esc(item.assignedTo || 'Unassigned')}</td>
            <td>${esc(dateText(item.updatedAt || item.createdAt))}</td>
            <td><button type="button" class="row-action" data-case-open="${esc(item.id)}" aria-label="Open case">↗</button></td>
          </tr>
        `).join('')
      : `
          <tr>
            <td colspan="7">
              <div class="empty-row">
                <span>⌁</span>
                <b>No cases found</b>
                <small>Cases appear when the API records moderation actions.</small>
              </div>
            </td>
          </tr>`;
  }

  function renderBreakdown(entries) {
    const node = $('reportBreakdown');
    if (!node) return;

    if (!Array.isArray(entries) || !entries.length) {
      node.innerHTML = `
        <div class="empty-row">
          <b>No category data</b>
          <small>No events were returned for this period.</small>
        </div>`;
      return;
    }

    const max = Math.max(
      1,
      ...entries.map((entry) => Number(entry.count) || 0)
    );

    node.innerHTML = entries.map((entry) => {
      const count = Number(entry.count) || 0;
      const width = Math.round((count / max) * 100);

      return `
        <div class="breakdown-row">
          <span>${esc(entry.label || 'Other')}</span>
          <span>${fmt(count)}</span>
          <div class="breakdown-track">
            <span style="width:${width}%"></span>
          </div>
        </div>`;
    }).join('');
  }

  /* -------------------------------------------------------------
     Overview and analytics
     ------------------------------------------------------------- */

  async function loadOverview() {
    if (!state.guildId) return;

    const range = getValue('activityRange', '7d');
    const data = await api('/api/overview', {
      query: { range }
    });

    const metrics = data.metrics || {};
    const bot = data.bot || {};

    setText('metricOpenReports', fmt(metrics.openReports));
    setText('metricResolved', fmt(metrics.resolvedCases));
    setText('metricEvents', fmt(metrics.securityEvents));
    setText('metricUptime', BOT_LABEL[bot.status] || 'UNKNOWN');

    setText(
      'openReportsNote',
      metrics.openReports ? 'Waiting for review' : 'Nothing waiting'
    );

    setText('resolvedNote', 'Reported totals');
    setText(
      'eventsNote',
      `Last ${range === '24h' ? '24 hours' : range === '30d' ? '30 days' : '7 days'}`
    );

    setText(
      'uptimeNote',
      bot.lastHeartbeat
        ? `Heartbeat ${relative(bot.lastHeartbeat)}`
        : 'Waiting for bot heartbeat'
    );

    const maximum = Math.max(
      1,
      Number(metrics.openReports) || 0,
      Number(metrics.resolvedCases) || 0,
      Number(metrics.securityEvents) || 0
    );

    setWidth('openTrack', ((Number(metrics.openReports) || 0) / maximum) * 100);
    setWidth('resolvedTrack', ((Number(metrics.resolvedCases) || 0) / maximum) * 100);
    setWidth('eventsTrack', ((Number(metrics.securityEvents) || 0) / maximum) * 100);

    renderChart('activityChart', 'chartAxis', data.activity || []);
    renderBot(bot);

    if (data.services) {
      setService('firebaseServiceStatus', data.services.firebase);
      setService('discordServiceStatus', data.services.discord);
    }
  }

  async function loadReports() {
    if (!state.guildId) return;

    const data = await api('/api/reports', {
      query: { status: 'all' }
    });

    state.reports = Array.isArray(data.items) ? data.items : [];

    renderLatestReports();
    renderReports();
  }

  async function loadCases() {
    if (!state.guildId) return;

    const data = await api('/api/cases');

    state.cases = Array.isArray(data.items) ? data.items : [];
    renderCases();
  }

  async function loadAnalytics() {
    if (!state.guildId) return;

    const range = getValue('analyticsRange', '7d');
    const data = await api('/api/analytics', {
      query: { range }
    });

    const metrics = data.metrics || {};

    setText('analyticsTotalEvents', fmt(metrics.totalEvents));
    setText('analyticsReports', fmt(metrics.reportsReceived));

    setText(
      'analyticsResolution',
      metrics.resolutionRate == null
        ? '—'
        : `${metrics.resolutionRate}%`
    );

    setText(
      'analyticsResponse',
      metrics.averageResponseTime || '—'
    );

    renderChart('analyticsChart', 'analyticsAxis', data.activity || []);
    renderBreakdown(data.breakdown || []);
  }

  /* -------------------------------------------------------------
     Server settings
     ------------------------------------------------------------- */

  async function loadSettings() {
    if (!state.guildId) return;

    const data = await api('/api/settings');
    const settings = data.settings || {};
    const installed = data.installed === true ||
      isInstalled(currentGuild());

    state.settings = settings;

    const channels = Array.isArray(data.channels) ? data.channels : [];
    const options = channels.map((channel) =>
      `<option value="${esc(channel.id)}">#${esc(channel.name)}</option>`
    ).join('');

    for (const [id, value] of [
      ['logChannelSelect', settings.logChannelId],
      ['reportChannelSelect', settings.reportChannelId]
    ]) {
      const select = $(id);
      if (!select) continue;

      select.innerHTML = `<option value="">Not set</option>${options}`;
      select.value = value || '';
      select.disabled = !installed;
    }

    setText('blockedWordCount', settings.blockedWordCount ?? 0);

    const automodButton = $('toggleAutomod');
    if (automodButton) {
      automodButton.textContent = settings.automodEnabled
        ? 'Turn automod off'
        : 'Turn automod on';

      automodButton.disabled = !installed;
    }

    setDisabled('sendTestMessage', !installed);
    setHidden('settingsGate', installed);

    if ($('settingsGate')) {
      $('settingsGate').dataset.enabled = String(installed);
    }

    const statuses = [
      settings.reportChannelId ? 'ACTIVE' : 'CHANNEL NOT SET',
      settings.logChannelId ? 'ACTIVE' : 'CHANNEL NOT SET',
      'AVAILABLE'
    ];

    all('#moduleList .module-state').forEach((node, index) => {
      node.textContent = statuses[index] || '—';
    });

    renderInstallPrompt(currentGuild());
  }

  async function saveChannel(kind) {
    const select = $(kind === 'log'
      ? 'logChannelSelect'
      : 'reportChannelSelect');

    if (!select) return;

    if (!state.guildId) {
      toast('No server selected', 'Select a server first.', 'error');
      return;
    }

    try {
      await api('/api/settings', {
        method: 'POST',
        body: {
          action: kind === 'log'
            ? 'set_log_channel'
            : 'set_report_channel',
          channelId: select.value || null
        }
      });

      toast(
        'Settings saved',
        kind === 'log'
          ? 'The log channel setting was saved.'
          : 'The report channel setting was saved.'
      );

      await loadSettings();
    } catch (error) {
      toast('Settings not saved', error.message, 'error');
    }
  }

  async function toggleAutomod() {
    const next = !state.settings?.automodEnabled;

    try {
      await api('/api/settings', {
        method: 'POST',
        body: {
          action: 'set_automod',
          enabled: next
        }
      });

      toast('Settings saved', `Automod ${next ? 'enabled' : 'disabled'}.`);
      await loadSettings();
    } catch (error) {
      toast('Settings not saved', error.message, 'error');
    }
  }

  async function sendTestMessage() {
    const output = $('commandResult');

    if (output) output.textContent = 'Sending test request…';

    try {
      const queued = await api('/api/bot/command', {
        method: 'POST',
        body: { type: 'send_test_message' }
      });

      if (!queued.id) {
        throw new Error('The API did not return a command ID.');
      }

      for (let attempt = 0; attempt < CONFIG.commandPollAttempts; attempt++) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, CONFIG.commandPollInterval)
        );

        const result = await api(
          `/api/bot/command/${encodeURIComponent(queued.id)}`
        );

        if (result.status === 'done') {
          if (output) {
            output.textContent = 'Done: the bot completed the test request.';
          }
          toast('Test complete', 'The bot reported success.');
          return;
        }

        if (result.status === 'failed') {
          throw new Error(result.error || 'The bot could not complete the request.');
        }
      }

      if (output) {
        output.textContent = 'No response yet. Check the bot status and logs.';
      }

      toast('Still waiting', 'The bot has not confirmed the test yet.', 'error');
    } catch (error) {
      if (output) output.textContent = `Not completed: ${error.message}`;
      toast('Test failed', error.message, 'error');
    }
  }

  /* -------------------------------------------------------------
     Owner audit log
     ------------------------------------------------------------- */

  async function loadAudit() {
    if (!state.isOwner) {
      toast('Owner access required', 'This area is restricted.', 'error');
      return;
    }

    const data = await api('/api/admin/audit', { guildId: null });

    state.audit = Array.isArray(data.items) ? data.items : [];

    setHTML(
      'auditList',
      state.audit.length
        ? state.audit.map((entry) => `
            <div class="module-row">
              <span class="module-symbol">⌁</span>
              <span>
                <b>${esc(entry.action || 'Activity')}</b>
                <small>
                  ${esc(entry.actorName || entry.actorId || 'System')}
                  · ${esc(dateText(entry.timestamp))}
                  ${entry.guildId ? ` · server ${esc(entry.guildId)}` : ''}
                </small>
              </span>
            </div>
          `).join('')
        : `
            <div class="empty-row">
              <b>No audit entries</b>
              <small>Recorded owner actions will appear here.</small>
            </div>`
    );
  }

  /* -------------------------------------------------------------
     Report and case dialogs
     ------------------------------------------------------------- */

  function openReport(id) {
    const report = state.reports.find(
      (item) => String(item.id) === String(id)
    );

    if (!report) return;

    state.modal = { type: 'report', id: report.id };

    setText('reportModalTitle', `Report #${report.id}`);

    setHTML('reportModalContent', `
      <div class="modal-field">
        <label>REPORTED USER</label>
        <p>${esc(report.reportedUser || 'Unknown')}</p>
      </div>
      <div class="modal-field">
        <label>SUBMITTED BY</label>
        <p>${esc(report.reporter || 'Unknown')}</p>
      </div>
      <div class="modal-field">
        <label>REASON</label>
        <p>${esc(report.reason || 'No reason supplied.')}</p>
      </div>
      <div class="modal-field">
        <label>DESCRIPTION</label>
        <p>${esc(report.description || 'No description supplied.')}</p>
      </div>
      <div class="modal-field">
        <label>CURRENT STATUS</label>
        <p>${esc(report.status || 'open')}</p>
      </div>
      <div class="modal-field">
        <label>PRIORITY</label>
        <select id="modalPriority">
          ${['low', 'medium', 'high', 'critical'].map((priority) => `
            <option value="${priority}" ${report.priority === priority ? 'selected' : ''}>
              ${priority[0].toUpperCase() + priority.slice(1)}
            </option>
          `).join('')}
        </select>
      </div>
      <div class="modal-field">
        <label>REVIEW NOTES</label>
        <textarea id="modalNotes" maxlength="2000" placeholder="Document the decision and context…">${esc(report.reviewNotes || '')}</textarea>
      </div>
    `);

    setHTML('reportModalActions', `
      <button type="button" class="button button-quiet" data-close-modal>Cancel</button>
      <button type="button" class="button button-secondary" data-report-action="reviewing">Mark reviewing</button>
      <button type="button" class="button button-secondary" data-report-action="dismissed">Dismiss</button>
      <button type="button" class="button button-primary" data-report-action="resolved">Resolve report</button>
    `);

    setHidden('reportModal', false);
    $('reportModal')?.setAttribute('aria-hidden', 'false');
  }

  function openCase(id) {
    const item = state.cases.find(
      (entry) => String(entry.id) === String(id)
    );

    if (!item) return;

    state.modal = { type: 'case', id: item.id };

    setText('reportModalTitle', `Case #${item.id}`);

    const statuses = ['open', 'investigating', 'resolved', 'dismissed'];

    setHTML('reportModalContent', `
      <div class="modal-field">
        <label>SUBJECT</label>
        <p>${esc(item.subject || 'Untitled case')}</p>
      </div>
      <div class="modal-field">
        <label>ACTION</label>
        <p>${esc(item.action || '—')} — ${esc(item.reason || 'No reason recorded')}</p>
      </div>
      <div class="modal-field">
        <label>STATUS</label>
        <select id="caseStatus">
          ${statuses.map((status) => `
            <option value="${status}" ${item.status === status ? 'selected' : ''}>
              ${status[0].toUpperCase() + status.slice(1)}
            </option>
          `).join('')}
        </select>
      </div>
      <div class="modal-field">
        <label>CASE NOTES</label>
        <textarea id="caseNotes" maxlength="2000" placeholder="Investigation notes…">${esc(item.notes || '')}</textarea>
      </div>
    `);

    setHTML('reportModalActions', `
      <button type="button" class="button button-quiet" data-close-modal>Cancel</button>
      <button type="button" class="button button-primary" data-case-save>Save case</button>
    `);

    setHidden('reportModal', false);
    $('reportModal')?.setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    setHidden('reportModal', true);
    $('reportModal')?.setAttribute('aria-hidden', 'true');
    state.modal = null;
  }

  async function reportAction(action) {
    if (!state.modal || state.modal.type !== 'report') return;

    const id = state.modal.id;

    try {
      await api(
        `/api/reports/${encodeURIComponent(id)}/action`,
        {
          method: 'POST',
          body: {
            action,
            status: action,
            priority: getValue('modalPriority', 'medium'),
            notes: getValue('modalNotes')
          }
        }
      );

      closeModal();
      toast('Report updated', `Report #${id} was updated.`);
      await Promise.all([loadReports(), loadOverview()]);
    } catch (error) {
      toast('Report not updated', error.message, 'error');
    }
  }

  async function saveCase() {
    if (!state.modal || state.modal.type !== 'case') return;

    const id = state.modal.id;

    try {
      await api(
        `/api/cases/${encodeURIComponent(id)}/action`,
        {
          method: 'POST',
          body: {
            action: 'update',
            status: getValue('caseStatus', 'open'),
            notes: getValue('caseNotes')
          }
        }
      );

      closeModal();
      toast('Case saved', `Case #${id} was updated.`);
      await Promise.all([loadCases(), loadOverview()]);
    } catch (error) {
      toast('Case not saved', error.message, 'error');
    }
  }

  /* -------------------------------------------------------------
     Navigation
     ------------------------------------------------------------- */

  const PAGE_NAMES = {
    overview: 'Overview',
    reports: 'Reports',
    cases: 'Cases',
    analytics: 'Analytics',
    bot: 'Bot status',
    settings: 'Server settings',
    admin: 'Owner controls'
  };

  function go(page, updateHash = true) {
    if (!PAGE_NAMES[page]) page = 'overview';

    if (page === 'admin' && !state.isOwner) {
      toast(
        'Owner access required',
        'This area is restricted to the owner account.',
        'error'
      );
      return;
    }

    all('.page-view').forEach((view) => {
      view.classList.toggle('active', view.dataset.view === page);
    });

    all('.nav-link[data-page]').forEach((link) => {
      const active = link.dataset.page === page;

      link.classList.toggle('active', active);

      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    setText('breadcrumbCurrent', PAGE_NAMES[page]);
    setHidden('serverMenu', true);
    setHidden('sidebar', false);
    $('sidebar')?.classList.remove('open');

    if (updateHash) {
      history.replaceState(null, '', `#${page}`);
    }

    if (page === 'admin') {
      loadAudit().catch((error) =>
        toast('Audit log unavailable', error.message, 'error')
      );
    }

    if (page === 'reports') {
      loadReports().catch((error) =>
        toast('Reports unavailable', error.message, 'error')
      );
    }

    if (page === 'cases') {
      loadCases().catch((error) =>
        toast('Cases unavailable', error.message, 'error')
      );
    }

    if (page === 'analytics') {
      loadAnalytics().catch((error) =>
        toast('Analytics unavailable', error.message, 'error')
      );
    }

    if (page === 'bot') {
      loadBot().catch((error) =>
        toast('Bot status unavailable', error.message, 'error')
      );
    }

    if (page === 'settings') {
      loadSettings().catch((error) =>
        toast('Settings unavailable', error.message, 'error')
      );
    }
  }

  /* -------------------------------------------------------------
     Dashboard refresh
     ------------------------------------------------------------- */

  async function refreshAll() {
    if (state.loading) return;
    state.loading = true;

    const refreshButton = $('refreshButton');
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.style.opacity = '.6';
    }

    try {
      const signedIn = await loadSession();

      if (!signedIn) {
        clearDashboard();
        showError('Sign in with Discord to load your dashboard.');
        setFooterStatus('Sign-in required');
        return;
      }

      await loadGuilds();

      if (!state.guildId) {
        clearDashboard();
        showError(
          'No manageable server was returned. Check your Discord server permissions.'
        );
        setFooterStatus('No server selected');
        return;
      }

      renderInstallPrompt(currentGuild());

      if (isMissing(currentGuild())) {
        renderBot({ status: 'unknown' });
        state.reports = [];
        state.cases = [];
        renderLatestReports();
        renderReports();
        renderCases();
        setHidden('settingsGate', false);
        showError('ProGuard is not added to this server. Install the bot to enable server features.');
        setFooterStatus('Bot not installed');
        return;
      }

      const tasks = [
        loadOverview(),
        loadReports(),
        loadCases(),
        loadBot(),
        loadSettings(),
        loadAnalytics()
      ];

      const results = await Promise.allSettled(tasks);
      const failures = results.filter((result) => result.status === 'rejected');

      if (failures.length) {
        console.error(
          '[ProGuard] Some dashboard requests failed:',
          failures.map((result) => result.reason)
        );

        showError(
          'Some dashboard data could not be loaded. Try refreshing or check the Worker logs.'
        );

        setFooterStatus('Partial data');
      } else {
        hideError();
        setFooterStatus('API responding');
      }
    } catch (error) {
      console.error('[ProGuard] Refresh failed:', error);

      showError(
        error.status === 401
          ? 'Your Discord session expired. Sign in again.'
          : 'The dashboard could not load data from the API.'
      );

      setFooterStatus('Connection issue');
    } finally {
      state.loading = false;

      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.style.opacity = '1';
      }
    }
  }

  /* -------------------------------------------------------------
     Event handlers
     ------------------------------------------------------------- */

  function on(id, event, handler) {
    const node = $(id);
    if (node) node.addEventListener(event, handler);
  }

  function bind() {
    all('.nav-link[data-page]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        go(link.dataset.page);
      });
    });

    all('[data-go]').forEach((button) => {
      button.addEventListener('click', () => go(button.dataset.go));
    });

    on('menuButton', 'click', () => {
      $('sidebar')?.classList.toggle('open');
    });

    on('refreshButton', 'click', refreshAll);
    on('bannerRetry', 'click', refreshAll);
    on('reviewReportsButton', 'click', () => go('reports'));

    on('reportsRefresh', 'click', () =>
      loadReports().catch((error) =>
        toast('Reports unavailable', error.message, 'error')
      )
    );

    on('casesRefresh', 'click', () =>
      loadCases().catch((error) =>
        toast('Cases unavailable', error.message, 'error')
      )
    );

    on('botRefresh', 'click', () =>
      loadBot().catch((error) =>
        toast('Status unavailable', error.message, 'error')
      )
    );

    on('auditRefresh', 'click', () =>
      loadAudit().catch((error) =>
        toast('Audit log unavailable', error.message, 'error')
      )
    );

    on('settingsRefresh', 'click', () =>
      loadSettings().catch((error) =>
        toast('Settings unavailable', error.message, 'error')
      )
    );

    on('reportSearch', 'input', renderReports);
    on('reportStatusFilter', 'change', renderReports);
    on('reportPriorityFilter', 'change', renderReports);
    on('caseStatusFilter', 'change', renderCases);

    on('clearReportFilters', 'click', () => {
      setValue('reportSearch', '');
      setValue('reportStatusFilter', 'all');
      setValue('reportPriorityFilter', 'all');
      renderReports();
    });

    on('activityRange', 'change', () =>
      loadOverview().catch((error) =>
        toast('Chart unavailable', error.message, 'error')
      )
    );

    on('analyticsRange', 'change', () =>
      loadAnalytics().catch((error) =>
        toast('Analytics unavailable', error.message, 'error')
      )
    );

    const authHandler = () => state.user ? logout() : login();

    on('loginButton', 'click', authHandler);
    on('topLoginButton', 'click', authHandler);

    on('serverSelect', 'click', () => {
      const menu = $('serverMenu');
      if (menu) menu.classList.toggle('hidden');
    });

    on('saveLogChannel', 'click', () => saveChannel('log'));
    on('saveReportChannel', 'click', () => saveChannel('report'));
    on('toggleAutomod', 'click', toggleAutomod);
    on('sendTestMessage', 'click', sendTestMessage);

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element
        ? event.target
        : null;

      if (!target) return;

      const serverButton = target.closest('#serverMenu [data-guild]');
      if (serverButton) {
        selectGuild(serverButton.dataset.guild);
        return;
      }

      const reportButton = target.closest('[data-report-open]');
      if (reportButton) {
        openReport(reportButton.dataset.reportOpen);
        return;
      }

      const caseButton = target.closest('[data-case-open]');
      if (caseButton) {
        openCase(caseButton.dataset.caseOpen);
        return;
      }

      const reportActionButton = target.closest('[data-report-action]');
      if (reportActionButton) {
        reportAction(reportActionButton.dataset.reportAction);
        return;
      }

      if (target.closest('[data-case-save]')) {
        saveCase();
        return;
      }

      if (target.closest('[data-close-modal]')) {
        closeModal();
        return;
      }

      if (target === $('reportModal')) {
        closeModal();
        return;
      }

      if (!target.closest('#serverSelect') && !target.closest('#serverMenu')) {
        setHidden('serverMenu', true);
      }
    });

    window.addEventListener('hashchange', () => {
      const page = window.location.hash.slice(1);
      go(PAGE_NAMES[page] ? page : 'overview', false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeModal();
        $('sidebar')?.classList.remove('open');
        setHidden('serverMenu', true);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.user && !state.loading) {
        refreshAll();
      }
    });
  }

  /* -------------------------------------------------------------
     Initialization
     ------------------------------------------------------------- */

  function init() {
    setText(
      'currentDate',
      new Date().toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      })
    );

    setText('footerYear', new Date().getFullYear());

    bind();

    const params = new URLSearchParams(window.location.search);

    if (params.get('access') === 'denied') {
      toast(
        'Access denied',
        'This dashboard is restricted to authorized accounts.',
        'error'
      );
    } else if (params.get('login') === 'cancelled') {
      toast('Sign-in cancelled', 'No changes were made.', 'error');
    } else if (params.get('error')) {
      toast(
        'Sign-in failed',
        'Discord authentication did not complete. Please try again.',
        'error'
      );
    }

    if (
      params.has('access') ||
      params.has('login') ||
      params.has('error')
    ) {
      history.replaceState(
        null,
        '',
        window.location.pathname + window.location.hash
      );
    }

    const initialPage = window.location.hash.slice(1);

    if (PAGE_NAMES[initialPage]) {
      go(initialPage, false);
    } else {
      go('overview', false);
    }

    refreshAll();

    state.refreshTimer = window.setInterval(() => {
      if (!document.hidden && state.user && !state.loading) {
        refreshAll();
      }
    }, 60000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
