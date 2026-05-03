import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { RawStreamService, RawStreamEvent } from '../services/rawStreamService.js';

/**
 * Attaches a WebSocket server at `/api/raw/stream` that fans out all events
 * from the given RawStreamService to connected clients.
 *
 * Honors the `Last-Event-ID` HTTP header on connection: any buffered events
 * with `id > Last-Event-ID` are replayed before live forwarding begins.
 * Localhost-only by convention (oracle-web binds to 127.0.0.1).
 */
export function attachRawStreamSocket(
  server: Server,
  stream: RawStreamService,
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/api/raw/stream' });

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

  return wss;
}
