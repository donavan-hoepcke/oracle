import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import { rawStreamService } from '../services/rawStreamService.js';
import { attachRawStreamSocket } from '../websocket/rawStreamSocket.js';
import { moderatorAlertService, type ModeratorPost } from '../services/moderatorAlertService.js';

function wireRawStream(server: Server) {
  const handle = attachRawStreamSocket(rawStreamService);
  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] === '/api/raw/stream') {
      handle.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });
}

describe('WS /api/raw/stream', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    rawStreamService.reset();
    const app = express();
    server = createServer(app);
    wireRawStream(server);
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
    wireRawStream(server);
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

describe('WS /api/raw/stream moderator-snapshot replay', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    rawStreamService.reset();
    const app = express();
    server = createServer(app);
    wireRawStream(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr && typeof addr !== 'string') port = addr.port;
    // Populate the moderator snapshot with today's prep, then bind so the
    // raw stream can read it on subsequent client connections.
    const post: ModeratorPost = {
      title: 'Pre Market Prep Note 5-7-2026',
      kind: 'pre_market_prep',
      author: 'Tim Bohen',
      postedAt: '2026-05-07T08:30:00.000Z',
      body: 'today watchlist...',
      signal: null,
      backups: [],
      symbols: [],
    };
    moderatorAlertService.ingestPosts([post]);
    rawStreamService.bindModeratorAlertService(moderatorAlertService);
    // Roll the buffer so the live emit from `bindModeratorAlertService`
    // can no longer be replayed (simulates the bot connecting mid-
    // afternoon after scanner_updates have rolled the buffer).
    for (let i = 0; i < 1100; i++) {
      rawStreamService.publish({ type: 'scanner_update', payload: { i } });
    }
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('pushes the moderator snapshot as mod_alert events on every fresh connection, regardless of buffer rollover', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/raw/stream`);
    const messages: { id: number; type: string; payload: { title?: string } }[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => ws.on('open', resolve));
    await new Promise((r) => setTimeout(r, 200));
    ws.close();

    const modAlerts = messages.filter((m) => m.type === 'mod_alert');
    // The bot should see today's prep even though the original live emit
    // is long since rolled out of the ring buffer.
    expect(modAlerts).toHaveLength(1);
    expect(modAlerts[0].id).toBe(0); // snapshot pushes use id=0
    expect(modAlerts[0].payload.title).toBe('Pre Market Prep Note 5-7-2026');
  });
});
