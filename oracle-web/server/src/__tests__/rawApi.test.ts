import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { registerRawApi } from '../rawApi.js';

describe('GET /api/raw/scanner', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerRawApi(app);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr && typeof addr !== 'string') url = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('returns 200 with stocks array and timestamp', async () => {
    const res = await fetch(`${url}/api/raw/scanner`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ts: string; stocks: unknown[] };
    expect(Array.isArray(body.stocks)).toBe(true);
    expect(typeof body.ts).toBe('string');
    expect(new Date(body.ts).toString()).not.toBe('Invalid Date');
  });
});
