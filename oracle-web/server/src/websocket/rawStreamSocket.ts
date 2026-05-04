import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { RawStreamService, RawStreamEvent } from '../services/rawStreamService.js';

/**
 * Returned by attachRawStreamSocket. Holds the WebSocketServer plus a
 * handleUpgrade hook that the HTTP server's `upgrade` listener calls when a
 * client connects to /api/raw/stream.
 */
export interface RawStreamSocketHandle {
  wss: WebSocketServer;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/**
 * Attaches a WebSocket server for /api/raw/stream that fans out all events
 * from the given RawStreamService to connected clients.
 *
 * Honors the `Last-Event-ID` HTTP header on connection: any buffered events
 * with `id > Last-Event-ID` are replayed before live forwarding begins.
 * Localhost-only by convention (oracle-web binds to 127.0.0.1).
 *
 * Path routing is the caller's responsibility: this returns `noServer: true`
 * so the index.ts upgrade router can dispatch by URL alongside other WS
 * endpoints (e.g. /ws). Without this, the `ws` library's default behavior
 * causes the first registered WebSocketServer to reject upgrades for paths
 * it doesn't own with HTTP 400, before any other handler can claim them.
 */
export function attachRawStreamSocket(stream: RawStreamService): RawStreamSocketHandle {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, req) => {
    const sinceHeader = req.headers['last-event-id'];
    const sinceId = typeof sinceHeader === 'string' ? Number.parseInt(sinceHeader, 10) : NaN;
    if (Number.isFinite(sinceId)) {
      for (const evt of stream.replaySince(sinceId)) {
        ws.send(JSON.stringify(evt));
      }
    }

    const unsubscribe = stream.subscribe((evt: RawStreamEvent) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(evt));
      }
    });

    ws.on('close', () => unsubscribe());
    ws.on('error', () => unsubscribe());
  });

  return {
    wss,
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    },
  };
}
