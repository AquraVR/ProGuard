/* ProGuard dashboard. Same origin as the Worker. Every decision that matters is enforced by the Worker API. */
(() => {
  'use strict';

  const state = {
    user: null, isOwner: false, guilds: [], guildId: null, guildInstalled: null,
    reports: [], cases: [], audit: [], modal: null, loading: false, settings: null,
  };
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hasNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const fmt = (v) => (hasNum(v) ? Number(v).toLocaleString() : '—');
  const dateText = (v) => {
    if (!v) return '—';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const relative = (v) => {
    if (!v) return 'No heartbeat received';
    const ms = Date.now() - new Date(v).getTime();
    if (!Number.isFinite(ms)) return String(v);
    if (ms < 60000) return 'Updated just now';
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  };
  const setText = (id, value) => { const n = $(id); if (n) n.textContent = value == null || value === '' ? '—' : String(value); };
  const setWidth = (id, pct) => { const n = $(id); if (n) n.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`; };
  const guildName = () => state.guilds.find((g) => g.id === state.guildId)?.name || 'Select a server';

  /* ---------------------------------------------------------------- API client */

  async function api(path, { method = 'GET', body, guildId = state.guildId, query = {} } = {}) {
    const url = new URL(path, window.location.origin);
    if (guildId) url.searchParams.set('guild_id', guildId);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers = { Accept: 'application/json' };
    const init = { method, credentials: 'same-origin', headers };
    if (method !== 'GET') {
      headers['X-ProGuard-Request'] = '1';
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!res.ok) {
      const err = new Error(data.message || (res.status === 404 ? 'API route not found (404). The Worker may be out of date.' : `Request failed (${res.status})`));
      err.status = res.status;
      err.code = data.error;
      throw err;
    }
    return data;
  }

  function toast(title, message, type = 'success') {
    const node = document.createElement('div');
    node.className = `toast ${type === 'error' ? 'error' : ''}`;
    node.innerHTML = `<span class="toast-mark">${type === 'error' ? '!' : '✓'}</span><div><b>${esc(title)}</b><p>${esc(message)}</p></div>`;
    $('toastRegion').appendChild(node);
    setTimeout(() => node.remove(), 4800);
  }

  function showError(message) {
    $('connectionBanner').classList.remove('hidden');
    setText('connectionMessage', message);
    const live = $('liveIndicator');
    live.className = 'live-indicator warn';
    setText('liveLabel', 'ISSUE');
  }
  function hideError() {
    $('connectionBanner').classList.add('hidden');
    const live = $('liveIndicator');
    live.className = 'live-indicator ok';
    setText('liveLabel', 'LIVE');
  }

  /* ---------------------------------------------------------------- health & session */

  async function checkWorker() {
    try {
      const h = await api('/api/health', { guildId: null });
      setService('workerServiceStatus', h.configured ? 'online' : 'error');
      if (!h.configured) showError('The Worker is deployed but not fully configured. Check its secrets and variables.');
      return h;
    } catch (e) {
      setService('workerServiceStatus', 'error');
      throw e;
    }
  }

  function renderAccount() {
    const u = state.user;
    const signedIn = !!u;
    const name = signedIn ? (u.global_name || u.username || 'Owner') : 'Sign in with Discord';
    const initial = name.slice(0, 1).toUpperCase();
    setText('userName', signedIn ? name : 'Not signed in');
    setText('userEmail', signedIn ? (u.email || 'No email on this Discord account') : 'Use your Discord account');
    setText('userAction', signedIn ? '⌄' : '↗');
    setText('topName', name);
    setText('accountName', name);
    setText('accountId', signedIn ? `ID ${u.id}` : '—');
    setText('accountEmail', signedIn ? (u.email || 'No email on this Discord account') : '—');
    for (const id of ['userAvatar', 'topAvatar', 'accountAvatar']) {
      const n = $(id);
      n.textContent = signedIn ? initial : '?';
      n.style.backgroundImage = '';
      if (signedIn && u.avatar) {
        n.style.backgroundImage = `url("https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128")`;
        n.textContent = '';
      }
    }
    $('adminNav').classList.toggle('hidden', !(signedIn && state.isOwner));
    $('ownerGateBanner').classList.toggle('hidden', state.isOwner);
    $('topLoginButton').setAttribute('aria-expanded', 'false');
    $('accountMenu').classList.add('hidden');
  }

  async function loadSession() {
    try {
      const me = await api('/api/me', { guildId: null });
      state.user = me.user || null;
      state.isOwner = me.isOwner === true;
    } catch (e) {
      state.user = null;
      state.isOwner = false;
      if (e.status && e.status !== 401) throw e;
    }
    renderAccount();
    return !!state.user;
  }

  function renderServers() {
    const btn = $('serverSelect');
    btn.querySelector('b').textContent = guildName();
    const initials = guildName().split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
    btn.querySelector('.server-avatar').textContent = initials || 'PG';
    const menu = $('serverMenu');
    menu.innerHTML = state.guilds.length
      ? state.guilds.map((g) => {
          const label = g.botInstalled === 'installed' ? 'Bot installed' : g.botInstalled === 'missing' ? 'Bot not installed' : 'Status unknown';
          return `<button type="button" role="option" data-guild="${esc(g.id)}" aria-selected="${g.id === state.guildId}"><span>${esc(g.name)}</span><small>${esc(label)}</small></button>`;
        }).join('')
      : '<div class="empty-row"><b>No servers</b><small>You do not manage any server the bot can see.</small></div>';
  }

  async function loadGuilds() {
    const data = await api('/api/guilds', { guildId: null });
    state.guilds = data.guilds || [];
    if (!state.guilds.some((g) => g.id === state.guildId)) {
      const pick = state.guilds.find((g) => g.botInstalled === 'installed') || state.guilds[0];
      state.guildId = pick ? pick.id : null;
    }
    renderServers();
  }

  /* ---------------------------------------------------------------- bot status */

  const BOT_LABEL = { online: 'ONLINE', offline: 'OFFLINE', stale: 'STALE', unknown: 'UNKNOWN' };
  const BOT_CLASS = { online: 'online', offline: 'offline', stale: 'unknown', unknown: 'unknown' };

  function setService(id, status) {
    const n = $(id);
    if (!n) return;
    const s = String(status || 'unknown').toLowerCase();
    n.textContent = s === 'online' ? 'ONLINE' : s === 'error' || s === 'offline' ? 'ERROR' : 'UNKNOWN';
    n.classList.toggle('ok', s === 'online');
    n.classList.toggle('error', s === 'error' || s === 'offline');
  }

  function renderBot(bot = {}) {
    const s = bot.status || 'unknown';
    for (const id of ['botStatusBadge', 'botDetailBadge']) {
      const n = $(id);
      if (n) { n.className = `status-badge ${BOT_CLASS[s] || 'unknown'}`; n.innerHTML = `<i></i> ${BOT_LABEL[s] || 'UNKNOWN'}`; }
    }
    const name = bot.botName || 'ProGuard Bot';
    setText('botDisplayName', name);
    setText('botDetailName', name);
    setText('botActivity', s === 'online' ? 'Connected and reporting'
      : s === 'stale' ? 'Heartbeat is stale; the bot may be offline'
      : s === 'offline' ? 'Bot reports itself offline'
      : 'Waiting for the bot to report in');
    setText('botLastSeen', relative(bot.lastHeartbeat));
    setText('botDetailSeen', bot.lastHeartbeat ? `Last heartbeat ${relative(bot.lastHeartbeat)}` : 'No heartbeat received');
    setText('botLatency', hasNum(bot.latencyMs) ? `${bot.latencyMs} ms` : '—');
    setText('botGuilds', hasNum(bot.guildCount) ? bot.guildCount : '—');
    setText('botVersion', bot.version || '—');
    setText('detailProcessState', BOT_LABEL[s] || 'UNKNOWN');
    setText('detailLatency', hasNum(bot.latencyMs) ? `${bot.latencyMs} ms` : '—');
    setText('detailHeartbeat', bot.lastHeartbeat ? dateText(bot.lastHeartbeat) : '—');
    setText('protectionText', s === 'online' ? 'Bot reporting healthy'
      : s === 'stale' ? 'Bot heartbeat is stale'
      : s === 'offline' ? 'Bot reports offline'
      : 'Status unavailable');
    $('protectionPip').classList.toggle('online', s === 'online');
    setService('runtimeServiceStatus', s === 'online' ? 'online' : (s === 'stale' || s === 'offline') ? 'offline' : 'unknown');
  }

  async function loadBot() {
    const data = await api('/api/bot/status');
    renderBot(data.bot || {});
    state.guildInstalled = (data.guild || {}).installed;
    return data;
  }

  /* ---------------------------------------------------------------- charts & tables */

  function renderChart(containerId, axisId, points) {
    const container = $(containerId);
    const axis = $(axisId);
    if (!container || !axis) return;
    if (!Array.isArray(points) || !points.length || points.every((p) => !p.events && !p.resolved)) {
      container.innerHTML = '<div class="chart-empty"><span class="chart-empty-icon">⌁</span><b>No activity in this period</b><small>Events appear here once the bot records them.</small></div>';
      axis.innerHTML = '<span>—</span><span>—</span><span>—</span><span>—</span><span>—</span><span>—</span><span>—</span>';
      return;
    }
    const width = 700, height = 200, pad = { l: 8, r: 8, t: 14, b: 12 };
    const innerW = width - pad.l - pad.r, innerH = height - pad.t - pad.b;
    const events = points.map((p) => Number(p.events) || 0);
    const resolved = points.map((p) => Number(p.resolved) || 0);
    const max = Math.max(1, ...events, ...resolved);
    const x = (i) => pad.l + (points.length === 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
    const y = (v) => pad.t + innerH - (v / max) * innerH;
    const path = (values) => values.map((v, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
    const area = `${path(events)} L ${x(points.length - 1)} ${height - pad.b} L ${x(0)} ${height - pad.b} Z`;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => `<line x1="${pad.l}" y1="${(pad.t + innerH * t).toFixed(1)}" x2="${width - pad.r}" y2="${(pad.t + innerH * t).toFixed(1)}" stroke="#16233a" stroke-dasharray="3 5"/>`).join('');
    const dots = events.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="#5ee6ff" stroke="#04060c" stroke-width="1.5"/>`).join('');
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Security activity chart"><defs><linearGradient id="chartArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#2ea8ff" stop-opacity=".28"/><stop offset="100%" stop-color="#2ea8ff" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${area}" fill="url(#chartArea)"/><path d="${path(resolved)}" fill="none" stroke="#3ddc97" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/><path d="${path(events)}" fill="none" stroke="#5ee6ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>${dots}</svg>`;
    const labels = points.map((p) => {
      const d = new Date(p.label);
      return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    });
    const n = points.length - 1;
    const idx = [0, Math.round(n / 5), Math.round((2 * n) / 5), Math.round((3 * n) / 5), Math.round((4 * n) / 5), n];
    axis.innerHTML = idx.map((i) => `<span>${esc(labels[i] || '—')}</span>`).join('');
  }

  function priorityClass(p) { const s = String(p || 'medium').toLowerCase(); return ['critical', 'high', 'medium', 'low'].includes(s) ? `priority-${s}` : 'priority-medium'; }
  function stateClass(s) { const v = String(s || 'open').toLowerCase(); return ['open', 'reviewing', 'resolved', 'dismissed', 'investigating', 'recorded'].includes(v) ? v : 'open'; }
  function statusPill(status) { const s = String(status || 'open').toLowerCase(); return `<span class="state-pill ${stateClass(s)}">${esc(s.replace(/[_-]/g, ' '))}</span>`; }

  function renderLatestReports() {
    const rows = state.reports.filter((r) => !['resolved', 'dismissed'].includes(r.status)).slice(0, 5);
    setText('reportNavCount', state.reports.filter((r) => ['open', 'reviewing'].includes(r.status)).length || '0');
    $('latestReportsBody').innerHTML = rows.length
      ? rows.map((r) => `<tr><td><span class="report-id">#${esc(r.id)}</span></td><td class="reason-cell">${esc(r.reason)}</td><td><span class="priority-pill ${priorityClass(r.priority)}">${esc(r.priority)}</span></td><td>${statusPill(r.status)}</td><td><button class="row-action" data-report-open="${esc(r.id)}" aria-label="Open report" type="button">↗</button></td></tr>`).join('')
      : '<tr><td colspan="5"><div class="empty-row"><span>✓</span><b>No open reports</b><small>New reports from /report appear here.</small></div></td></tr>';
  }

  function renderReports() {
    const q = ($('reportSearch')?.value || '').toLowerCase().trim();
    const sf = $('reportStatusFilter')?.value || 'all';
    const pf = $('reportPriorityFilter')?.value || 'all';
    const rows = state.reports.filter((r) => {
      const text = [r.id, r.reporter, r.reportedUser, r.reason].join(' ').toLowerCase();
      return (!q || text.includes(q)) && (sf === 'all' || r.status === sf) && (pf === 'all' || r.priority === pf);
    });
    setText('allReportsCount', rows.length);
    setText('reportTableMeta', `${rows.length} record${rows.length === 1 ? '' : 's'}`);
    $('allReportsBody').innerHTML = rows.length
      ? rows.map((r) => `<tr><td><span class="report-id">#${esc(r.id)}</span></td><td>${esc(r.reporter)}</td><td class="reason-cell" title="${esc(r.reason)}">${esc(r.reason)}</td><td><span class="priority-pill ${priorityClass(r.priority)}">${esc(r.priority)}</span></td><td>${statusPill(r.status)}</td><td>${esc(dateText(r.createdAt))}</td><td><button class="row-action" data-report-open="${esc(r.id)}" aria-label="Review report" type="button">↗</button></td></tr>`).join('')
      : '<tr><td colspan="7"><div class="empty-row"><span>⌁</span><b>No matching reports</b><small>Try a different search or filter.</small></div></td></tr>';
  }

  function renderCases() {
    const filter = $('caseStatusFilter')?.value || 'all';
    const rows = state.cases.filter((c) => filter === 'all' || c.status === filter);
    const count = (s) => state.cases.filter((c) => c.status === s).length;
    setText('activeCasesMetric', count('open') + count('investigating'));
    setText('resolvedCasesMetric', count('resolved'));
    setText('dismissedCasesMetric', count('dismissed'));
    $('casesBody').innerHTML = rows.length
      ? rows.map((c) => `<tr><td><span class="report-id">#${esc(c.id)}</span></td><td>${esc(c.subject)}</td><td>${esc(c.action)}</td><td>${statusPill(c.status)}</td><td>${esc(c.assignedTo)}</td><td>${esc(dateText(c.updatedAt))}</td><td><button class="row-action" data-case-open="${esc(c.id)}" aria-label="Open case" type="button">↗</button></td></tr>`).join('')
      : '<tr><td colspan="7"><div class="empty-row"><span>⌁</span><b>No cases</b><small>Cases appear when moderators warn, mute, kick or ban someone.</small></div></td></tr>';
  }

  function renderBreakdown(entries) {
    const node = $('reportBreakdown');
    if (!entries || !entries.length) {
      node.innerHTML = '<div class="empty-row"><b>No category data</b><small>No moderation events in this period.</small></div>';
      return;
    }
    const max = Math.max(1, ...entries.map((e) => e.count));
    node.innerHTML = entries.map((e) => `<div class="module-row"><span class="module-symbol">▣</span><span><b>${esc(e.label)}</b><small>${fmt(e.count)} event${e.count === 1 ? '' : 's'}</small></span><span class="module-state">${Math.round((e.count / max) * 100)}%</span></div>`).join('');
  }

  /* ---------------------------------------------------------------- data loaders */

  async function loadOverview() {
    const range = $('activityRange').value;
    const data = await api('/api/overview', { query: { range } });
    const m = data.metrics || {};
    setText('metricOpenReports', fmt(m.openReports));
    setText('metricResolved', fmt(m.resolvedCases));
    setText('metricEvents', fmt(m.securityEvents));
    setText('metricUptime', BOT_LABEL[(data.bot || {}).status] || 'UNKNOWN');
    setText('openReportsNote', m.openReports ? 'Waiting for review' : 'Nothing waiting');
    setText('resolvedNote', 'All time');
    setText('eventsNote', `Last ${range === '24h' ? '24 hours' : range === '30d' ? '30 days' : '7 days'}`);
    setText('uptimeNote', (data.bot || {}).lastHeartbeat ? `Heartbeat ${relative(data.bot.lastHeartbeat)}` : 'Waiting for bot heartbeat');
    const top = Math.max(1, m.openReports || 0, m.resolvedCases || 0, m.securityEvents || 0);
    setWidth('openTrack', ((m.openReports || 0) / top) * 100);
    setWidth('resolvedTrack', ((m.resolvedCases || 0) / top) * 100);
    setWidth('eventsTrack', ((m.securityEvents || 0) / top) * 100);
    setWidth('uptimeTrack', 0);
    renderChart('activityChart', 'chartAxis', data.activity || []);
    if (data.services) {
      setService('firebaseServiceStatus', data.services.firebase);
      setService('discordServiceStatus', data.services.discord);
    }
    renderBot(data.bot || {});
  }

  async function loadReports() {
    const data = await api('/api/reports', { query: { status: 'all' } });
    state.reports = data.items || [];
    renderLatestReports();
    renderReports();
  }

  async function loadCases() {
    const data = await api('/api/cases');
    state.cases = data.items || [];
    renderCases();
  }

  async function loadAnalytics() {
    const range = $('analyticsRange').value;
    const data = await api('/api/analytics', { query: { range } });
    const m = data.metrics || {};
    setText('analyticsTotalEvents', fmt(m.totalEvents));
    setText('analyticsReports', fmt(m.reportsReceived));
    setText('analyticsResolution', m.resolutionRate == null ? '—' : `${m.resolutionRate}%`);
    setText('analyticsResponse', m.averageResponseTime || '—');
    renderChart('analyticsChart', 'analyticsAxis', data.activity || []);
    renderBreakdown(data.breakdown || []);
  }

  async function loadSettings() {
    const data = await api('/api/settings');
    const s = data.settings || {};
    const installed = data.installed === true;
    const options = (data.channels || []).map((c) => `<option value="${esc(c.id)}">#${esc(c.name)}</option>`).join('');
    for (const [id, value] of [['logChannelSelect', s.logChannelId], ['reportChannelSelect', s.reportChannelId]]) {
      const sel = $(id);
      sel.innerHTML = `<option value="">Not set</option>${options}`;
      sel.value = value || '';
      sel.disabled = !installed;
    }
    setText('blockedWordCount', s.blockedWordCount ?? 0);
    $('toggleAutomod').textContent = s.automodEnabled ? 'Turn automod off' : 'Turn automod on';
    $('toggleAutomod').disabled = !installed;
    $('sendTestMessage').disabled = !installed;
    $('settingsGate').classList.toggle('hidden', installed);
    state.settings = s;
    const states = [s.reportChannelId ? 'ACTIVE' : 'NOT SET', s.logChannelId ? 'ACTIVE' : 'NOT SET', 'AVAILABLE'];
    document.querySelectorAll('#moduleList .module-state').forEach((n, i) => { n.textContent = states[i] || '—'; });
  }

  async function loadAudit() {
    const data = await api('/api/admin/audit', { guildId: null });
    state.audit = data.items || [];
    $('auditList').innerHTML = state.audit.length
      ? state.audit.map((a) => `<div class="module-row"><span class="module-symbol">⌁</span><span><b>${esc(a.action)}</b><small>${esc(a.actorName || a.actorId || 'System')} · ${esc(dateText(a.timestamp))}${a.guildId ? ` · server ${esc(a.guildId)}` : ''}</small></span></div>`).join('')
      : '<div class="empty-row"><b>No audit entries yet</b><small>Sign-ins and changes appear here.</small></div>';
  }

  /* ---------------------------------------------------------------- refresh */

  async function refreshAll() {
    if (state.loading) return;
    state.loading = true;
    $('refreshButton').classList.add('spinning');
    try {
      await checkWorker();
      const signedIn = await loadSession();
      if (!signedIn) {
        showError('Sign in with Discord to see live data. Only the owner account can open this dashboard.');
        setText('footerStatus', 'Sign-in required');
        return;
      }
      await loadGuilds();
      if (!state.guildId) {
        showError('No server you manage is visible to the bot. Add the bot to a server you own or manage.');
        setText('footerStatus', 'No server');
        return;
      }
      const jobs = await Promise.allSettled([loadOverview(), loadReports(), loadCases(), loadBot(), loadSettings(), loadAnalytics()]);
      const failed = jobs.filter((j) => j.status === 'rejected');
      if (failed.length) {
        const first = failed[0].reason;
        showError(first && first.message ? first.message : 'Some live data could not be loaded.');
        setText('footerStatus', 'Partial data');
      } else {
        hideError();
        setText('footerStatus', 'API responding');
      }
    } catch (e) {
      if (e.status === 401) {
        showError('Your session expired. Sign in with Discord again.');
        setText('footerStatus', 'Sign-in required');
      } else {
        showError(e.message || 'The dashboard could not reach the API.');
        setText('footerStatus', 'Connection problem');
        setService('workerServiceStatus', 'error');
      }
    } finally {
      state.loading = false;
      $('refreshButton').classList.remove('spinning');
    }
  }

  /* ---------------------------------------------------------------- modals */

  function openReport(id) {
    const r = state.reports.find((x) => x.id === id);
    if (!r) return;
    state.modal = { type: 'report', id };
    $('reportModalTitle').textContent = `Report #${r.id}`;
    $('reportModalContent').innerHTML = `
      <div class="modal-field"><label>REPORTED</label><p>${esc(r.reportedUser)}</p></div>
      <div class="modal-field"><label>SUBMITTED BY</label><p>${esc(r.reporter)}</p></div>
      <div class="modal-field"><label>DESCRIPTION</label><p>${esc(r.description || 'No description supplied.')}</p></div>
      <div class="modal-field"><label>CURRENT STATUS</label><p>${esc(r.status)}${r.reviewedBy ? ` · last reviewed ${esc(dateText(r.reviewedAt))}` : ''}</p></div>
      <div class="modal-field"><label>PRIORITY</label><select id="modalPriority">${['low', 'medium', 'high', 'critical'].map((p) => `<option value="${p}" ${r.priority === p ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></div>
      <div class="modal-field"><label>REVIEW NOTES</label><textarea id="modalNotes" maxlength="2000" placeholder="Record the decision and context…">${esc(r.reviewNotes)}</textarea></div>`;
    $('reportModalActions').innerHTML = `<button class="button button-quiet" data-close-modal type="button">Cancel</button><button class="button button-secondary" data-report-action="reviewing" type="button">Mark reviewing</button><button class="button button-secondary" data-report-action="dismissed" type="button">Dismiss</button><button class="button button-primary" data-report-action="resolved" type="button">Resolve report</button>`;
    $('reportModal').classList.remove('hidden');
  }

  function openCase(id) {
    const c = state.cases.find((x) => x.id === id);
    if (!c) return;
    state.modal = { type: 'case', id };
    $('reportModalTitle').textContent = `Case #${c.id}`;
    const opts = ['open', 'investigating', 'resolved', 'dismissed'];
    $('reportModalContent').innerHTML = `
      <div class="modal-field"><label>SUBJECT</label><p>${esc(c.subject)}</p></div>
      <div class="modal-field"><label>ACTION</label><p>${esc(c.action)} · ${esc(c.reason || 'No reason recorded')}</p></div>
      <div class="modal-field"><label>STATUS</label><select id="caseStatus">${opts.map((o) => `<option value="${o}" ${c.status === o ? 'selected' : ''}>${o[0].toUpperCase() + o.slice(1)}</option>`).join('')}</select></div>
      <div class="modal-field"><label>CASE NOTES</label><textarea id="caseNotes" maxlength="2000" placeholder="Investigation notes…">${esc(c.notes)}</textarea></div>`;
    $('reportModalActions').innerHTML = `<button class="button button-quiet" data-close-modal type="button">Cancel</button><button class="button button-primary" data-case-save type="button">Save case</button>`;
    $('reportModal').classList.remove('hidden');
  }

  async function reportAction(action) {
    const id = state.modal?.id;
    if (!id) return;
    try {
      await api(`/api/reports/${encodeURIComponent(id)}/action`, {
        method: 'POST',
        body: { action, status: action, priority: $('modalPriority')?.value, notes: $('modalNotes')?.value || '' },
      });
      $('reportModal').classList.add('hidden');
      toast('Report updated', `Report #${id} is now ${action}.`);
      await loadReports();
    } catch (e) {
      toast('Report not updated', e.message, 'error');
    }
  }

  async function saveCase() {
    const id = state.modal?.id;
    if (!id) return;
    try {
      await api(`/api/cases/${encodeURIComponent(id)}/action`, {
        method: 'POST',
        body: { action: 'update', status: $('caseStatus').value, notes: $('caseNotes').value },
      });
      $('reportModal').classList.add('hidden');
      toast('Case saved', `Case #${id} was updated.`);
      await loadCases();
    } catch (e) {
      toast('Case not saved', e.message, 'error');
    }
  }

  function closeModal() { $('reportModal').classList.add('hidden'); state.modal = null; }

  /* ---------------------------------------------------------------- settings actions */

  async function saveChannel(kind) {
    const sel = $(kind === 'log' ? 'logChannelSelect' : 'reportChannelSelect');
    try {
      await api('/api/settings', {
        method: 'POST',
        body: { action: kind === 'log' ? 'set_log_channel' : 'set_report_channel', channelId: sel.value || null },
      });
      toast('Saved', kind === 'log' ? 'Log channel updated.' : 'Report channel updated.');
      await loadSettings();
    } catch (e) {
      toast('Not saved', e.message, 'error');
    }
  }

  async function toggleAutomod() {
    const next = !state.settings?.automodEnabled;
    try {
      await api('/api/settings', { method: 'POST', body: { action: 'set_automod', enabled: next } });
      toast('Saved', `Automod ${next ? 'enabled' : 'disabled'}.`);
      await loadSettings();
    } catch (e) {
      toast('Not saved', e.message, 'error');
    }
  }

  async function sendTestMessage() {
    const out = $('commandResult');
    out.textContent = 'Queued. Waiting for the bot…';
    try {
      const queued = await api('/api/bot/command', { method: 'POST', body: { type: 'send_test_message' } });
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const s = await api(`/api/bot/command/${encodeURIComponent(queued.id)}`);
        if (s.status === 'done') { out.textContent = 'Done: the test message was posted in the log channel.'; return; }
        if (s.status === 'failed') { out.textContent = `Failed: ${s.error || 'unknown error'}.`; return; }
      }
      out.textContent = 'The bot has not answered yet. Check that it is online.';
    } catch (e) {
      out.textContent = `Not sent: ${e.message}`;
    }
  }

  /* ---------------------------------------------------------------- navigation & auth */

  const PAGE_NAMES = { overview: 'Overview', reports: 'Reports', cases: 'Cases', analytics: 'Analytics', bot: 'Bot status', settings: 'Server settings', admin: 'Owner controls' };

  function go(page) {
    if (!PAGE_NAMES[page]) return;
    if (page === 'admin' && !state.isOwner) {
      toast('Owner account required', 'This area is only for the owner account.', 'error');
      return;
    }
    document.querySelectorAll('.page-view').forEach((v) => v.classList.toggle('active', v.dataset.view === page));
    document.querySelectorAll('.nav-link[data-page]').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
    setText('breadcrumbCurrent', PAGE_NAMES[page]);
    history.replaceState(null, '', `#${page}`);
    $('sidebar').classList.remove('open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (page === 'admin') loadAudit().catch((e) => toast('Audit log unavailable', e.message, 'error'));
  }

  function signIn() { window.location.href = '/auth/discord'; }

  function toggleAccountMenu(force) {
    const menu = $('accountMenu');
    const show = force ?? menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !show);
    $('topLoginButton').setAttribute('aria-expanded', String(show));
  }

  async function signOut() {
    try { await api('/auth/logout', { method: 'POST', guildId: null }); } catch { /* clear local state regardless */ }
    state.user = null;
    state.isOwner = false;
    state.guilds = [];
    state.guildId = null;
    state.reports = [];
    state.cases = [];
    renderAccount();
    renderServers();
    toast('Signed out', 'Your session has ended.');
    go('overview');
    refreshAll();
  }

  function onAccountButton() {
    if (state.user) toggleAccountMenu();
    else signIn();
  }

  function bind() {
    document.querySelectorAll('.nav-link[data-page]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.page); }));
    document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
    $('menuButton').addEventListener('click', () => $('sidebar').classList.toggle('open'));
    $('refreshButton').addEventListener('click', refreshAll);
    $('bannerRetry').addEventListener('click', refreshAll);
    $('reviewReportsButton').addEventListener('click', () => go('reports'));
    $('reportsRefresh').addEventListener('click', () => loadReports().catch((e) => toast('Reports unavailable', e.message, 'error')));
    $('casesRefresh').addEventListener('click', () => loadCases().catch((e) => toast('Cases unavailable', e.message, 'error')));
    $('botRefresh').addEventListener('click', () => loadBot().catch((e) => toast('Status unavailable', e.message, 'error')));
    $('auditRefresh').addEventListener('click', () => loadAudit().catch((e) => toast('Audit unavailable', e.message, 'error')));
    $('settingsRefresh').addEventListener('click', () => loadSettings().catch((e) => toast('Settings unavailable', e.message, 'error')));
    $('reportSearch').addEventListener('input', renderReports);
    $('reportStatusFilter').addEventListener('change', renderReports);
    $('reportPriorityFilter').addEventListener('change', renderReports);
    $('caseStatusFilter').addEventListener('change', renderCases);
    $('clearReportFilters').addEventListener('click', () => {
      $('reportSearch').value = '';
      $('reportStatusFilter').value = 'all';
      $('reportPriorityFilter').value = 'all';
      renderReports();
    });
    $('activityRange').addEventListener('change', () => loadOverview().catch((e) => toast('Chart unavailable', e.message, 'error')));
    $('analyticsRange').addEventListener('change', () => loadAnalytics().catch((e) => toast('Analytics unavailable', e.message, 'error')));
    $('loginButton').addEventListener('click', onAccountButton);
    $('topLoginButton').addEventListener('click', onAccountButton);
    $('signOutButton').addEventListener('click', signOut);
    $('serverSelect').addEventListener('click', () => $('serverMenu').classList.toggle('hidden'));
    $('saveLogChannel').addEventListener('click', () => saveChannel('log'));
    $('saveReportChannel').addEventListener('click', () => saveChannel('report'));
    $('toggleAutomod').addEventListener('click', toggleAutomod);
    $('sendTestMessage').addEventListener('click', sendTestMessage);

    document.addEventListener('click', (e) => {
      const srv = e.target.closest('#serverMenu [data-guild]');
      if (srv) {
        state.guildId = srv.dataset.guild;
        $('serverMenu').classList.add('hidden');
        renderServers();
        refreshAll();
        return;
      }
      const report = e.target.closest('[data-report-open]');
      if (report) openReport(report.dataset.reportOpen);
      const cs = e.target.closest('[data-case-open]');
      if (cs) openCase(cs.dataset.caseOpen);
      const ra = e.target.closest('[data-report-action]');
      if (ra) reportAction(ra.dataset.reportAction);
      if (e.target.closest('[data-case-save]')) saveCase();
      if (e.target.closest('[data-close-modal]') || e.target === $('reportModal')) closeModal();
      if (!e.target.closest('#serverSelect') && !e.target.closest('#serverMenu')) $('serverMenu').classList.add('hidden');
      if (!e.target.closest('#topLoginButton') && !e.target.closest('#accountMenu')) toggleAccountMenu(false);
    });

    window.addEventListener('hashchange', () => {
      const page = location.hash.slice(1);
      if ($(`page-${page}`)) go(page);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
        $('sidebar').classList.remove('open');
        $('serverMenu').classList.add('hidden');
        toggleAccountMenu(false);
      }
    });
  }

  function init() {
    setText('currentDate', new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }));
    setText('footerYear', new Date().getFullYear());
    bind();
    const params = new URLSearchParams(location.search);
    if (params.get('access') === 'denied') {
      toast('Access denied', 'Only the owner account can open this dashboard.', 'error');
      history.replaceState(null, '', location.pathname + location.hash);
    }
    if (params.get('login') === 'cancelled') {
      toast('Sign-in cancelled', 'No changes were made.', 'error');
      history.replaceState(null, '', location.pathname + location.hash);
    }
    const initial = location.hash.slice(1);
    if (initial && $(`page-${initial}`)) go(initial);
    refreshAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
