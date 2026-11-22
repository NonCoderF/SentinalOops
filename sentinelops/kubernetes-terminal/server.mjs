import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? 8787);
const token = process.env.TERMINAL_TOKEN ?? 'local-terminal-token';
const workspace = process.env.TERMINAL_WORKSPACE ?? '/workspace';
const maxSessions = Number(process.env.TERMINAL_MAX_SESSIONS ?? 4);
let sessions = 0;

const testServiceProxyEnabled = process.env.TERMINAL_TEST_SERVICE_PROXY !== 'false';
const testServiceProxyPort = Number(process.env.TERMINAL_TEST_SERVICE_PROXY_PORT ?? 8080);
const testServiceHost = process.env.TERMINAL_TEST_SERVICE_HOST ?? 'host.docker.internal';
const testServiceTargetPort = Number(process.env.TERMINAL_TEST_SERVICE_TARGET_PORT ?? 8080);

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ready', sessions, maxSessions }));
    return;
  }
  response.writeHead(404);
  response.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (supplied !== token || sessions >= maxSessions) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
});

wss.on('connection', (client) => {
  sessions += 1;
  const shell = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: workspace,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PS1: '\\[\\e[36m\\]sentinelops@k8s\\[\\e[0m\\]:\\w$ ' }
  });
  const cleanup = () => {
    try { shell.kill(); } catch { /* process already exited */ }
    sessions = Math.max(0, sessions - 1);
  };
  shell.onData((data) => { if (client.readyState === 1) client.send(data); });
  shell.onExit(() => { if (client.readyState === 1) client.close(1000, 'shell exited'); cleanup(); });
  client.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message?.type === 'exec' && typeof message.command === 'string') {
        const child = spawn('/bin/bash', ['-lc', message.command], {
          cwd: workspace,
          env: { ...process.env, ...(message.env && typeof message.env === 'object' ? message.env : {}) },
          stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stdout.on('data', (data) => { if (client.readyState === 1) client.send(data.toString()); });
        child.stderr.on('data', (data) => { if (client.readyState === 1) client.send(data.toString()); });
        child.on('close', (code, signal) => { if (client.readyState === 1) client.send(JSON.stringify({ type: 'exec-exit', code: code ?? 1, signal: signal ?? null })); });
      } else if (message?.type === 'input' && typeof message.data === 'string') shell.write(message.data);
      else if (message?.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) shell.resize(Math.max(20, Math.min(240, message.cols)), Math.max(5, Math.min(100, message.rows)));
    } catch {
      // The terminal protocol is JSON-only; ignore malformed frames.
    }
  });
  client.on('close', cleanup);
  client.on('error', cleanup);
});

server.listen(port, '0.0.0.0', () => console.log(`kubernetes-terminal listening on ${port}`));

if (testServiceProxyEnabled) {
  const proxy = http.createServer((request, response) => {
    const upstream = http.request({
      hostname: testServiceHost,
      port: testServiceTargetPort,
      path: request.url || '/',
      method: request.method,
      headers: { ...request.headers, host: `${testServiceHost}:${testServiceTargetPort}` },
      timeout: 5000
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Test Service gateway timed out')));
    upstream.on('error', (error) => {
      if (!response.headersSent) response.writeHead(503, { 'content-type': 'text/plain' });
      response.end(`Test Service unavailable: ${error.message}\n`);
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  proxy.listen(testServiceProxyPort, '127.0.0.1', () => {
    console.log(`test-service loopback proxy listening on ${testServiceProxyPort} -> ${testServiceHost}:${testServiceTargetPort}`);
  });
}
