import http from 'node:http';

const port = Number(process.env.PORT ?? 8090);
const token = process.env.RECOVERY_CONTROLLER_TOKEN ?? '';
const project = process.env.ALLOWED_COMPOSE_PROJECT ?? 'sentinelops';
const allowedService = process.env.ALLOWED_RECOVERY_SERVICE?.trim() ?? '';
const allowedImage = process.env.ALLOWED_RECOVERY_IMAGE?.trim() ?? '';

type Action = 'START_CONTAINER' | 'RESTART_CONTAINER' | 'CHECK_CONTAINER_STATUS' | 'STOP_CONTAINER';

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function authorized(request: http.IncomingMessage): boolean {
  return Boolean(token) && request.headers.authorization === `Bearer ${token}`;
}

function dockerRequest(path: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: '/var/run/docker.sock', path, method, timeout: 8000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 500, body }));
    });
    request.on('timeout', () => request.destroy(new Error('Docker Engine request timed out')));
    request.on('error', reject);
    request.end();
  });
}

async function inspectAllowedContainer(): Promise<{ id: string; state: string; health?: string }> {
  const listed = await dockerRequest('/containers/json?all=1');
  if (listed.status !== 200) throw new Error('Docker Engine container listing failed');
  const candidates = JSON.parse(listed.body) as Array<{ Id?: string; Image?: string; Labels?: Record<string, string>; State?: string; Status?: string }>;
  const candidate = candidates.find((item) => item.Labels?.['com.docker.compose.service'] === allowedService && item.Labels?.['com.docker.compose.project'] === project);
  if (!candidate?.Id) throw new Error('Configured recovery container was not found');
  const result = await dockerRequest(`/containers/${candidate.Id}/json`);
  if (result.status !== 200) throw new Error('Configured recovery container inspection failed');
  const data = JSON.parse(result.body) as { Id?: string; Config?: { Image?: string; Labels?: Record<string, string> }; State?: { Status?: string; Health?: { Status?: string } } };
  const labels = data.Config?.Labels ?? {};
  if (!allowedService || !allowedImage || labels['com.docker.compose.service'] !== allowedService || labels['com.docker.compose.project'] !== project || data.Config?.Image !== allowedImage) {
    throw new Error('Container identity did not match the recovery allowlist');
  }
  if (!data.Id || !data.State?.Status) throw new Error('Docker returned incomplete container identity');
  return { id: data.Id, state: data.State.Status, health: data.State.Health?.Status };
}

async function perform(action: Action): Promise<Record<string, unknown>> {
  const before = await inspectAllowedContainer();
  if (action === 'CHECK_CONTAINER_STATUS') return { action, containerId: before.id.slice(0, 12), state: before.state, health: before.health ?? 'unavailable' };
  const endpoint = action === 'START_CONTAINER' ? `/containers/${before.id}/start` : action === 'STOP_CONTAINER' ? `/containers/${before.id}/stop?t=10` : `/containers/${before.id}/restart?t=10`;
  const result = await dockerRequest(endpoint, 'POST');
  if (![204, 304].includes(result.status)) throw new Error(`Docker ${action} failed with status ${result.status}`);
  const after = await inspectAllowedContainer();
  return { action, containerId: after.id.slice(0, 12), state: after.state, health: after.health ?? 'unavailable' };
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok', service: 'recovery-controller' });
  if (!authorized(request)) return json(response, 401, { error: 'Invalid recovery controller authorization' });
  if (request.method === 'GET' && request.url === '/v1/container') {
    try { return json(response, 200, await inspectAllowedContainer()); } catch (error) { return json(response, 503, { error: error instanceof Error ? error.message : 'Container inspection failed' }); }
  }
  if (request.method !== 'POST' || request.url !== '/v1/recovery') return json(response, 404, { error: 'Not found' });
  let body = '';
  request.on('data', (chunk) => { body += chunk; if (body.length > 4096) request.destroy(new Error('Request too large')); });
  request.on('end', async () => {
    try {
      const parsed = JSON.parse(body) as { service?: unknown; action?: unknown };
      if (parsed.service !== allowedService || !['START_CONTAINER', 'RESTART_CONTAINER', 'CHECK_CONTAINER_STATUS', 'STOP_CONTAINER'].includes(String(parsed.action))) return json(response, 400, { error: 'Only the configured recovery service and actions are permitted' });
      return json(response, 200, await perform(parsed.action as Action));
    } catch (error) { return json(response, 502, { error: error instanceof Error ? error.message : 'Recovery controller failed' }); }
  });
});

server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ service: 'recovery-controller', port, project, allowedService })));
