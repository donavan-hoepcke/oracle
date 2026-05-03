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

describe('WS /api/raw/stream resume', () => {
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
    // Pre-populate the buffer so a connecting client can resume from the middle.
    rawStreamService.publish({ type: 'message', payload: { i: 1 } });
    rawStreamService.publish({ type: 'message', payload: { i: 2 } });
    rawStreamService.publish({ type: 'message', payload: { i: 3 } });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('replays events with id > Last-Event-ID on connect', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/raw/stream`, {
      headers: { 'last-event-id': '1' },
    });
    const messages: { id: number; payload: { i: number } }[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => ws.on('open', resolve));
    await new Promise((r) => setTimeout(r, 100));
    ws.close();

    expect(messages.map((m) => m.id)).toEqual([2, 3]);
  });

  it('delivers all buffered events when no Last-Event-ID is provided', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/raw/stream`);
    const messages: { id: number }[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => ws.on('open', resolve));
    await new Promise((r) => setTimeout(r, 100));
    ws.close();

    // Without a sinceId header, we should not get a replay — only live events from now on.
    expect(messages).toEqual([]);
  });
});
