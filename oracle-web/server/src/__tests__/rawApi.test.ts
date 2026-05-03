import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { registerRawApi } from '../rawApi.js';

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

describe('GET /api/raw/scanner', () => {
  it('returns 200 with stocks array and timestamp', async () => {
    const res = await fetch(`${url}/api/raw/scanner`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ts: string; stocks: unknown[] };
    expect(Array.isArray(body.stocks)).toBe(true);
    expect(typeof body.ts).toBe('string');
    expect(new Date(body.ts).toString()).not.toBe('Invalid Date');
  });
});

describe('GET /api/raw/symbols/:sym', () => {
  it('returns 200 with symbol detail envelope for a valid ticker', async () => {
    const res = await fetch(`${url}/api/raw/symbols/AAPL`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ts: string; symbol: string; detail: unknown };
    expect(body.symbol).toBe('AAPL');
    expect(typeof body.ts).toBe('string');
    expect('detail' in body).toBe(true);
  });

  it('uppercases the symbol path param', async () => {
    const res = await fetch(`${url}/api/raw/symbols/aapl`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { symbol: string };
    expect(body.symbol).toBe('AAPL');
  });

  it('returns 400 for invalid symbols', async () => {
    const res = await fetch(`${url}/api/raw/symbols/!@%23%24`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/raw/regime', () => {
  it('returns 200 with snapshot field (possibly null) and timestamp', async () => {
    const res = await fetch(`${url}/api/raw/regime`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ts: string; snapshot: unknown };
    expect(typeof body.ts).toBe('string');
    expect('snapshot' in body).toBe(true);
  });
});
