import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import { attachRawStreamSocket } from '../websocket/rawStreamSocket.js';
import type { RawStreamService } from '../services/rawStreamService.js';

/**
 * Regression test for HTTP 400 on /api/raw/stream when multiple WebSocketServer
 * instances share an HTTP server. Verifies that the upgrade router accepts
 * /api/raw/stream and rejects unknown paths cleanly.
 */

function makeStubStream(): RawStreamService {
  return {
    replaySince: () => [],
    subscribe: () => () => {},
  } as unknown as RawStreamService;
}

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer();
  // Mimic the production wiring: one upgrade router dispatching by path.
  const rawHandle = attachRawStreamSocket(makeStubStream());
  // A second WSS that owns /ws — present so the test exercises the same
  // multi-WSS scenario that produced the original bug.
  const { WebSocketServer } = await import('ws');
  const stubWs = new WebSocketServer({ noServer: true });
  stubWs.on('connection', (ws) => {
    ws.send(JSON.stringify({ ok: true }));
  });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/ws') {
      stubWs.handleUpgrade(req, socket, head, (ws) => stubWs.emit('connection', ws, req));
    } else if (path === '/api/raw/stream') {
      rawHandle.handleUpgrade(req, socket, head);
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr && typeof addr !== 'string') port = addr.port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function connectWs(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`unexpected-response status=${res.statusCode}`));
    });
  });
}

describe('WebSocket upgrade routing', () => {
  it('accepts /api/raw/stream upgrades', async () => {
    const ws = await connectWs('/api/raw/stream');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('accepts /ws upgrades alongside /api/raw/stream', async () => {
    const ws = await connectWs('/ws');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects unknown WS paths with HTTP 404', async () => {
    await expect(connectWs('/nope')).rejects.toThrow(/404/);
  });

  it('honors Last-Event-ID header on /api/raw/stream', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/raw/stream`, {
      headers: { 'Last-Event-ID': '42' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
