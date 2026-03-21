/// <reference types="node" />

import { createServer, IncomingMessage, ServerResponse } from 'node:http';

import {
  buildFixtureStats,
  createRssDocument,
  feedKeyFromPath,
  paginate,
  type CaptureRecord,
  type RequestLogRecord,
} from './mock-monitoring-fixture';

const port = Number.parseInt(process.env.SMOKE_MONITORING_PORT ?? '4010', 10);
const captures: CaptureRecord[] = [];
const requestLogs: RequestLogRecord[] = [];

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body, null, 2));
}

function writeRss(response: ServerResponse, pathname: string): void {
  const feedKey = feedKeyFromPath(pathname) ?? 'smoke-default';
  response.statusCode = 200;
  response.setHeader('content-type', 'application/rss+xml; charset=utf-8');
  response.end(createRssDocument(feedKey, `http://127.0.0.1:${port}`));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(body: string): unknown {
  if (!body.trim()) {
    return null;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function recordRequest(request: IncomingMessage, statusCode: number): void {
  requestLogs.push({
    method: request.method ?? 'GET',
    path: request.url ?? '/',
    statusCode,
    timestamp: new Date().toISOString(),
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const method = request.method ?? 'GET';
  const stats = () => buildFixtureStats(captures, requestLogs);
  const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
  const limit = Number.parseInt(url.searchParams.get('limit') ?? `${Math.max(captures.length, requestLogs.length, 1)}`, 10);

  if (method === 'GET' && url.pathname === '/health') {
    recordRequest(request, 200);
    writeJson(response, 200, { status: 'ok', ...stats() });
    return;
  }

  if (method === 'GET' && feedKeyFromPath(url.pathname)) {
    recordRequest(request, 200);
    writeRss(response, url.pathname);
    return;
  }

  if (method === 'GET' && url.pathname === '/captures') {
    recordRequest(request, 200);
    writeJson(response, 200, { count: captures.length, ...paginate(captures, offset, limit) });
    return;
  }

  if (method === 'DELETE' && url.pathname === '/captures') {
    captures.length = 0;
    recordRequest(request, 204);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (method === 'GET' && url.pathname === '/requests') {
    recordRequest(request, 200);
    writeJson(response, 200, { count: requestLogs.length, ...paginate(requestLogs, offset, limit), stats: stats() });
    return;
  }

  if (method === 'DELETE' && url.pathname === '/requests') {
    requestLogs.length = 0;
    recordRequest(request, 204);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (method === 'POST' && url.pathname === '/webhook') {
    const rawBody = await readBody(request);
    captures.push({
      method,
      path: url.pathname,
      headers: request.headers,
      rawBody,
      parsedBody: parseJson(rawBody),
      timestamp: new Date().toISOString(),
    });
    recordRequest(request, 204);
    response.statusCode = 204;
    response.end();
    return;
  }

  recordRequest(request, 404);
  writeJson(response, 404, { error: 'not_found', path: url.pathname });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Smoke monitoring server listening on ${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
