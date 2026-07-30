const KEY_STORAGE = 'rss-dashboard-api-key';
const CLERK_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js';

const state = {
  tabs: ['overview', 'feeds', 'rules-alerts', 'entries', 'opml', 'settings'],
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
  auth: {
    mode: 'api-key',
    clerkEnabled: false,
    clerkReady: false,
    clerkToken: '',
    // In-memory cache; `null` means "not read from sessionStorage yet".
    apiKey: null,
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

function safeStorage(name) {
  try {
    const storage = globalThis[name];
    if (!storage || typeof storage.getItem !== 'function') {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

/**
 * Removes any API key persisted by older builds. The key used to live in
 * localStorage, which survives browser restarts and is readable by every script
 * running on this origin. It is migrated once into sessionStorage and then dropped.
 */
function migrateLegacyApiKeyStorage() {
  const legacy = safeStorage('localStorage');
  if (!legacy) {
    return;
  }

  try {
    const stored = (legacy.getItem(KEY_STORAGE) || '').trim();
    if (stored) {
      setApiKey(stored);
    }
    if (typeof legacy.removeItem === 'function') {
      legacy.removeItem(KEY_STORAGE);
    }
  } catch {
    // Storage disabled by the browser: nothing to migrate.
  }
}

function getApiKey() {
  if (state.auth.apiKey !== null) {
    return state.auth.apiKey;
  }

  const storage = safeStorage('sessionStorage');
  let stored = '';
  try {
    stored = storage ? (storage.getItem(KEY_STORAGE) || '').trim() : '';
  } catch {
    stored = '';
  }

  state.auth.apiKey = stored;
  return state.auth.apiKey;
}

function setApiKey(value) {
  state.auth.apiKey = String(value || '').trim();

  const storage = safeStorage('sessionStorage');
  if (!storage) {
    return;
  }

  try {
    if (state.auth.apiKey) {
      storage.setItem(KEY_STORAGE, state.auth.apiKey);
    } else if (typeof storage.removeItem === 'function') {
      storage.removeItem(KEY_STORAGE);
    }
  } catch {
    // Storage disabled by the browser: the in-memory value still works for this tab.
  }
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

/**
 * Returns an escaped href that is safe to inline in `innerHTML`, or '#'.
 *
 * Feed and entry URLs are remote-controlled: a hostile feed can publish
 * `<link>javascript:...</link>` and, because the dashboard is served from the API
 * origin, a single click would run attacker code with access to the operator's
 * credentials. `escapeHtml` alone does not restrict the URL scheme, so only
 * absolute http/https URLs are accepted here.
 */
function safeHref(value) {
  const raw = String(value ?? '');
  // Browsers ignore control characters and whitespace while parsing the scheme,
  // so `java\tscript:` must be normalised before the check.
  const normalized = raw.replace(/[\u0000-\u0020\u007F]/g, '');
  if (!/^https?:\/\//i.test(normalized)) {
    return '#';
  }

  return escapeHtml(normalized);
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

function parseRecipientEmails(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\n,]/g)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function parseTelegramChatIds(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\n,]/g)
        .map((part) => part.trim())
        .filter((part) => /^-?\d+$/.test(part)),
    ),
  );
}

function setFeedback(id, text, tone = 'info') {
  const node = getById(id);
  node.textContent = text;
  node.dataset.tone = tone;
}

/**
 * Sets an attribute only when the node actually supports it.
 *
 * The dashboard client is exercised by `test/dashboard-client.spec.ts` against a
 * minimal DOM double that implements `textContent`, `dataset`, `classList` and
 * `hidden` but no attribute API. ARIA state is progressive enhancement for the
 * browser, so it must never be the reason the module throws.
 */
function setAttributeIfSupported(node, name, value) {
  if (node && typeof node.setAttribute === 'function') {
    node.setAttribute(name, value);
  }
}

/** Moves focus when the environment supports it (see `setAttributeIfSupported`). */
function focusIfSupported(node) {
  if (node && typeof node.focus === 'function') {
    node.focus();
  }
}

/**
 * Full-width placeholder row.
 *
 * A blank `<tbody>` is indistinguishable from a request that silently failed, so
 * every table states what it is empty *and* what the operator can do next.
 */
function emptyStateRow(columns, title, hint) {
  return `
    <tr class="empty-row">
      <td colspan="${columns}">
        <div class="empty-state">
          <p class="empty-title">${escapeHtml(title)}</p>
          <p class="empty-hint">${escapeHtml(hint)}</p>
        </div>
      </td>
    </tr>
  `;
}

/** Status pill. `data-status` drives the colour; see the badge rules in styles.css. */
function statusBadge(value) {
  const label = escapeHtml(String(value ?? '-'));
  return `<span class="badge" data-status="${label}">${label}</span>`;
}

async function ensureClerkToken() {
  const clerk = globalThis.Clerk;
  if (!state.auth.clerkEnabled || !clerk || !clerk.session) {
    state.auth.clerkToken = '';
    return '';
  }

  try {
    const token = await clerk.session.getToken();
    state.auth.clerkToken = token || '';
    return state.auth.clerkToken;
  } catch {
    state.auth.clerkToken = '';
    return '';
  }
}

async function requireAuth() {
  const apiKey = getApiKey();
  if (apiKey) {
    state.auth.mode = 'api-key';
    return;
  }

  const clerkToken = await ensureClerkToken();
  if (clerkToken) {
    state.auth.mode = 'clerk';
    return;
  }

  throw new Error('missing_auth_credentials');
}

function renderAuthMode() {
  // The Clerk buttons are inert until `/api/v1/auth/dashboard-config` reports a
  // publishable key and the SDK has loaded. Leaving them enabled makes the
  // dashboard look broken on the far more common API-key-only deployment.
  getById('clerk-sign-in').disabled = !(state.auth.clerkEnabled && state.auth.clerkReady);
  getById('clerk-sign-out').disabled = !state.auth.clerkToken;

  if (getApiKey()) {
    setFeedback('auth-mode', 'Auth mode: manual API key.', 'success');
    return;
  }

  if (state.auth.clerkToken) {
    setFeedback('auth-mode', 'Auth mode: Clerk session.', 'success');
    return;
  }

  if (state.auth.clerkEnabled) {
    setFeedback('auth-mode', 'Auth mode: Clerk available (no active session), or a manual API key.', 'info');
    return;
  }

  setFeedback('auth-mode', 'Auth mode: manual API key. No credential stored yet.', 'info');
}

async function buildHeaders(extra = {}) {
  await ensureClerkToken();
  const apiKey = getApiKey();
  const headers = {
    ...extra,
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
    return headers;
  }

  if (state.auth.clerkToken) {
    headers.Authorization = `Bearer ${state.auth.clerkToken}`;
  }

  return headers;
}

async function apiRaw(path, options = {}) {
  const headers = await buildHeaders(options.headers || {});
  const response = await fetch(path, {
    ...options,
    headers,
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
    // Roving tabindex: the tablist is a single tab stop and the arrow keys move
    // between the tabs inside it, which is what a screen reader announces for
    // `role="tab"`. The static markup sets no tabindex, so if this script fails
    // to run every tab stays reachable with Tab alone.
    setAttributeIfSupported(button, 'aria-selected', isActive ? 'true' : 'false');
    setAttributeIfSupported(button, 'tabindex', isActive ? '0' : '-1');
  }
}

function renderSummary(summary) {
  const root = getById('summary');
  const cards = [
    ['Feeds total', summary.feedsTotal],
    ['Feeds active', summary.feedsActive],
    ['Feeds in error', summary.feedsError],
    ['Entries 24h', summary.entries24h],
    ['Entries 7d', summary.entries7d],
    ['Alerts pending', summary.alertsPending],
  ];

  root.innerHTML = cards
    .map(
      ([label, value]) =>
        `<article class="kpi"><div class="label">${label}</div><div class="value">${escapeHtml(value ?? '-')}</div></article>`,
    )
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

  meta.textContent = `Showing ${items.length} of ${total} entries.`;
  meta.dataset.tone = 'info';
  updatePager('entries', page, hasNext);

  if (!items.length) {
    tbody.innerHTML = emptyStateRow(
      4,
      'No entries match this search',
      'Widen the date range or clear the search box. Entries only exist after a feed has been fetched — use "Check now" on the Feeds tab instead of waiting for the next scheduled poll.',
    );
    return;
  }

  tbody.innerHTML = items
    .map((entry) => {
      const title = escapeHtml(entry.title || '(untitled)');
      const link = entry.link ? `<a href="${safeHref(entry.link)}" target="_blank" rel="noreferrer">Open</a>` : '-';
      return `
        <tr>
          <td class="numeric">${escapeHtml(formatDate(entry.publishedAt || entry.fetchedAt))}</td>
          <td><span class="cell-truncate">${title}</span></td>
          <td class="numeric">${escapeHtml(entry.feedId)}</td>
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

  meta.textContent = `Showing ${items.length} of ${total} feeds.`;
  meta.dataset.tone = 'info';
  updatePager('feeds', page, hasNext);

  if (!items.length) {
    tbody.innerHTML = emptyStateRow(
      5,
      'No feeds registered',
      'Add a feed with the form above, or import an existing subscription list from the OPML tab.',
    );
    return;
  }

  tbody.innerHTML = items
    .map((feed) => {
      const nextStatus = feed.status === 'paused' ? 'active' : 'paused';
      const toggleLabel = feed.status === 'paused' ? 'Resume' : 'Pause';
      const deleteDisabled = state.capabilities.feedDelete ? '' : 'disabled';
      return `
        <tr>
          <td class="numeric">${feed.id}</td>
          <td>
            <a class="cell-truncate" href="${safeHref(feed.url)}" target="_blank" rel="noreferrer">${escapeHtml(feed.url)}</a>
          </td>
          <td>${statusBadge(feed.status)}</td>
          <td class="numeric">${escapeHtml(formatDate(feed.nextCheckAt))}</td>
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

  meta.textContent = `Showing ${items.length} of ${total} rules.`;
  meta.dataset.tone = 'info';
  updatePager('rules', page, hasNext);

  if (!items.length) {
    tbody.innerHTML = emptyStateRow(
      5,
      'No rules defined',
      'Add a rule with the form above. Without an active rule, entries are still ingested but no alert is ever raised.',
    );
    return;
  }

  tbody.innerHTML = items
    .map((rule) => {
      const deleteDisabled = state.capabilities.ruleDelete ? '' : 'disabled';
      return `
        <tr>
          <td class="numeric">${rule.id}</td>
          <td>${escapeHtml(rule.name)}</td>
          <td><span class="cell-truncate">${escapeHtml(rule.includeKeywords.join(', '))}</span></td>
          <td>${statusBadge(rule.isActive ? 'yes' : 'no')}</td>
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

  meta.textContent = `Showing ${items.length} of ${total} alerts.`;
  meta.dataset.tone = 'info';
  updatePager('alerts', page, hasNext);

  if (!items.length) {
    tbody.innerHTML = emptyStateRow(
      5,
      'No alerts yet',
      'An alert is raised when an ingested entry matches an active rule. Check that at least one rule is active and that its feeds have been fetched.',
    );
    return;
  }

  tbody.innerHTML = items
    .map((alert) => {
      const title = escapeHtml(alert.entry?.title || '(untitled)');
      const ruleName = escapeHtml(alert.rule?.name || '-');
      const canSend = alert.deliveryStatus !== 'disabled';
      return `
        <tr>
          <td class="numeric">${alert.id}</td>
          <td>${statusBadge(alert.deliveryStatus)}</td>
          <td>${ruleName}</td>
          <td><span class="cell-truncate">${title}</span></td>
          <td><button type="button" data-alert-action="send" data-alert-id="${alert.id}" ${canSend ? '' : 'disabled'}>Resend</button></td>
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
    tbody.innerHTML = emptyStateRow(
      5,
      'No preview items',
      'Upload an OPML file above, then load the preview for the import id it returns.',
    );
    return;
  }

  tbody.innerHTML = items
    .map((item) => {
      const url = item.normalizedUrl
        ? `<a class="cell-truncate" href="${safeHref(item.normalizedUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.normalizedUrl)}</a>`
        : '-';
      return `
        <tr>
          <td class="numeric">${item.id}</td>
          <td><span class="cell-truncate">${escapeHtml(item.title || '-')}</span></td>
          <td>${url}</td>
          <td>${statusBadge(item.itemStatus)}</td>
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
    await requireAuth();
    const [summary, health, ready] = await Promise.all([
      api('/api/v1/ops/summary'),
      api('/health'),
      api('/ready').catch((error) => ({ status: 'error', checks: error.body?.checks })),
    ]);
    renderSummary(summary.data || {});
    getById('health-live').textContent = health.status || '-';
    getById('health-ready').textContent = ready.status || 'error';
    setFeedback('overview-feedback', 'Overview updated.', 'success');
  } catch (error) {
    setFeedback('overview-feedback', `Overview error: ${error.message}`, 'error');
  }
}

async function searchEntries() {
  try {
    await requireAuth();
    const params = buildEntriesParams();
    const payload = await api(`/api/v1/entries?${params.toString()}`);
    renderEntries(payload);
  } catch (error) {
    setFeedback('entries-meta', `Entries error: ${error.message}`, 'error');
  }
}

async function loadFeeds() {
  try {
    await requireAuth();
    const status = getById('feeds-filter-status').value;
    const q = getById('feeds-filter-q').value.trim();
    const pageSize = Number(getById('feeds-page-size').value || 25);
    const params = new URLSearchParams({ page: String(state.feedsPage), page_size: String(pageSize) });
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    const payload = await api(`/api/v1/feeds?${params.toString()}`);
    renderFeeds(payload);
    setFeedback('feeds-feedback', 'Feeds updated.', 'success');
  } catch (error) {
    setFeedback('feeds-feedback', `Feeds error: ${error.message}`, 'error');
  }
}

async function loadRules() {
  try {
    await requireAuth();
    const pageSize = Number(getById('rules-page-size').value || 25);
    const params = new URLSearchParams({ page: String(state.rulesPage), page_size: String(pageSize) });
    const payload = await api(`/api/v1/rules?${params.toString()}`);
    renderRules(payload);
    setFeedback('rules-feedback', 'Rules updated.', 'success');
  } catch (error) {
    setFeedback('rules-feedback', `Rules error: ${error.message}`, 'error');
  }
}

async function loadAlerts() {
  try {
    await requireAuth();
    const sent = getById('alerts-sent').value;
    const pageSize = Number(getById('alerts-page-size').value || 25);
    const params = new URLSearchParams({ page: String(state.alertsPage), page_size: String(pageSize) });
    if (sent === 'true' || sent === 'false') {
      params.set('sent', sent);
    }
    const payload = await api(`/api/v1/alerts?${params.toString()}`);
    renderAlerts(payload);
    setFeedback('alerts-feedback', 'Alerts updated.', 'success');
  } catch (error) {
    setFeedback('alerts-feedback', `Alerts error: ${error.message}`, 'error');
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
    await requireAuth();
    if (!state.capabilities.opml) {
      setFeedback('opml-feedback', 'OPML is not available in this backend.', 'warn');
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
      setFeedback('opml-feedback', 'This backend does not support OPML import in this environment.', 'warn');
      return;
    }
    setFeedback('opml-feedback', `OPML preview error: ${error.message}`, 'error');
  }
}

async function loadOpmlStatus() {
  try {
    await requireAuth();
    const importId = getOpmlImportId();
    const payload = await api(`/api/v1/opml/imports/${importId}/status`);
    const data = payload.data || {};
    setFeedback(
      'opml-status-output',
      `status=${data.status || '-'} progress=${data.progressPercent ?? '-'}% imported=${data.importedItems ?? '-'} failed=${data.failedItems ?? '-'}`,
      'success',
    );
  } catch (error) {
    setFeedback('opml-status-output', `OPML status error: ${error.message}`, 'error');
  }
}

async function refreshAll() {
  try {
    await requireAuth();
  } catch {
    setFeedback(
      'auth-feedback',
      'Enter an API key above (or sign in with Clerk) to load data. If the API runs with ENABLE_AUTH=false, any placeholder value is accepted.',
      'warn',
    );
    renderAuthMode();
    return;
  }

  const results = await Promise.allSettled([loadOverview(), searchEntries(), loadFeeds(), loadRules(), loadAlerts()]);
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed > 0) {
    setFeedback('auth-feedback', `Partial refresh (${failed} failures).`, 'warn');
    return;
  }
  setFeedback('auth-feedback', 'Data updated.', 'success');
  renderAuthMode();
}

async function createFeed(event) {
  event.preventDefault();
  try {
    await requireAuth();
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
    setFeedback('feeds-feedback', 'Feed created.', 'success');
    getById('feed-create-form').reset();
    await loadFeeds();
    await loadOverview();
  } catch (error) {
    setFeedback('feeds-feedback', `Error creating feed: ${error.message}`, 'error');
  }
}

async function createRule(event) {
  event.preventDefault();
  try {
    await requireAuth();
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

    setFeedback('rules-feedback', 'Rule created.', 'success');
    getById('rule-create-form').reset();
    getById('rule-active').checked = true;
    await loadRules();
  } catch (error) {
    setFeedback('rules-feedback', `Error creating rule: ${error.message}`, 'error');
  }
}

async function uploadOpml(event) {
  event.preventDefault();
  try {
    await requireAuth();
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
    setFeedback('opml-feedback', `Import created: id=${payload.data?.id} status=${payload.data?.status}.`, 'success');
  } catch (error) {
    if (error instanceof ApiError && [404, 405, 501].includes(error.status)) {
      state.capabilities.opml = false;
      setFeedback('opml-feedback', 'This backend does not support OPML import in this environment.', 'warn');
      return;
    }
    setFeedback('opml-feedback', `Error uploading OPML: ${error.message}`, 'error');
  }
}

async function confirmOpml() {
  try {
    await requireAuth();
    const importId = getOpmlImportId();
    const payload = await api(`/api/v1/opml/imports/${importId}/confirm`, { method: 'POST' });
    setFeedback('opml-status-output', `Confirmation sent: ${payload.data?.status || 'queued'}.`, 'success');
  } catch (error) {
    setFeedback('opml-status-output', `Error confirming OPML: ${error.message}`, 'error');
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
    await requireAuth();
    if (action === 'check') {
      await api(`/api/v1/feeds/${feedId}/check-now`, { method: 'POST' });
      setFeedback('feeds-feedback', `Feed ${feedId} queued for an immediate check.`, 'success');
      return;
    }

    if (action === 'toggle') {
      await api(`/api/v1/feeds/${feedId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: button.dataset.feedStatus }),
      });
      setFeedback('feeds-feedback', `Feed ${feedId} updated.`, 'success');
      await loadFeeds();
      await loadOverview();
      return;
    }

    if (action === 'delete') {
      if (!state.capabilities.feedDelete) {
        return;
      }
      await api(`/api/v1/feeds/${feedId}`, { method: 'DELETE' });
      setFeedback('feeds-feedback', `Feed ${feedId} disabled.`, 'success');
      await loadFeeds();
      await loadOverview();
    }
  } catch (error) {
    if (error instanceof ApiError && [404, 405, 501].includes(error.status) && action === 'delete') {
      state.capabilities.feedDelete = false;
      setFeedback('feeds-feedback', 'Delete/disable feed is not supported by this backend.', 'warn');
      await loadFeeds();
      return;
    }

    setFeedback('feeds-feedback', `Feed action error: ${error.message}`, 'error');
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
    await requireAuth();
    if (action === 'delete') {
      await api(`/api/v1/rules/${ruleId}`, { method: 'DELETE' });
      setFeedback('rules-feedback', `Rule ${ruleId} disabled.`, 'success');
      await loadRules();
      await loadOverview();
    }
  } catch (error) {
    if (error instanceof ApiError && [404, 405, 501].includes(error.status) && action === 'delete') {
      state.capabilities.ruleDelete = false;
      setFeedback('rules-feedback', 'Delete/disable rule is not supported by this backend.', 'warn');
      await loadRules();
      return;
    }
    setFeedback('rules-feedback', `Rule action error: ${error.message}`, 'error');
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
    await requireAuth();
    if (action === 'send') {
      await api(`/api/v1/alerts/${alertId}/send`, { method: 'POST' });
      setFeedback('alerts-feedback', `Alert ${alertId} re-queued for delivery.`, 'success');
      await loadAlerts();
      await loadOverview();
    }
  } catch (error) {
    setFeedback('alerts-feedback', `Error resending alert: ${error.message}`, 'error');
  }
}

async function loadSettings() {
  try {
    await requireAuth();
    const payload = await api('/api/v1/settings');
    const webhookUrl = payload.data?.webhookNotifierUrl || '';
    const recipientEmails = payload.data?.recipientEmails || [];
    const telegramChatIds = payload.data?.telegramChatIds || [];
    const telegramDeliveryMode = payload.data?.telegramDeliveryMode || 'instant';
    const telegramBotTokenConfigured = Boolean(payload.data?.telegramBotTokenConfigured);
    getById('settings-webhook-url').value = webhookUrl;
    getById('settings-recipient-emails').value = recipientEmails.join('\n');
    getById('settings-telegram-bot-token').value = '';
    getById('settings-telegram-token-clear').checked = false;
    getById('settings-telegram-chat-ids').value = telegramChatIds.join('\n');
    getById('settings-telegram-mode').value = telegramDeliveryMode;
    setFeedback(
      'settings-telegram-token-status',
      telegramBotTokenConfigured
        ? 'Tenant token configured.'
        : 'Tenant token not configured (the global fallback is used when available).',
      telegramBotTokenConfigured ? 'success' : 'warn',
    );
    setFeedback('settings-feedback', 'Settings loaded successfully.', 'info');
  } catch (error) {
    setFeedback('settings-feedback', `Error loading settings: ${error.message}`, 'error');
  }
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    await requireAuth();
    const raw = getById('settings-webhook-url').value.trim();
    const recipientEmails = parseRecipientEmails(getById('settings-recipient-emails').value);
    const telegramBotTokenRaw = getById('settings-telegram-bot-token').value.trim();
    const clearTelegramBotToken = Boolean(getById('settings-telegram-token-clear').checked);
    const telegramChatIds = parseTelegramChatIds(getById('settings-telegram-chat-ids').value);
    const telegramModeRaw = getById('settings-telegram-mode').value;
    const telegramDeliveryMode = telegramModeRaw === 'digest_10m' ? 'digest_10m' : 'instant';

    const body = {
      webhook_notifier_url: raw || null,
      recipient_emails: recipientEmails,
      telegram_chat_ids: telegramChatIds,
      telegram_delivery_mode: telegramDeliveryMode,
    };

    if (clearTelegramBotToken) {
      body.telegram_bot_token_clear = true;
    } else if (telegramBotTokenRaw.length > 0) {
      body.telegram_bot_token = telegramBotTokenRaw;
    }

    await api('/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    getById('settings-telegram-bot-token').value = '';
    getById('settings-telegram-token-clear').checked = false;
    setFeedback('settings-feedback', 'Settings saved successfully.', 'success');
    await loadSettings();
  } catch (error) {
    setFeedback('settings-feedback', `Error saving settings: ${error.message}`, 'error');
  }
}

async function clearSettings() {
  try {
    await requireAuth();
    await api('/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhook_notifier_url: null,
        recipient_emails: [],
        telegram_chat_ids: [],
        telegram_delivery_mode: 'instant',
        telegram_bot_token_clear: true,
      }),
    });
    getById('settings-webhook-url').value = '';
    getById('settings-recipient-emails').value = '';
    getById('settings-telegram-bot-token').value = '';
    getById('settings-telegram-token-clear').checked = false;
    getById('settings-telegram-chat-ids').value = '';
    getById('settings-telegram-mode').value = 'instant';
    setFeedback('settings-telegram-token-status', 'Tenant token not configured.', 'warn');
    setFeedback('settings-feedback', 'Channels cleared for this tenant.', 'success');
  } catch (error) {
    setFeedback('settings-feedback', `Error clearing channels: ${error.message}`, 'error');
  }
}

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('script_load_failed'));
    document.head.appendChild(script);
  });
}

async function initClerk() {
  if (typeof document.createElement !== 'function' || !document.head || typeof document.head.appendChild !== 'function') {
    renderAuthMode();
    return;
  }

  try {
    const cfg = await api('/api/v1/auth/dashboard-config');
    const publishableKey = cfg.data?.clerkPublishableKey;
    state.auth.clerkEnabled = Boolean(cfg.data?.clerkEnabled && publishableKey);
    if (!state.auth.clerkEnabled) {
      renderAuthMode();
      return;
    }

    await loadExternalScript(CLERK_SCRIPT_URL);
    await globalThis.Clerk.load({ publishableKey });
    state.auth.clerkReady = true;
    await ensureClerkToken();
    renderAuthMode();
  } catch {
    state.auth.clerkEnabled = false;
    renderAuthMode();
  }
}

async function signInWithClerk() {
  if (!state.auth.clerkEnabled || !state.auth.clerkReady || !globalThis.Clerk) {
    setFeedback('auth-feedback', 'Clerk is not available in this environment.', 'warn');
    return;
  }

  await globalThis.Clerk.openSignIn();
  await ensureClerkToken();
  renderAuthMode();
  await refreshAll();
}

async function signOutFromClerk() {
  if (!globalThis.Clerk) {
    return;
  }

  await globalThis.Clerk.signOut();
  state.auth.clerkToken = '';
  renderAuthMode();
  setFeedback('auth-feedback', 'Clerk session closed.', 'info');
}

/** Selects a tab and runs the side effect the tab owns. */
function activateTab(tabId) {
  switchTab(tabId);
  if (tabId === 'settings') {
    void loadSettings();
  }
}

/** Arrow/Home/End navigation, the interaction `role="tab"` promises. */
function handleTabKeydown(event) {
  const key = event?.key;
  const currentIndex = state.tabs.indexOf(state.activeTab);
  const count = state.tabs.length;
  let nextIndex = -1;

  if (key === 'ArrowRight' || key === 'ArrowDown') {
    nextIndex = (currentIndex + 1) % count;
  } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + count) % count;
  } else if (key === 'Home') {
    nextIndex = 0;
  } else if (key === 'End') {
    nextIndex = count - 1;
  } else {
    return;
  }

  if (typeof event.preventDefault === 'function') {
    event.preventDefault();
  }

  const nextTab = state.tabs[nextIndex];
  activateTab(nextTab);
  focusIfSupported(getById(`tab-btn-${nextTab}`));
}

function initTabs() {
  for (const tab of state.tabs) {
    const button = getById(`tab-btn-${tab}`);
    button.addEventListener('click', () => activateTab(tab));
    button.addEventListener('keydown', (event) => handleTabKeydown(event));
  }
}

function initEvents() {
  getById('api-key').value = getApiKey();

  getById('save-key').addEventListener('click', async () => {
    setApiKey(getById('api-key').value);
    state.auth.clerkToken = '';
    renderAuthMode();
    await refreshAll();
  });

  getById('clerk-sign-in').addEventListener('click', () => {
    void signInWithClerk();
  });

  getById('clerk-sign-out').addEventListener('click', () => {
    void signOutFromClerk();
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

  getById('settings-form').addEventListener('submit', (event) => {
    void saveSettings(event);
  });
  getById('settings-refresh').addEventListener('click', () => {
    void loadSettings();
  });
  getById('settings-clear').addEventListener('click', () => {
    void clearSettings();
  });
}

function bootstrap() {
  migrateLegacyApiKeyStorage();
  initTabs();
  initEvents();
  renderAuthMode();
  void initClerk();
  switchTab('overview');
  void refreshAll();
}

bootstrap();
