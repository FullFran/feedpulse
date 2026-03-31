const KEY_STORAGE = 'rss-dashboard-api-key';

function getApiKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}

function setApiKey(value) {
  localStorage.setItem(KEY_STORAGE, value.trim());
}

function toIsoOrUndefined(value) {
  if (!value) {
    return undefined;
  }

  return new Date(value).toISOString();
}

function formatDate(value) {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleString();
}

async function api(path, options = {}) {
  const apiKey = getApiKey();
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${apiKey}`,
  };

  const response = await fetch(path, { ...options, headers });
  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof body === 'object' ? body.message || body.error || response.statusText : response.statusText;
    throw new Error(String(message));
  }

  return body;
}

function renderSummary(summary) {
  const root = document.getElementById('summary');
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

function renderEntries(payload) {
  const tbody = document.getElementById('entries-body');
  const meta = document.getElementById('entries-meta');
  const items = payload.data || [];
  const total = payload.meta?.total ?? 0;

  meta.textContent = `${items.length} resultados mostrados (total: ${total}).`;

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="4">Sin resultados</td></tr>';
    return;
  }

  tbody.innerHTML = items
    .map((entry) => {
      const title = entry.title || '(sin título)';
      const link = entry.link ? `<a href="${entry.link}" target="_blank" rel="noreferrer">abrir</a>` : '-';
      return `
        <tr>
          <td>${formatDate(entry.publishedAt || entry.fetchedAt)}</td>
          <td>${title}</td>
          <td>${entry.feedId}</td>
          <td>${link}</td>
        </tr>
      `;
    })
    .join('');
}

async function loadSummary() {
  const summary = await api('/api/v1/ops/summary');
  renderSummary(summary.data);
}

async function searchEntries() {
  const from = toIsoOrUndefined(document.getElementById('from').value);
  const to = toIsoOrUndefined(document.getElementById('to').value);
  const search = document.getElementById('search').value.trim();
  const pageSize = Number(document.getElementById('page-size').value || 50);

  const params = new URLSearchParams({ page: '1', page_size: String(pageSize) });
  if (search) params.set('search', search);
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const payload = await api(`/api/v1/entries?${params.toString()}`);
  renderEntries(payload);
}

async function refreshAll() {
  const feedback = document.getElementById('auth-feedback');
  try {
    await loadSummary();
    await searchEntries();
    feedback.textContent = 'OK';
  } catch (error) {
    feedback.textContent = `Error: ${error.message}`;
  }
}

document.getElementById('api-key').value = getApiKey();

document.getElementById('save-key').addEventListener('click', async () => {
  setApiKey(document.getElementById('api-key').value);
  await refreshAll();
});

document.getElementById('refresh').addEventListener('click', () => {
  void refreshAll();
});

document.getElementById('entries-filter').addEventListener('submit', (event) => {
  event.preventDefault();
  void searchEntries();
});

void refreshAll();
