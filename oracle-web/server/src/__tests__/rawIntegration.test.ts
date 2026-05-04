import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import { rawStreamService } from '../services/rawStreamService.js';
import { messageService } from '../services/messageService.js';
import { attachRawStreamSocket } from '../websocket/rawStreamSocket.js';
import { registerRawApi } from '../rawApi.js';

describe('raw API + WS end-to-end', () => {
  let server: Server;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    rawStreamService.reset();
    const app = express();
    app.use(express.json());
    registerRawApi(app);
    server = createServer(app);
    const handle = attachRawStreamSocket(rawStreamService);
    server.on('upgrade', (req, socket, head) => {
      if ((req.url || '').split('?')[0] === '/api/raw/stream') {
        handle.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
    rawStreamService.bindMessageService(messageService);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr && typeof addr !== 'string') {
      port = addr.port;
      baseUrl = `http://127.0.0.1:${port}`;
    }
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('produces a message event on WS when messageService.ingest is called', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/raw/stream`);
    const messages: { type: string }[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => ws.on('open', resolve));

    messageService.ingest({ text: 'AAPL test integration' });
    await new Promise((r) => setTimeout(r, 100));
    ws.close();

    expect(messages.some((m) => m.type === 'message')).toBe(true);
  });

  it('GET /api/raw/scanner returns a valid envelope alongside the WS', async () => {
    const res = await fetch(`${baseUrl}/api/raw/scanner`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ts: string; stocks: unknown[] };
    expect(Array.isArray(body.stocks)).toBe(true);
    expect(typeof body.ts).toBe('string');
  });

  it('GET /api/raw/regime returns the snapshot envelope', async () => {
    const res = await fetch(`${baseUrl}/api/raw/regime`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ts: string; snapshot: unknown };
    expect('snapshot' in body).toBe(true);
  });
});
