const jsonHeaders = { 'content-type': 'application/json' };

const state = {
  feeds: [],
  rules: [],
  entries: [],
  alerts: [],
};

function parseKeywords(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function coerceErrorMessage(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && item.trim()).join(', ');
  }

  return typeof value === 'string' ? value : '';
}

function extractErrorMessage(body, fallbackMessage) {
  if (!body || typeof body !== 'object') {
    return fallbackMessage || 'request_failed';
  }

  const envelopeMessage = body.error && typeof body.error === 'object'
    ? coerceErrorMessage(body.error.message) || coerceErrorMessage(body.error.code)
    : '';

  const nestMessage = coerceErrorMessage(body.message);
  const nestError = coerceErrorMessage(body.error);

  return envelopeMessage || nestMessage || nestError || fallbackMessage || 'request_failed';
}

async function api(path, options) {
  const response = await fetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const fallbackMessage = typeof body === 'string' && body.trim() ? body : response.statusText;
    const message = extractErrorMessage(body, fallbackMessage);
    throw new Error(message || 'request_failed');
  }

  return body;
}

async function refreshAfterMutation(id, successMessage) {
  setFeedback(id, successMessage);

  try {
    await refresh();
  } catch (error) {
    setFeedback(id, `${successMessage} Dashboard refresh failed: ${error.message}`, false);
  }
}

function renderSummary({ health, readiness }) {
  const cards = [
    {
      label: 'Health',
      value: health.status,
      detail: `API ${health.checks.api}`,
    },
    {
      label: 'Readiness',
      value: readiness.status,
      detail: Object.entries(readiness.checks).map(([key, value]) => `${key}:${value}`).join(' | '),
    },
    {
      label: 'Feeds',
      value: String(state.feeds.length),
      detail: `${state.feeds.filter((feed) => feed.status === 'active').length} active`,
    },
    {
      label: 'Rules',
      value: String(state.rules.length),
      detail: `${state.rules.filter((rule) => rule.isActive).length} active`,
    },
    {
      label: 'Entries',
      value: String(state.entries.length),
      detail: 'Latest page snapshot',
    },
    {
      label: 'Alerts',
      value: String(state.alerts.length),
      detail: `${state.alerts.filter((alert) => alert.deliveryStatus === 'failed').length} failed`,
    },
  ];

  const root = document.getElementById('summary-cards');
  const template = document.getElementById('summary-card-template');
  root.innerHTML = '';

  cards.forEach((card) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector('.status-label').textContent = card.label;
    node.querySelector('.status-value').textContent = card.value;
    node.querySelector('.status-detail').textContent = card.detail;
    root.appendChild(node);
  });
}

function cardList(id, items) {
  const root = document.getElementById(id);
  root.innerHTML = '';

  if (!items.length) {
    root.innerHTML = '<div class="empty-state">No records yet.</div>';
    return;
  }

  items.forEach((item) => root.appendChild(item));
}

function createCard({ title, badge, badgeWarn, meta, body, actions }) {
  const article = document.createElement('article');
  article.className = 'data-card';

  const actionHtml = actions && actions.length
    ? `<div class="card-actions">${actions.join('')}</div>`
    : '';

  article.innerHTML = `
    <div class="card-top">
      <div>
        <h3 class="card-title">${title}</h3>
        <div class="card-meta">${meta}</div>
      </div>
      <span class="badge${badgeWarn ? ' warn' : ''}">${badge}</span>
    </div>
    <div class="card-body">${body}</div>
    ${actionHtml}
  `;

  return article;
}

function renderFeeds() {
  cardList('feeds-list', state.feeds.map((feed) => {
    const card = createCard({
      title: feed.url,
      badge: feed.status,
      badgeWarn: feed.status !== 'active',
      meta: `id ${feed.id} | every ${feed.pollIntervalSeconds}s`,
      body: `next ${feed.nextCheckAt || 'n/a'}<br>last checked ${feed.lastCheckedAt || 'never'}<br>last error ${feed.lastError || 'none'}`,
      actions: [
        `<button class="button small ghost" data-feed-check="${feed.id}" type="button">Check Now</button>`,
      ],
    });
    return card;
  }));
}

function renderRules() {
  cardList('rules-list', state.rules.map((rule) => createCard({
    title: rule.name,
    badge: rule.isActive ? 'active' : 'inactive',
    badgeWarn: !rule.isActive,
    meta: `id ${rule.id}`,
    body: `include ${rule.includeKeywords.join(', ')}<br>exclude ${rule.excludeKeywords.join(', ') || 'none'}`,
  })));
}

function renderEntries() {
  cardList('entries-list', state.entries.map((entry) => createCard({
    title: entry.title || `Entry ${entry.id}`,
    badge: `feed ${entry.feedId}`,
    meta: entry.link || 'no link',
    body: `${entry.content || 'No content snippet available.'}<br>published ${entry.publishedAt || 'unknown'}`,
  })));
}

function renderAlerts() {
  cardList('alerts-list', state.alerts.map((alert) => createCard({
    title: alert.entry.title || `Alert ${alert.id}`,
    badge: alert.deliveryStatus,
    badgeWarn: alert.deliveryStatus === 'failed' || alert.deliveryStatus === 'disabled',
    meta: `rule ${alert.rule.name} | attempts ${alert.deliveryAttempts}`,
    body: `sent ${alert.sent ? 'yes' : 'no'}<br>queued ${alert.lastDeliveryQueuedAt || 'never'}<br>last error ${alert.lastDeliveryError || 'none'}`,
    actions: !alert.sent ? [`<button class="button small warn" data-alert-send="${alert.id}" type="button">Resend</button>`] : [],
  })));
}

function setFeedback(id, message, isError = false) {
  const node = document.getElementById(id);
  node.textContent = message;
  node.className = `feedback ${isError ? 'error' : 'success'}`;
}

async function refresh() {
  const [health, readinessResponse, feeds, rules, entries, alerts] = await Promise.all([
    api('/health'),
    fetch('/ready').then(async (response) => {
      const payload = await response.json();
      return payload;
    }),
    api('/api/v1/feeds?page_size=6'),
    api('/api/v1/rules?page_size=6'),
    api('/api/v1/entries?page_size=6'),
    api('/api/v1/alerts?page_size=6'),
  ]);

  state.feeds = feeds.data;
  state.rules = rules.data;
  state.entries = entries.data;
  state.alerts = alerts.data;

  renderSummary({ health, readiness: readinessResponse });
  renderFeeds();
  renderRules();
  renderEntries();
  renderAlerts();
}

document.getElementById('refresh-all').addEventListener('click', () => {
  void refresh();
});

document.getElementById('feed-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    await api('/api/v1/feeds', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        url: form.get('url'),
        poll_interval_seconds: Number(form.get('poll_interval_seconds')),
        status: form.get('status'),
      }),
    });
    event.currentTarget.reset();
    await refreshAfterMutation('feed-feedback', 'Feed created.');
  } catch (error) {
    setFeedback('feed-feedback', error.message, true);
  }
});

document.getElementById('rule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    await api('/api/v1/rules', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        name: form.get('name'),
        include_keywords: parseKeywords(String(form.get('include_keywords') || '')),
        exclude_keywords: parseKeywords(String(form.get('exclude_keywords') || '')),
      }),
    });
    event.currentTarget.reset();
    setFeedback('rule-feedback', 'Rule created.');
    await refresh();
  } catch (error) {
    setFeedback('rule-feedback', error.message, true);
  }
});

document.body.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const feedId = target.getAttribute('data-feed-check');
  const alertId = target.getAttribute('data-alert-send');

  try {
    if (feedId) {
      await api(`/api/v1/feeds/${feedId}/check-now`, { method: 'POST' });
      await refresh();
    }

    if (alertId) {
      await api(`/api/v1/alerts/${alertId}/send`, { method: 'POST' });
      await refresh();
    }
  } catch (error) {
    window.alert(error.message);
  }
});

void refresh();
