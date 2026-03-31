const KEY_STORAGE = 'rss-dashboard-api-key';

const state = {
  tabs: ['overview', 'feeds', 'rules-alerts', 'entries', 'opml'],
  activeTab: 'overview',
  entriesPage: 1,
  feedsPage: 1,
  rulesPage: 1,
  alertsPage: 1,
  opmlPreviewPage: 1,
  capabilities: {
    feedDelete: true,
    ruleDelete: true,
    opml: true,
  },
};

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function getById(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`dashboard_missing_element:${id}`);
  }
  return node;
}

function getApiKey() {
  return (localStorage.getItem(KEY_STORAGE) || '').trim();
}

function setApiKey(value) {
  localStorage.setItem(KEY_STORAGE, value.trim());
}

function toIsoOrUndefined(value) {
  if (!value) return undefined;
  return new Date(value).toISOString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function parseKeywords(value) {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function setFeedback(id, text, tone = 'info') {
  const node = getById(id);
  node.textContent = text;
  node.dataset.tone = tone;
}

function requireApiKey() {
  const key = getApiKey();
  if (!key) {
    throw new Error('missing_api_key');
  }
  return key;
}

function buildHeaders(extra = {}) {
  const apiKey = getApiKey();
  const headers = {
    ...extra,
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }

  return headers;
}

async function apiRaw(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: buildHeaders(options.headers || {}),
  });

  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof body === 'object' ? body.message || body.error || response.statusText : response.statusText;
    throw new ApiError(String(message), response.status, body);
  }

  return body;
}

async function api(path, options = {}) {
  return apiRaw(path, options);
}

function switchTab(tabId) {
  state.activeTab = tabId;
  for (const tab of state.tabs) {
    const panel = getById(`tab-${tab}`);
    const button = getById(`tab-btn-${tab}`);
    const isActive = tab === tabId;
    panel.hidden = !isActive;
    button.classList.toggle('active', isActive);
  }
}

function renderSummary(summary) {
  const root = getById('summary');
  const cards = [
    ['Feeds total', summary.feedsTotal],
    ['Feeds activos', summary.feedsActive],
    ['Feeds error', summary.feedsError],
    ['Entries 24h', summary.entries24h],
    ['Entries 7d', summary.entries7d],
    ['Alerts pendientes', summary.alertsPending],
  ];

  root.innerHTML = cards
    .map(([label, value]) => `<article class="kpi"><div class="label">${label}</div><div class="value">${value}</div></article>`)
    .join('');
}

function updatePager(baseId, page, hasNext) {
  getById(`${baseId}-page`).textContent = String(page);
  getById(`${baseId}-prev`).disabled = page <= 1;
  getById(`${baseId}-next`).disabled = !hasNext;
}

function renderEntries(payload) {
  const tbody = getById('entries-body');
  const meta = getById('entries-meta');
  const items = payload.data || [];
  const total = payload.meta?.total ?? 0;
  const page = payload.meta?.page ?? state.entriesPage;
  const hasNext = Boolean(payload.meta?.has_next);

  meta.textContent = `${items.length} resultados mostrados (total: ${total}).`;
  meta.dataset.tone = 'info';
  updatePager('entries', page, hasNext);

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="4">Sin resultados</td></tr>';
    return;
  }

  tbody.innerHTML = items
    .map((entry) => {
      const title = escapeHtml(entry.title || '(sin título)');
      const link = entry.link
        ? `<a href="${escapeHtml(entry.link)}" target="_blank" rel="noreferrer">abrir</a>`
        : '-';
      return `
        <tr>
          <td>${escapeHtml(formatDate(entry.publishedAt || entry.fetchedAt))}</td>
          <td>${title}</td>
          <td>${escapeHtml(entry.feedId)}</td>
          <td>${link}</td>
        </tr>
      `;
    })
    .join('');
}

function renderFeeds(payload) {
  const tbody = getById('feeds-body');
  const meta = getById('feeds-meta');
  const items = payload.data || [];
  const total = payload.meta?.total ?? 0;
  const page = payload.meta?.page ?? state.feedsPage;
  const hasNext = Boolean(payload.meta?.has_next);

  meta.textContent = `${items.length} feeds mostrados (total: ${total}).`;
  meta.dataset.tone = 'info';
  updatePager('feeds', page, hasNext);

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="5">Sin feeds</td></tr>';
    return;
  }

  tbody.innerHTML = items
    .map((feed) => {
      const nextStatus = feed.status === 'paused' ? 'active' : 'paused';
      const toggleLabel = feed.status === 'paused' ? 'Resume' : 'Pause';
      const deleteDisabled = state.capabilities.feedDelete ? '' : 'disabled';
      return `
        <tr>
          <td>${feed.id}</td>
          <td><a href="${escapeHtml(feed.url)}" target="_blank" rel="noreferrer">${escapeHtml(feed.url)}</a></td>
          <td>${escapeHtml(feed.status)}</td>
          <td>${escapeHtml(formatDate(feed.nextCheckAt))}</td>
          <td>
            <button type="button" data-feed-action="check" data-feed-id="${feed.id}">Check now</button>
            <button type="button" data-feed-action="toggle" data-feed-id="${feed.id}" data-feed-status="${nextStatus}">${toggleLabel}</button>
            <button type="button" data-feed-action="delete" data-feed-id="${feed.id}" ${deleteDisabled}>Disable</button>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderRules(payload) {
  const tbody = getById('rules-body');
  const meta = getById('rules-meta');
  const items = payload.data || [];
  const total = payload.meta?.total ?? 0;
  const page = payload.meta?.page ?? state.rulesPage;
  const hasNext = Boolean(payload.meta?.has_next);

  meta.textContent = `${items.length} reglas mostradas (total: ${total}).`;
  meta.dataset.tone = 'info';
  updatePager('rules', page, hasNext);

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="5">Sin reglas</td></tr>';
    return;
  }

  tbody.innerHTML = items
    .map((rule) => {
      const deleteDisabled = state.capabilities.ruleDelete ? '' : 'disabled';
      return `
        <tr>
          <td>${rule.id}</td>
          <td>${escapeHtml(rule.name)}</td>
          <td>${escapeHtml(rule.includeKeywords.join(', '))}</td>
          <td>${rule.isActive ? 'sí' : 'no'}</td>
          <td><button type="button" data-rule-action="delete" data-rule-id="${rule.id}" ${deleteDisabled}>Disable</button></td>
        </tr>
      `;
    })
    .join('');
}

function renderAlerts(payload) {
  const tbody = getById('alerts-body');
  const meta = getById('alerts-meta');
  const items = payload.data || [];
  const total = payload.meta?.total ?? 0;
  const page = payload.meta?.page ?? state.alertsPage;
  const hasNext = Boolean(payload.meta?.has_next);

  meta.textContent = `${items.length} alerts mostradas (total: ${total}).`;
  meta.dataset.tone = 'info';
  updatePager('alerts', page, hasNext);

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="5">Sin alerts</td></tr>';
    return;
  }

  tbody.innerHTML = items
    .map((alert) => {
      const title = escapeHtml(alert.entry?.title || '(sin título)');
      const ruleName = escapeHtml(alert.rule?.name || '-');
      const canSend = alert.deliveryStatus !== 'disabled';
      return `
        <tr>
          <td>${alert.id}</td>
          <td>${escapeHtml(alert.deliveryStatus)}</td>
          <td>${ruleName}</td>
          <td>${title}</td>
          <td><button type="button" data-alert-action="send" data-alert-id="${alert.id}" ${canSend ? '' : 'disabled'}>Reenviar</button></td>
        </tr>
      `;
    })
    .join('');
}

function renderOpmlPreview(payload) {
  const tbody = getById('opml-preview-body');
  const meta = getById('opml-preview-meta');
  const items = payload.data || [];
  const total = payload.meta?.total ?? 0;
  const page = payload.meta?.page ?? state.opmlPreviewPage;
  const hasNext = Boolean(payload.meta?.has_next);
  const summary = payload.summary || {};

  meta.textContent = `Preview: ${items.length} items (total: ${total}) | status=${summary.status || '-'} total=${summary.totalItems ?? '-'} duplicate=${summary.duplicateItems ?? '-'} invalid=${summary.invalidItems ?? '-'} imported=${summary.importedItems ?? '-'}`;
  meta.dataset.tone = 'info';
  updatePager('opml-preview', page, hasNext);

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="5">Sin items</td></tr>';
    return;
  }

  tbody.innerHTML = items
    .map((item) => {
      return `
        <tr>
          <td>${item.id}</td>
          <td>${escapeHtml(item.title || '-')}</td>
          <td>${item.normalizedUrl ? `<a href="${escapeHtml(item.normalizedUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.normalizedUrl)}</a>` : '-'}</td>
          <td>${escapeHtml(item.itemStatus)}</td>
          <td>${escapeHtml(item.validationError || '-')}</td>
        </tr>
      `;
    })
    .join('');
}

function buildEntriesParams() {
  const from = toIsoOrUndefined(getById('from').value);
  const to = toIsoOrUndefined(getById('to').value);
  const search = getById('search').value.trim();
  const pageSize = Number(getById('page-size').value || 50);

  const params = new URLSearchParams({ page: String(state.entriesPage), page_size: String(pageSize) });
  if (search) params.set('search', search);
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  return params;
}

async function loadOverview() {
  try {
    requireApiKey();
    const [summary, health, ready] = await Promise.all([
      api('/api/v1/ops/summary'),
      api('/health'),
      api('/ready').catch((error) => ({ status: 'error', checks: error.body?.checks })),
    ]);
    renderSummary(summary.data || {});
    getById('health-live').textContent = health.status || '-';
    getById('health-ready').textContent = ready.status || 'error';
    setFeedback('overview-feedback', 'Overview actualizada.', 'success');
  } catch (error) {
    setFeedback('overview-feedback', `Error overview: ${error.message}`, 'error');
  }
}

async function searchEntries() {
  try {
    requireApiKey();
    const params = buildEntriesParams();
    const payload = await api(`/api/v1/entries?${params.toString()}`);
    renderEntries(payload);
  } catch (error) {
    setFeedback('entries-meta', `Error entries: ${error.message}`, 'error');
  }
}

async function loadFeeds() {
  try {
    requireApiKey();
    const status = getById('feeds-filter-status').value;
    const q = getById('feeds-filter-q').value.trim();
    const pageSize = Number(getById('feeds-page-size').value || 25);
    const params = new URLSearchParams({ page: String(state.feedsPage), page_size: String(pageSize) });
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    const payload = await api(`/api/v1/feeds?${params.toString()}`);
    renderFeeds(payload);
    setFeedback('feeds-feedback', 'Feeds actualizados.', 'success');
  } catch (error) {
    setFeedback('feeds-feedback', `Error feeds: ${error.message}`, 'error');
  }
}

async function loadRules() {
  try {
    requireApiKey();
    const pageSize = Number(getById('rules-page-size').value || 25);
    const params = new URLSearchParams({ page: String(state.rulesPage), page_size: String(pageSize) });
    const payload = await api(`/api/v1/rules?${params.toString()}`);
    renderRules(payload);
    setFeedback('rules-feedback', 'Reglas actualizadas.', 'success');
  } catch (error) {
    setFeedback('rules-feedback', `Error rules: ${error.message}`, 'error');
  }
}

async function loadAlerts() {
  try {
    requireApiKey();
    const sent = getById('alerts-sent').value;
    const pageSize = Number(getById('alerts-page-size').value || 25);
    const params = new URLSearchParams({ page: String(state.alertsPage), page_size: String(pageSize) });
    if (sent === 'true' || sent === 'false') {
      params.set('sent', sent);
    }
    const payload = await api(`/api/v1/alerts?${params.toString()}`);
    renderAlerts(payload);
    setFeedback('alerts-feedback', 'Alerts actualizadas.', 'success');
  } catch (error) {
    setFeedback('alerts-feedback', `Error alerts: ${error.message}`, 'error');
  }
}

function getOpmlImportId() {
  const value = Number(getById('opml-import-id').value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('opml_import_id_required');
  }
  return value;
}

async function loadOpmlPreview() {
  try {
    requireApiKey();
    if (!state.capabilities.opml) {
      setFeedback('opml-feedback', 'OPML no está disponible en este backend.', 'warn');
      return;
    }

    const importId = getOpmlImportId();
    const pageSize = Number(getById('opml-preview-page-size').value || 25);
    const params = new URLSearchParams({ page: String(state.opmlPreviewPage), page_size: String(pageSize) });
    const payload = await api(`/api/v1/opml/imports/${importId}/preview?${params.toString()}`);
    renderOpmlPreview(payload);
  } catch (error) {
    if (error instanceof ApiError && [404, 405, 501].includes(error.status)) {
      state.capabilities.opml = false;
      setFeedback('opml-feedback', 'El backend no soporta OPML import en este entorno.', 'warn');
      return;
    }
    setFeedback('opml-feedback', `Error OPML preview: ${error.message}`, 'error');
  }
}

async function loadOpmlStatus() {
  try {
    requireApiKey();
    const importId = getOpmlImportId();
    const payload = await api(`/api/v1/opml/imports/${importId}/status`);
    const data = payload.data || {};
    setFeedback(
      'opml-status-output',
      `status=${data.status || '-'} progress=${data.progressPercent ?? '-'}% imported=${data.importedItems ?? '-'} failed=${data.failedItems ?? '-'}`,
      'success',
    );
  } catch (error) {
    setFeedback('opml-status-output', `Error OPML status: ${error.message}`, 'error');
  }
}

async function refreshAll() {
  if (!getApiKey()) {
    setFeedback('auth-feedback', 'Ingresa una API key para comenzar.', 'warn');
    return;
  }

  const results = await Promise.allSettled([loadOverview(), searchEntries(), loadFeeds(), loadRules(), loadAlerts()]);
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed > 0) {
    setFeedback('auth-feedback', `Actualización parcial (${failed} fallos).`, 'warn');
    return;
  }
  setFeedback('auth-feedback', 'Datos actualizados.', 'success');
}

async function createFeed(event) {
  event.preventDefault();
  try {
    requireApiKey();
    const payload = {
      url: getById('feed-url').value.trim(),
      poll_interval_seconds: Number(getById('feed-poll-interval').value || 1800),
      status: getById('feed-status').value,
    };
    await api('/api/v1/feeds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setFeedback('feeds-feedback', 'Feed creado.', 'success');
    getById('feed-create-form').reset();
    await loadFeeds();
    await loadOverview();
  } catch (error) {
    setFeedback('feeds-feedback', `Error creando feed: ${error.message}`, 'error');
  }
}

async function createRule(event) {
  event.preventDefault();
  try {
    requireApiKey();
    const includeKeywords = parseKeywords(getById('rule-include').value);
    if (!includeKeywords.length) {
      throw new Error('rule_missing_include_keywords');
    }

    const payload = {
      name: getById('rule-name').value.trim(),
      include_keywords: includeKeywords,
      exclude_keywords: parseKeywords(getById('rule-exclude').value),
      is_active: Boolean(getById('rule-active').checked),
    };

    await api('/api/v1/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    setFeedback('rules-feedback', 'Regla creada.', 'success');
    getById('rule-create-form').reset();
    getById('rule-active').checked = true;
    await loadRules();
  } catch (error) {
    setFeedback('rules-feedback', `Error creando regla: ${error.message}`, 'error');
  }
}

async function uploadOpml(event) {
  event.preventDefault();
  try {
    requireApiKey();
    const input = getById('opml-file');
    const file = input.files?.[0];
    if (!file) {
      throw new Error('opml_file_required');
    }

    const form = new FormData();
    form.append('file', file);

    const payload = await api('/api/v1/opml/imports', {
      method: 'POST',
      body: form,
    });

    getById('opml-import-id').value = payload.data?.id || '';
    setFeedback('opml-feedback', `Import creado: id=${payload.data?.id} status=${payload.data?.status}.`, 'success');
  } catch (error) {
    if (error instanceof ApiError && [404, 405, 501].includes(error.status)) {
      state.capabilities.opml = false;
      setFeedback('opml-feedback', 'El backend no soporta OPML import en este entorno.', 'warn');
      return;
    }
    setFeedback('opml-feedback', `Error subiendo OPML: ${error.message}`, 'error');
  }
}

async function confirmOpml() {
  try {
    requireApiKey();
    const importId = getOpmlImportId();
    const payload = await api(`/api/v1/opml/imports/${importId}/confirm`, { method: 'POST' });
    setFeedback('opml-status-output', `Confirmación enviada: ${payload.data?.status || 'queued'}.`, 'success');
  } catch (error) {
    setFeedback('opml-status-output', `Error confirmando OPML: ${error.message}`, 'error');
  }
}

async function handleFeedsTableAction(event) {
  const button = event.target?.closest?.('button[data-feed-action]');
  if (!button) {
    return;
  }

  const feedId = button.dataset.feedId;
  const action = button.dataset.feedAction;
  if (!feedId || !action) {
    return;
  }

  try {
    requireApiKey();
    if (action === 'check') {
      await api(`/api/v1/feeds/${feedId}/check-now`, { method: 'POST' });
      setFeedback('feeds-feedback', `Feed ${feedId} encolado para check inmediato.`, 'success');
      return;
    }

    if (action === 'toggle') {
      await api(`/api/v1/feeds/${feedId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: button.dataset.feedStatus }),
      });
      setFeedback('feeds-feedback', `Feed ${feedId} actualizado.`, 'success');
      await loadFeeds();
      await loadOverview();
      return;
    }

    if (action === 'delete') {
      if (!state.capabilities.feedDelete) {
        return;
      }
      await api(`/api/v1/feeds/${feedId}`, { method: 'DELETE' });
      setFeedback('feeds-feedback', `Feed ${feedId} deshabilitado.`, 'success');
      await loadFeeds();
      await loadOverview();
    }
  } catch (error) {
    if (error instanceof ApiError && [404, 405, 501].includes(error.status) && action === 'delete') {
      state.capabilities.feedDelete = false;
      setFeedback('feeds-feedback', 'Delete/disable feed no soportado por este backend.', 'warn');
      await loadFeeds();
      return;
    }

    setFeedback('feeds-feedback', `Error en acción de feed: ${error.message}`, 'error');
  }
}

async function handleRulesTableAction(event) {
  const button = event.target?.closest?.('button[data-rule-action]');
  if (!button) {
    return;
  }

  const ruleId = button.dataset.ruleId;
  const action = button.dataset.ruleAction;
  if (!ruleId || !action) {
    return;
  }

  try {
    requireApiKey();
    if (action === 'delete') {
      await api(`/api/v1/rules/${ruleId}`, { method: 'DELETE' });
      setFeedback('rules-feedback', `Regla ${ruleId} deshabilitada.`, 'success');
      await loadRules();
      await loadOverview();
    }
  } catch (error) {
    if (error instanceof ApiError && [404, 405, 501].includes(error.status) && action === 'delete') {
      state.capabilities.ruleDelete = false;
      setFeedback('rules-feedback', 'Delete/disable rule no soportado por este backend.', 'warn');
      await loadRules();
      return;
    }
    setFeedback('rules-feedback', `Error en acción de regla: ${error.message}`, 'error');
  }
}

async function handleAlertsTableAction(event) {
  const button = event.target?.closest?.('button[data-alert-action]');
  if (!button) {
    return;
  }

  const alertId = button.dataset.alertId;
  const action = button.dataset.alertAction;
  if (!alertId || !action) {
    return;
  }

  try {
    requireApiKey();
    if (action === 'send') {
      await api(`/api/v1/alerts/${alertId}/send`, { method: 'POST' });
      setFeedback('alerts-feedback', `Alert ${alertId} reencolada para envío.`, 'success');
      await loadAlerts();
      await loadOverview();
    }
  } catch (error) {
    setFeedback('alerts-feedback', `Error reenviando alert: ${error.message}`, 'error');
  }
}

function initTabs() {
  getById('tab-btn-overview').addEventListener('click', () => switchTab('overview'));
  getById('tab-btn-feeds').addEventListener('click', () => switchTab('feeds'));
  getById('tab-btn-rules-alerts').addEventListener('click', () => switchTab('rules-alerts'));
  getById('tab-btn-entries').addEventListener('click', () => switchTab('entries'));
  getById('tab-btn-opml').addEventListener('click', () => switchTab('opml'));
}

function initEvents() {
  getById('api-key').value = getApiKey();

  getById('save-key').addEventListener('click', async () => {
    setApiKey(getById('api-key').value);
    await refreshAll();
  });

  getById('refresh').addEventListener('click', () => {
    void refreshAll();
  });

  getById('entries-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    state.entriesPage = 1;
    void searchEntries();
  });
  getById('entries-prev').addEventListener('click', () => {
    state.entriesPage = Math.max(1, state.entriesPage - 1);
    void searchEntries();
  });
  getById('entries-next').addEventListener('click', () => {
    state.entriesPage += 1;
    void searchEntries();
  });

  getById('feed-create-form').addEventListener('submit', (event) => {
    void createFeed(event);
  });
  getById('feeds-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    state.feedsPage = 1;
    void loadFeeds();
  });
  getById('feeds-prev').addEventListener('click', () => {
    state.feedsPage = Math.max(1, state.feedsPage - 1);
    void loadFeeds();
  });
  getById('feeds-next').addEventListener('click', () => {
    state.feedsPage += 1;
    void loadFeeds();
  });
  getById('feeds-body').addEventListener('click', (event) => {
    void handleFeedsTableAction(event);
  });

  getById('rule-create-form').addEventListener('submit', (event) => {
    void createRule(event);
  });
  getById('rules-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    state.rulesPage = 1;
    void loadRules();
  });
  getById('rules-prev').addEventListener('click', () => {
    state.rulesPage = Math.max(1, state.rulesPage - 1);
    void loadRules();
  });
  getById('rules-next').addEventListener('click', () => {
    state.rulesPage += 1;
    void loadRules();
  });
  getById('rules-body').addEventListener('click', (event) => {
    void handleRulesTableAction(event);
  });

  getById('alerts-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    state.alertsPage = 1;
    void loadAlerts();
  });
  getById('alerts-prev').addEventListener('click', () => {
    state.alertsPage = Math.max(1, state.alertsPage - 1);
    void loadAlerts();
  });
  getById('alerts-next').addEventListener('click', () => {
    state.alertsPage += 1;
    void loadAlerts();
  });
  getById('alerts-body').addEventListener('click', (event) => {
    void handleAlertsTableAction(event);
  });

  getById('opml-upload-form').addEventListener('submit', (event) => {
    void uploadOpml(event);
  });
  getById('opml-preview-form').addEventListener('submit', (event) => {
    event.preventDefault();
    state.opmlPreviewPage = 1;
    void loadOpmlPreview();
  });
  getById('opml-preview-prev').addEventListener('click', () => {
    state.opmlPreviewPage = Math.max(1, state.opmlPreviewPage - 1);
    void loadOpmlPreview();
  });
  getById('opml-preview-next').addEventListener('click', () => {
    state.opmlPreviewPage += 1;
    void loadOpmlPreview();
  });
  getById('opml-confirm').addEventListener('click', () => {
    void confirmOpml();
  });
  getById('opml-status-refresh').addEventListener('click', () => {
    void loadOpmlStatus();
  });
}

function bootstrap() {
  initTabs();
  initEvents();
  switchTab('overview');
  void refreshAll();
}

bootstrap();
