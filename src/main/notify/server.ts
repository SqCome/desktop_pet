// Local HTTP server that accepts POST /notify from the bridge script.
//
// Design notes:
//  - listen(0, '127.0.0.1') so the OS picks a free port. We write the
//    resolved port to `portFile` so the bridge script can read it.
//  - Always respond 200 OK FIRST, then read the body in the background.
//    Reading before responding adds RTT that Claude Code's hook timeout
//    (default 15s) doesn't need to pay.
//  - Bind to 127.0.0.1 only — never 0.0.0.0. Local-only by design.
import * as http from 'node:http';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { NotifyBus } from './bus';
import { normalizeHook } from './normalize';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export class NotifyServer {
  private server: http.Server | null = null;
  private _port: number | null = null;

  constructor(private opts: { portFile: string; bus: NotifyBus }) {}

  get port(): number | null {
    return this._port;
  }

  start(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/notify') {
          this.handleNotify(req, res);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        this._port = addr.port;
        try {
          fs.writeFileSync(this.opts.portFile, String(addr.port), 'utf-8');
        } catch (err) {
          console.warn('[notify] failed to write port file:', err);
        }
        console.log(`[notify] server listening on 127.0.0.1:${addr.port}`);
        this.server = server;
        resolve({ port: addr.port });
      });
    });
  }

  stop(): Promise<void> {
    const s = this.server;
    if (!s) return Promise.resolve();
    this.server = null;
    this._port = null;
    return new Promise((resolve) => {
      s.close(() => {
        try {
          fs.unlinkSync(this.opts.portFile);
        } catch {
          /* file may already be gone — ignore */
        }
        console.log('[notify] server stopped, port file removed');
        resolve();
      });
    });
  }

  private handleNotify(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Reply 200 first; read body in the background. See file header.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    readBody(req)
      .then((buf) => {
        let raw: unknown;
        try {
          raw = JSON.parse(buf);
        } catch (err) {
          console.warn('[notify] bad JSON payload:', err);
          return;
        }
        const payload = normalizeHook(raw);
        if (!payload) {
          // Not an event we surface (e.g. PreToolUse). Quietly dropped.
          return;
        }
        this.opts.bus.dispatch(payload);
      })
      .catch((err) => console.warn('[notify] readBody error:', err));
  }
}