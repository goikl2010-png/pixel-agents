/**
 * Integration tests for the Vite dev server asset endpoints.
 *
 * Verifies that `browserMock.ts` can reach all asset JSON endpoints both at
 * the root path (base: '/') and under a subpath (base: '/sub/'), matching
 * how `import.meta.env.BASE_URL` constructs fetch URLs at runtime.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ViteDevServer } from 'vite';
import { createServer } from 'vite';
import { test } from 'vitest';

import type { AssetIndex, CatalogEntry } from '../../core/src/assets/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEST_HOST = '127.0.0.1';

interface RunningDevServer {
  vite: ViteDevServer;
  httpServer: http.Server;
}

async function startDevServer(base: string, port = 0): Promise<RunningDevServer> {
  const vite = await createServer({
    configFile: path.resolve(root, 'vite.config.ts'),
    base,
    server: { middlewareMode: true },
    appType: 'spa',
    logLevel: 'silent',
  });
  const httpServer = http.createServer(vite.middlewares);
  const server = { vite, httpServer };

  try {
    await listen(httpServer, port);
    serverUrl(server);
    return server;
  } catch (error) {
    if (httpServer.listening) {
      await closeNetServer(httpServer);
    }
    await vite.close();
    throw error;
  }
}

function serverUrl(server: RunningDevServer): string {
  const addr = server.httpServer.address();
  if (typeof addr !== 'object' || addr === null || !server.httpServer.listening) {
    throw new Error('Vite test server did not establish a listening TCP address');
  }
  return `http://${TEST_HOST}:${addr.port.toString()}`;
}

async function closeServer(server: RunningDevServer): Promise<void> {
  try {
    await closeNetServer(server.httpServer);
  } finally {
    await server.vite.close();
  }
  assert.equal(server.httpServer.listening, false, 'Vite test server should release its port');
}

async function listen(server: net.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, TEST_HOST, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function closeNetServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function assetUrl(baseUrl: string, basePath: string, relPath: string): string {
  return `${baseUrl}${basePath}assets/${relPath}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET ${url} returned ${res.status.toString()}`);
  return res.json() as Promise<T>;
}

async function assertUrlOk(url: string): Promise<void> {
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET ${url} returned ${res.status.toString()}`);
}

function indexedPath(kind: 'characters' | 'floors' | 'walls', relPath: string): string {
  return relPath.startsWith(`${kind}/`) ? relPath : `${kind}/${relPath}`;
}

async function verifyAssetUrls(baseUrl: string, basePath: string): Promise<void> {
  const assetIndex = await fetchJson<AssetIndex>(assetUrl(baseUrl, basePath, 'asset-index.json'));
  const catalog = await fetchJson<CatalogEntry[]>(
    assetUrl(baseUrl, basePath, 'furniture-catalog.json'),
  );

  await assertUrlOk(assetUrl(baseUrl, basePath, 'decoded/characters.json'));
  await assertUrlOk(assetUrl(baseUrl, basePath, 'decoded/floors.json'));
  await assertUrlOk(assetUrl(baseUrl, basePath, 'decoded/walls.json'));
  await assertUrlOk(assetUrl(baseUrl, basePath, 'decoded/furniture.json'));

  assert.ok(assetIndex.floors.length > 0, 'floors index should not be empty');
  assert.ok(assetIndex.walls.length > 0, 'walls index should not be empty');
  assert.ok(assetIndex.characters.length > 0, 'characters index should not be empty');
  assert.ok(catalog.length > 0, 'furniture catalog should not be empty');

  await assertUrlOk(assetUrl(baseUrl, basePath, indexedPath('floors', assetIndex.floors[0])));
  await assertUrlOk(assetUrl(baseUrl, basePath, indexedPath('walls', assetIndex.walls[0])));
  await assertUrlOk(
    assetUrl(baseUrl, basePath, indexedPath('characters', assetIndex.characters[0])),
  );
  await assertUrlOk(assetUrl(baseUrl, basePath, catalog[0].furniturePath));

  if (assetIndex.defaultLayout) {
    await assertUrlOk(assetUrl(baseUrl, basePath, assetIndex.defaultLayout));
  }
}

test('asset-index.json is accessible without a subpath (base: /)', async () => {
  const server = await startDevServer('/');
  try {
    await verifyAssetUrls(serverUrl(server), '/');
  } finally {
    await closeServer(server);
  }
});

test('asset-index.json is accessible with a subpath (base: /sub/)', async () => {
  const server = await startDevServer('/sub/');
  try {
    await verifyAssetUrls(serverUrl(server), '/sub/');
  } finally {
    await closeServer(server);
  }
});

test('fails clearly when the requested port is already owned', async () => {
  const owner = net.createServer();
  const port = await listen(owner);

  try {
    await assert.rejects(startDevServer('/', port), /EADDRINUSE|address already in use/i);
  } finally {
    await closeNetServer(owner);
  }
});

test('fails clearly when no listening address is available', () => {
  const httpServer = http.createServer();
  assert.throws(
    () => serverUrl({ vite: {} as ViteDevServer, httpServer }),
    /did not establish a listening TCP address/,
  );
});
