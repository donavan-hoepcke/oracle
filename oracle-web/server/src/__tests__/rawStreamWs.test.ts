import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import { rawStreamService } from '../services/rawStreamService.js';
import { attachRawStreamSocket } from '../websocket/rawStreamSocket.js';

describe('WS /api/raw/stream', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    rawStreamService.reset();
    const app = express();
    server = createServer(app);
    attachRawStreamSocket(server, rawStreamService);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr && typeof addr !== 'string') port = addr.port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('delivers published events to a connected client', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/raw/stream`);
    const messages: { type: string; id: number; payload: { text: string } }[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

    await new Promise<void>((resolve) => ws.on('open', resolve));
    rawStreamService.publish({ type: 'message', payload: { text: 'hello' } });
    await new Promise((r) => setTimeout(r, 50));
    ws.close();

    expect(messages.length).toBe(1);
    const evt = messages[0];
    expect(evt.type).toBe('message');
    expect(evt.id).toBeGreaterThan(0);
    expect(evt.payload.text).toBe('hello');
  });
});
