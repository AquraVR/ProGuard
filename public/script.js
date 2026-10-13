
/* ProGuard dashboard frontend. All sensitive access checks remain in src/worker.js. */
(() => {
  'use strict';

  const OAUTH_URL = 'https://discord.com/oauth2/authorize?client_id=1558816067948642455&response_type=code&redirect_uri=https%3A%2F%2Fproguard.guardianpro.workers.dev%2Fauth%2Fdiscord%2Fcallback&scope=identify+email+guilds';
  const OWNER_ID = '1406333881023594576';
  const $ = (id) => document.getElementById(id);

  const state = {
    user: null, isOwner: false, guilds: [], guildId: null,
    reports: [], cases: [], settings: {}, overview: null,
    bot: null, audit: [], page: 'overview', busy: false,
    pendingReport: null
  };

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const fmt = (v) => Number.isFinite(Number(v)) ? Number(v).toLocaleString() : '—';

  const asArray = (v) => Array.isArray(v) ? v :
    Array.isArray(v?.items) ? v.items :
    Array.isArray(v?.reports) ? v.reports :
    Array.isArray(v?.cases) ? v.cases : [];

  const toast = (message, type = '') => {
    const region = $('toastRegion');
    if (!region) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    region.append(el);
    setTimeout(() => el.remove(), 4200);
  };

  function connection(ok, text) {
    const pill = $('connectionPill');
    if (pill) {
      pill.classList.toggle('ok', !!ok);
      pill.classList.toggle('bad', ok === false);
    }
    if ($('connectionText')) $('connectionText').textContent = text;
  }

  function notice(title, message, show = true) {
    const n = $('connectionBanner');
    if (!n) return;
    n.classList.toggle('hidden', !show);
    if ($('connectionTitle')) $('connectionTitle').textContent = title;
    if ($('connectionMessage')) $('connectionMessage').textContent = message;
  }

  function queryPath(path, scoped = true) {
    if (!scoped || !state.guildId) return path;
    return `${path}${path.includes('?') ? '&' : '?'}guild_id=${encodeURIComponent(state.guildId)}`;
  }

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');

    if (method !== 'GET' && method !== 'HEAD') {
      headers.set('Content-Type', 'application/json');
      headers.set('X-ProGuard-Request', '1');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);

    try {
      const response = await fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });

      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json') ? await response.json() : null;

      if (!response.ok) {
        const err = new Error(data?.message || data?.error || `Request failed (${response.status})`);
        err.status = response.status;
        err.code = data?.error;
        throw err;
      }

      return data || {};
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('The request timed out. Check the Worker and try again.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function apiError(err, fallback = 'Could not load data.') {
    if (err?.status === 401 ||
        (err?.status === 403 && ['unauthorized', 'session_expired'].includes(err?.code))) {
      state.user = null;
      renderAuth();
      notice('Sign-in required', 'Connect your Discord account again to access the dashboard.');
    } else if (err?.status === 500 && /not configured/i.test(err.message)) {
      notice('Worker setup incomplete',
        'The Cloudflare Worker is missing one or more required variables or secrets. Configure them in Cloudflare before testing the dashboard.');
    }
    toast(err?.message || fallback, 'error');
  }

  function initials(name = '') {
    return name.trim().split(/\s+/).slice(0, 2)
      .map(x => x[0] || '').join('').toUpperCase() || 'PG';
  }

  function avatarUrl(user) {
    if (!user?.id || !user?.avatar) return '';
    const ext = String(user.avatar).startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.${ext}?size=128`;
  }

  function renderAuth() {
    const logged = !!state.user;

    $('loginButton')?.classList.toggle('hidden', logged);
    $('topLoginButton')?.classList.toggle('hidden', logged);
    $('profileButton')?.classList.toggle('hidden', !logged);

    if ($('topName')) $('topName').textContent =
      state.user?.global_name || state.user?.username || 'Account';

    if ($('userName')) $('userName').textContent =
      state.user?.global_name || state.user?.username || 'Guest';

    const avatar = avatarUrl(state.user);

    ['topAvatar', 'userAvatar'].forEach(id => {
      const img = $(id);
      if (!img) return;

      if (avatar) {
        img.src = avatar;
        img.alt = `${state.user?.username || 'Discord'} avatar`;
        img.classList.remove('hidden');
      } else {
        img.removeAttribute('src');
        img.alt = '';
      }
    });

    $('adminNav')?.classList.toggle('hidden', !state.isOwner);

    if ($('settingsUserRole')) {
      $('settingsUserRole').textContent =
        state.isOwner ? 'Owner' : logged ? 'Discord account' : 'Not signed in';
    }

    if ($('ownerIdentity')) {
      $('ownerIdentity').textContent = state.isOwner
        ? (state.user?.username || 'Verified')
        : 'Restricted';
    }
  }

  function setPage(page) {
    if (!$(`page-${page}`)) page = 'overview';

    if (page === 'admin' && !state.isOwner) {
      toast('Owner access is required.', 'error');
      page = 'overview';
    }

    state.page = page;

    document.querySelectorAll('.page').forEach(p =>
      p.classList.toggle('active', p.id === `page-${page}`)
    );

    document.querySelectorAll('.nav-link').forEach(a =>
      a.classList.toggle('active', a.dataset.page === page)
    );

    const titles = {
      overview: 'Overview',
      reports: 'Reports',
      cases: 'Cases',
      analytics: 'Analytics',
      bot: 'Bot status',
      settings: 'Server settings',
      admin: 'Owner controls'
    };

    if ($('breadcrumbPage')) $('breadcrumbPage').textContent = titles[page] || 'Overview';
    document.title = `${titles[page] || 'Overview'} — ProGuard`;
    history.replaceState(null, '', `#${page}`);
    $('sidebar')?.classList.remove('open');

    if (page === 'reports') loadReports();
    if (page === 'cases') loadCases();
    if (page === 'analytics') loadAnalytics();
    if (page === 'bot') loadBot();
    if (page === 'settings') loadSettings();
    if (page === 'admin' && state.isOwner) loadAudit();
  }

  function setGuild(guild) {
    if (!guild?.id) return;

    state.guildId = guild.id;

    if ($('serverName')) $('serverName').textContent = guild.name || 'Discord server';
    if ($('serverSub')) $('serverSub').textContent =
      guild.botInstalled ? 'ProGuard installed' : 'Bot not installed';
    if ($('serverInitials')) $('serverInitials').textContent = initials(guild.name || 'PG');
    if ($('settingsGuildName')) $('settingsGuildName').textContent = guild.name || guild.id;

    $('serverMenu')?.classList.add('hidden');
    $('serverSelect')?.setAttribute('aria-expanded', 'false');

    loadDashboard();

    if (state.page !== 'overview') setPage(state.page);
  }

  function renderGuilds() {
    const menu = $('serverMenu');
    if (!menu) return;

    menu.innerHTML = '';

    if (!state.guilds.length) {
      menu.innerHTML = '<div class="empty-state"><b>No manageable servers found</b><p>Your Discord account needs Manage Server permission.</p></div>';
      return;
    }

    state.guilds.forEach(g => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'server-option';
      b.setAttribute('role', 'option');

      b.innerHTML = `
        <span class="server-avatar">${esc(initials(g.name))}</span>
        <span>
          <b>${esc(g.name || 'Discord server')}</b>
          <small>${g.botInstalled ? 'ProGuard installed' : 'Bot not installed'}</small>
        </span>`;

      b.addEventListener('click', () => setGuild(g));
      menu.append(b);
    });

    if (!state.guildId || !state.guilds.some(g => g.id === state.guildId)) {
      setGuild(state.guilds[0]);
    }
  }

  async function loadIdentity() {
    try {
      const me = await api('/api/me');

      state.user = me.user || null;
      state.isOwner = !!me.isOwner || state.user?.id === OWNER_ID;

      connection(true, 'API connected');
      notice('', '', false);
      renderAuth();

      const guildData = await api('/api/guilds');
      state.guilds = asArray(guildData.guilds);

      renderGuilds();

      if (!state.guilds.length) {
        notice(
          'No manageable servers found',
          'Your signed-in Discord account did not return servers where you have Manage Server permission. Check the Discord account and OAuth setup.'
        );
      }

      return true;
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        state.user = null;
        state.isOwner = false;
        renderAuth();
        connection(false, 'Sign in required');
        notice(
          'Connect your Discord account',
          'Sign in with Discord to load your servers and security data. The dashboard will not invent sample metrics.'
        );
      } else {
        connection(false, 'API unavailable');
        notice('Dashboard could not connect', err.message || 'Check your Worker configuration and deployment.');
        apiError(err);
      }
      return false;
    }
  }

  function setMetric(id, value) {
    if ($(id)) $(id).textContent =
      value === null || value === undefined ? '—' : fmt(value);
  }

  function setBar(id, value, max = 100) {
    const el = $(id);
    if (el) {
      el.style.width = `${Math.max(0, Math.min(100,
        (Number(value) || 0) / Math.max(1, Number(max) || 1) * 100
      ))}%`;
    }
  }

  function statusClass(value) {
    const s = String(value || '').toLowerCase();
    if (['online', 'healthy', 'installed', 'enabled', 'resolved', 'active', 'connected', 'true'].includes(s)) return 'good';
    if (['offline', 'error', 'not installed', 'disabled', 'false', 'stale'].includes(s)) return 'bad';
    return '';
  }

  function putStatus(id, value, fallback = 'Unknown') {
    const el = $(id);
    if (!el) return;
    el.textContent = value || fallback;
    el.classList.remove('good', 'bad');
    const c = statusClass(value);
    if (c) el.classList.add(c);
  }

  async function loadDashboard() {
    if (!state.user || !state.guildId) return;

    try {
      const [overview, reports, cases, bot] = await Promise.all([
        api(queryPath('/api/overview?range=7d')),
        api(queryPath('/api/reports?status=all')),
        api(queryPath('/api/cases')),
        api(queryPath('/api/bot/status'))
      ]);

      state.overview = overview;
      state.reports = asArray(reports);
      state.cases = asArray(cases);
      state.bot = bot;

      renderOverview();
      renderReports();
      renderCases();
      renderBot();

      if ($('lastUpdated')) {
        $('lastUpdated').textContent =
          `UPDATED ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }

      connection(true, 'API connected');
    } catch (err) {
      apiError(err, 'Unable to refresh dashboard.');
      connection(false, 'API issue');
    }
  }

  function renderOverview() {
    const m = state.overview?.metrics || {};
    const open = m.openReports ?? state.reports.filter(r =>
      (r.status || 'open') === 'open'
    ).length;
    const activeCases = state.cases.filter(c =>
      !['resolved', 'dismissed'].includes(String(c.status).toLowerCase())
    ).length;
    const resolved = state.reports.filter(r =>
      String(r.status).toLowerCase() === 'resolved'
    ).length;

    setMetric('metricReports', open);
    setMetric('metricCases', activeCases);
    setMetric('metricResolved', resolved);

    setBar('reportsBar', open, Math.max(10, open));
    setBar('casesBar', activeCases, Math.max(10, activeCases));
    setBar('resolvedBar', resolved, Math.max(10, resolved));

    const installed = state.bot?.guild?.installed;
    const botText = state.bot?.bot?.status ||
      state.bot?.bot?.state ||
      (installed === false ? 'Not installed' :
        state.bot?.bot?.online === true ? 'Online' : 'Unknown');

    if ($('metricBot')) $('metricBot').textContent = botText;
    if ($('metricBotFoot')) {
      $('metricBotFoot').textContent = state.bot?.bot?.lastHeartbeat
        ? `Heartbeat ${timeAgo(state.bot.bot.lastHeartbeat)}`
        : installed === false ? 'Install required' : 'No heartbeat data';
    }

    setBar('botBar', statusClass(botText) === 'good' ? 100 : 0, 100);

    if ($('reportNavCount')) $('reportNavCount').textContent = String(open);
    if ($('healthFooterText')) $('healthFooterText').textContent =
      'Dashboard data fetched from your Worker';

    putStatus('healthApi', 'Online');

    const selected = state.guilds.find(g => g.id === state.guildId);
    putStatus('healthGuild', selected?.name || 'Selected');

    if ($('healthGuildDetail')) {
      $('healthGuildDetail').textContent = selected?.name || 'Selected Discord server';
    }

    putStatus('healthBot', botText);

    if ($('healthBotDetail')) {
      $('healthBotDetail').textContent = state.bot?.bot?.lastHeartbeat
        ? `Last heartbeat ${timeAgo(state.bot.bot.lastHeartbeat)}`
        : 'No recent heartbeat reported';
    }

    if ($('liveLabel')) {
      $('liveLabel').classList.toggle('ok', statusClass(botText) === 'good');
      $('liveLabel').innerHTML =
        `<i></i> ${esc(statusClass(botText) === 'good' ? 'ONLINE' : 'STATUS UNKNOWN')}`;
    }

    const recent = $('recentReports');
    if (recent) {
      const items = state.reports.slice(0, 4);
      recent.innerHTML = items.length ? items.map(r => `
        <div class="data-item">
          <div class="data-item-main">
            <b>${esc(r.title || r.subject || r.reason || `Report ${r.id || ''}`)}</b>
            <small>${esc(r.reporterName || r.reporter_name || r.reporter || r.submittedBy || 'Discord member')} · ${esc(timeAgo(r.createdAt || r.created_at))}</small>
          </div>
          <span class="status-badge ${esc(r.status || 'open')}">${esc(r.status || 'open')}</span>
        </div>`).join('') :
        emptyMarkup('No reports found', 'New reports will show here when submitted.');
    }
  }

  function emptyMarkup(title, desc) {
    return `<div class="empty-state"><span class="empty-symbol">◌</span><b>${esc(title)}</b><p>${esc(desc)}</p></div>`;
  }

  function timeAgo(input) {
    if (!input) return 'time unavailable';
    const d = new Date(input);
    if (!Number.isFinite(d.getTime())) return 'time unavailable';
    const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  }

  function renderReports() {
    const items = state.reports || [];
    const body = $('reportsTable');
    if (!body) return;

    if ($('reportsCount')) $('reportsCount').textContent = `${items.length} ITEMS`;
    if ($('reportsSummary')) {
      $('reportsSummary').textContent =
        `${items.length} report${items.length === 1 ? '' : 's'} returned by the API`;
    }

    if ($('reportNavCount')) {
      $('reportNavCount').textContent = String(items.filter(r =>
        ['open', 'reviewing'].includes(String(r.status || 'open').toLowerCase())
      ).length);
    }

    if (!items.length) {
      body.innerHTML = '<tr><td colspan="6" class="table-empty">No reports returned for this server.</td></tr>';
      return;
    }

    body.innerHTML = items.map(r => {
      const id = r.id || r.reportId || '';
      const subject = r.subject || r.title || r.reason || 'Unspecified report';
      const reporter = r.reporterName || r.reporter_name || r.reporter ||
        r.submittedBy || r.reporterId || r.reporter_id || 'Unknown';
      const status = String(r.status || 'open').toLowerCase();

      return `<tr>
        <td><span class="table-id">${esc(String(id).slice(0, 12) || '—')}</span></td>
        <td>${esc(reporter)}</td>
        <td>${esc(subject)}</td>
        <td><span class="status-badge ${esc(status)}">${esc(status)}</span></td>
        <td>${esc(timeAgo(r.createdAt || r.created_at))}</td>
        <td>${['open', 'reviewing'].includes(status) && id
          ? `<button class="row-action" data-report-action="${esc(id)}" data-action="reviewing">Review</button>`
          : '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('');
  }

  function renderCases() {
    const body = $('casesTable');
    if (!body) return;

    const items = state.cases || [];
    if ($('casesCount')) $('casesCount').textContent = `${items.length} CASES`;

    if (!items.length) {
      body.innerHTML = '<tr><td colspan="6" class="table-empty">No cases returned for this server.</td></tr>';
      return;
    }

    body.innerHTML = items.map(c => `
      <tr>
        <td><span class="table-id">${esc(c.id || c.caseId || '—')}</span></td>
        <td>${esc(c.title || c.subject || c.description || 'Untitled case')}</td>
        <td>${esc(c.assigneeName || c.assignee_name || c.assignedTo || c.assigned_to || c.assignee || 'Unassigned')}</td>
        <td><span class="status-badge ${esc(c.priority || 'medium')}">${esc(c.priority || 'medium')}</span></td>
        <td><span class="status-badge ${esc(c.status || 'open')}">${esc(c.status || 'open')}</span></td>
        <td>${esc(timeAgo(c.updatedAt || c.updated_at || c.createdAt || c.created_at))}</td>
      </tr>`).join('');
  }

  function renderBot() {
    const b = state.bot || {};
    const g = b.guild || {};
    const bot = b.bot || {};
    const online = ['online', 'healthy', 'connected'].includes(
      String(bot.status || bot.state || '').toLowerCase()
    ) || bot.online === true;
    const installed = !!g.installed;

    if ($('botStatusTitle')) {
      $('botStatusTitle').textContent = installed
        ? online ? 'Bot is online' : 'Bot status unavailable'
        : 'ProGuard is not added to this server';
    }

    if ($('botStatusDescription')) {
      $('botStatusDescription').textContent = installed
        ? online
          ? 'A recent heartbeat indicates the bot is connected.'
          : 'The bot is installed, but the Worker has not confirmed a current heartbeat. Check the bot process and heartbeat configuration.'
        : 'Install ProGuard in this Discord server before its server-specific features can run.';
    }

    if ($('botStatusChip')) {
      $('botStatusChip').textContent = installed
        ? online ? 'ONLINE' : 'NO HEARTBEAT'
        : 'NOT INSTALLED';
      $('botStatusChip').className =
        `status-chip ${installed && online ? 'good' : installed ? '' : 'bad'}`;
    }

    if ($('botLastSeen')) {
      $('botLastSeen').textContent = `Last heartbeat: ${
        bot.lastHeartbeat ? new Date(bot.lastHeartbeat).toLocaleString() : 'not reported'
      }`;
    }

    if ($('installedBadge')) {
      $('installedBadge').textContent = installed ? 'INSTALLED' : 'NOT INSTALLED';
      $('installedBadge').className = `status-chip ${installed ? 'good' : 'bad'}`;
    }

    if ($('installedDetail')) {
      $('installedDetail').textContent = installed
        ? 'Bot is present in this server'
        : 'Use Add to Discord to install the bot';
    }

    if ($('enabledBadge')) {
      $('enabledBadge').textContent = g.enabled ? 'ENABLED' : 'DISABLED';
      $('enabledBadge').className = `status-chip ${g.enabled ? 'good' : ''}`;
    }

    if ($('reportChannelValue')) $('reportChannelValue').textContent = g.reportChannelId || 'Not configured';
    if ($('logChannelValue')) $('logChannelValue').textContent = g.logChannelId || 'Not configured';

    const invite = $('inviteBot');
    if (invite && state.guildId) {
      invite.href = `https://discord.com/oauth2/authorize?client_id=1558816067948642455&permissions=8&scope=bot%20applications.commands&guild_id=${encodeURIComponent(state.guildId)}&disable_guild_select=true`;
    }

    if ($('metricBot')) {
      $('metricBot').textContent = installed ? online ? 'Online' : 'Unknown' : 'Not installed';
    }
  }

  async function loadReports() {
    if (!state.user || !state.guildId) return;
    try {
      const d = await api(queryPath(
        `/api/reports?status=${encodeURIComponent($('reportFilter')?.value || 'all')}`
      ));
      state.reports = asArray(d);
      renderReports();
      renderOverview();
    } catch (e) {
      apiError(e);
    }
  }

  async function loadCases() {
    if (!state.user || !state.guildId) return;
    try {
      const d = await api(queryPath('/api/cases'));
      state.cases = asArray(d);
      renderCases();
      renderOverview();
    } catch (e) {
      apiError(e);
    }
  }

  async function loadBot() {
    if (!state.user || !state.guildId) return;
    try {
      state.bot = await api(queryPath('/api/bot/status'));
      renderBot();
    } catch (e) {
      apiError(e);
    }
  }

  async function loadSettings() {
    if (!state.user || !state.guildId) return;
    try {
      const d = await api(queryPath('/api/settings'));
      state.settings = d.settings || {};
      const s = state.settings;

      if ($('settingEnabled')) $('settingEnabled').checked = !!s.automodEnabled;
      if ($('settingLogging')) $('settingLogging').checked = !!s.automodEnabled;
      if ($('reportChannelInput')) $('reportChannelInput').value = s.reportChannelId || '';
      if ($('logChannelInput')) $('logChannelInput').value = s.logChannelId || '';
      if ($('settingsGuildName')) {
        $('settingsGuildName').textContent = s.guildName ||
          state.guilds.find(g => g.id === state.guildId)?.name || state.guildId;
      }
    } catch (e) {
      apiError(e);
    }
  }

  async function saveSettings() {
    if (!state.guildId) return toast('Choose a server first.', 'error');

    const button = $('saveSettings');
    if (button) {
      button.disabled = true;
      button.textContent = 'Saving…';
    }

    try {
      const enabled = !!$('settingEnabled')?.checked;

      if (enabled !== !!state.settings.automodEnabled) {
        await api(queryPath('/api/settings'), {
          method: 'POST',
          body: { action: 'set_automod', enabled }
        });
      }

      const reportChannelId = $('reportChannelInput')?.value.trim() || '';
      const logChannelId = $('logChannelInput')?.value.trim() || '';

      if (reportChannelId !== String(state.settings.reportChannelId || '')) {
        await api(queryPath('/api/settings'), {
          method: 'POST',
          body: { action: 'set_report_channel', channelId: reportChannelId || null }
        });
      }

      if (logChannelId !== String(state.settings.logChannelId || '')) {
        await api(queryPath('/api/settings'), {
          method: 'POST',
          body: { action: 'set_log_channel', channelId: logChannelId || null }
        });
      }

      toast('Settings saved.', 'success');
      await loadSettings();
      await loadBot();
    } catch (e) {
      apiError(e, 'Settings could not be saved.');
    } finally {
      if (button) {
        button.disabled = false;
        button.innerHTML = 'Save settings <span>→</span>';
      }
    }
  }

  async function loadAnalytics() {
    if (!state.user || !state.guildId) return;

    const range = $('analyticsRange')?.value || '7d';

    try {
      const d = await api(queryPath(`/api/analytics?range=${encodeURIComponent(range)}`));
      const m = d.metrics || d;

      setMetric('analyticsTotal', m.totalReports ?? m.reports ?? m.total ?? '—');
      setMetric('analyticsResolved', m.resolvedReports ?? m.resolved ?? '—');
      setMetric('analyticsOpen', m.openReports ?? m.open ?? '—');
      setMetric('analyticsCases', m.activeCases ?? m.openCases ?? m.cases ?? '—');

      renderChart(d.activity || d.series || d.timeline || []);
    } catch (e) {
      apiError(e);
    }
  }

  function renderChart(rows) {
    const el = $('analyticsChart');
    if (!el) return;

    if (!Array.isArray(rows) || !rows.length) {
      el.innerHTML = emptyMarkup('No activity in this period',
        'The API returned no activity buckets for this range.');
      return;
    }

    const max = Math.max(1, ...rows.map(x =>
      Number(x.events ?? x.count ?? x.reports ?? 0)
    ));

    el.innerHTML = `<div class="chart-bars">${rows.slice(-30).map(x => {
      const n = Number(x.events ?? x.count ?? x.reports ?? 0);
      return `<div class="chart-column" title="${esc(x.label)}: ${n}">
        <i style="height:${Math.max(2, n / max * 100)}%"></i>
        <small>${esc(x.label || '')}</small>
      </div>`;
    }).join('')}</div>`;
  }

  async function loadAudit() {
    if (!state.isOwner) return;

    try {
      const d = await api('/api/admin/audit');
      state.audit = asArray(d);

      if ($('auditCount')) $('auditCount').textContent = fmt(state.audit.length);

      const body = $('auditTable');
      if (body) {
        body.innerHTML = state.audit.length ? state.audit.map(a => `
          <tr>
            <td>${esc(a.action || a.event || 'Event')}</td>
            <td>${esc(a.actor_name || a.actorName || a.actor_id || a.actorId || '—')}</td>
            <td>${esc(JSON.stringify(a.detail || a.details || {}))}</td>
            <td>${esc(timeAgo(a.ts || a.created_at || a.timestamp))}</td>
          </tr>`).join('') :
          '<tr><td colspan="4" class="table-empty">No audit entries returned.</td></tr>';
      }
    } catch (e) {
      apiError(e);
    }
  }

  function reportAction(id, action) {
    const dialog = $('actionModal');
    if (!dialog) return;

    state.pendingReport = { id, action };

    if ($('modalTitle')) {
      $('modalTitle').textContent = action === 'reviewing'
        ? 'Start report review'
        : `Mark report ${action}`;
    }

    if ($('modalDescription')) {
      $('modalDescription').textContent =
        `This action will be sent to the Worker for report ${id}.`;
    }

    if ($('actionNote')) $('actionNote').value = '';
    dialog.showModal();
  }

  async function confirmReportAction() {
    const p = state.pendingReport;
    if (!p) return;

    const button = $('confirmAction');
    if (button) {
      button.disabled = true;
      button.textContent = 'Applying…';
    }

    try {
      await api(queryPath(`/api/reports/${encodeURIComponent(p.id)}/action`), {
        method: 'POST',
        body: {
          action: p.action,
          notes: $('actionNote')?.value.trim() || ''
        }
      });

      $('actionModal')?.close();
      toast('Report updated.', 'success');
      await loadReports();
    } catch (e) {
      apiError(e);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Confirm action';
      }
      state.pendingReport = null;
    }
  }

  function goToDiscordOAuth() {
    window.location.assign(OAUTH_URL);
  }

  function bind() {
    document.querySelectorAll('[data-page]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        setPage(a.dataset.page);
      });
    });

    document.querySelectorAll('[data-goto]').forEach(b => {
      b.addEventListener('click', () => setPage(b.dataset.goto));
    });

    $('serverSelect')?.addEventListener('click', () => {
      const menu = $('serverMenu');
      const open = menu?.classList.toggle('hidden') === false;
      $('serverSelect')?.setAttribute('aria-expanded', String(open));
    });

    $('mobileMenu')?.addEventListener('click', () => $('sidebar')?.classList.toggle('open'));

    $('loginButton')?.addEventListener('click', goToDiscordOAuth);
    $('topLoginButton')?.addEventListener('click', goToDiscordOAuth);

    $('profileButton')?.addEventListener('click', async () => {
      if (!confirm('Sign out of ProGuard?')) return;
      try {
        await api('/auth/logout', { method: 'POST', body: {} });
      } catch (_) {}
      window.location.assign('/');
    });

    $('refreshButton')?.addEventListener('click', refreshAll);
    $('overviewRefresh')?.addEventListener('click', refreshAll);
    $('reportsRefresh')?.addEventListener('click', loadReports);
    $('casesRefresh')?.addEventListener('click', loadCases);
    $('botRefresh')?.addEventListener('click', loadBot);
    $('auditRefresh')?.addEventListener('click', loadAudit);
    $('saveSettings')?.addEventListener('click', saveSettings);
    $('analyticsRange')?.addEventListener('change', loadAnalytics);
    $('reportFilter')?.addEventListener('change', loadReports);
    $('dismissNotice')?.addEventListener('click', () => notice('', '', false));
    $('confirmAction')?.addEventListener('click', confirmReportAction);

    document.addEventListener('click', e => {
      const b = e.target.closest('[data-report-action]');
      if (b) reportAction(b.dataset.reportAction, b.dataset.action);

      if (!e.target.closest('#serverSelect') && !e.target.closest('#serverMenu')) {
        $('serverMenu')?.classList.add('hidden');
        $('serverSelect')?.setAttribute('aria-expanded', 'false');
      }
    });

    window.addEventListener('hashchange', () =>
      setPage(location.hash.slice(1) || 'overview')
    );

    if ($('year')) $('year').textContent = String(new Date().getFullYear());
  }

  async function refreshAll() {
    if (state.busy) return;
    state.busy = true;

    const b = $('refreshButton');
    if (b) b.style.transform = 'rotate(180deg)';

    try {
      if (!state.user) await loadIdentity();
      if (state.user && state.guildId) await loadDashboard();
    } finally {
      state.busy = false;
      if (b) b.style.transform = '';
    }
  }

  async function init() {
    bind();

    const initialPage = location.hash.slice(1);
    if (initialPage && $(`page-${initialPage}`)) setPage(initialPage);

    connection(false, 'Connecting');

    const ok = await loadIdentity();

    if (ok && state.user && state.guildId) {
      await loadDashboard();

      setInterval(() => {
        if (!document.hidden && state.user && state.guildId) loadDashboard();
      }, 60000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
