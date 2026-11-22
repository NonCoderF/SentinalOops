import WebSocket from 'ws';

type BrowserSocket = { readyState: number; send(data: string | Buffer): void; close(code?: number, reason?: string): void; on(event: string, listener: (...args: any[]) => void): void };

const OPEN = 1;

export function registerTerminalBridge(app: any, options: { authEnabled: boolean; adminToken: string; terminalUrl?: string; terminalToken: string; }) {
  const terminalUrl = options.terminalUrl ?? 'ws://kubernetes-terminal:8787/terminal';

  app.get('/api/kubernetes/terminal', { websocket: true }, (browser: BrowserSocket, request: any) => {
    const supplied = typeof request.query?.token === 'string' ? request.query.token : '';
    if (options.authEnabled && supplied !== options.adminToken) {
      browser.close(1008, 'Authentication required');
      return;
    }

    const upstream = new WebSocket(terminalUrl, { headers: { Authorization: `Bearer ${options.terminalToken}` } });
    let closed = false;
    const closeBoth = (code = 1000, reason = 'closed') => {
      if (closed) return;
      closed = true;
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(code, reason);
      if (browser.readyState === OPEN) browser.close(code, reason);
    };

    upstream.on('open', () => {
      if (browser.readyState === OPEN) browser.send(JSON.stringify({ type: 'bridge', status: 'connected' }));
    });
    upstream.on('message', (data: WebSocket.RawData) => {
      if (browser.readyState === OPEN) browser.send(data.toString());
    });
    upstream.on('error', () => {
      if (browser.readyState === OPEN) browser.send('\r\n[terminal service unavailable]\r\n');
      closeBoth(1011, 'Terminal service unavailable');
    });
    upstream.on('close', () => closeBoth(1000, 'terminal service closed'));
    browser.on('message', (data: Buffer | string) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
    });
    browser.on('close', () => closeBoth());
    browser.on('error', () => closeBoth(1011, 'browser connection error'));
  });
}
