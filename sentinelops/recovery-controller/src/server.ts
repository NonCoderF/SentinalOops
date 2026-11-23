import http from 'node:http';

const port = Number(process.env.PORT ?? 8090);
const token = process.env.RECOVERY_CONTROLLER_TOKEN ?? '';
const project = process.env.ALLOWED_COMPOSE_PROJECT ?? 'sentinelops';
const allowedServices = new Set((process.env.ALLOWED_RECOVERY_SERVICES ?? process.env.ALLOWED_RECOVERY_SERVICE ?? '').split(',').map((value) => value.trim()).filter(Boolean));
const allowedService = [...allowedServices][0] ?? '';
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

async function inspectAllowedContainer(service = allowedService, requested: { containerId?: string; containerName?: string } = {}): Promise<{ id: string; state: string; health?: string; name?: string }> {
  if (!allowedServices.has(service)) throw new Error('Requested recovery service is not allowlisted');
  const listed = await dockerRequest('/containers/json?all=1');
  if (listed.status !== 200) throw new Error('Docker Engine container listing failed');
  const candidates = JSON.parse(listed.body) as Array<{ Id?: string; Image?: string; Names?: string[]; Labels?: Record<string, string>; State?: string; Status?: string }>;
  const candidate = candidates.find((item) => item.Labels?.['com.docker.compose.service'] === service && item.Labels?.['com.docker.compose.project'] === project && (!requested.containerId || item.Id === requested.containerId) && (!requested.containerName || (item.Names ?? []).some((name) => name.replace(/^\//, '') === requested.containerName)));
  if (!candidate?.Id) throw new Error('Configured recovery container was not found');
  const result = await dockerRequest(`/containers/${candidate.Id}/json`);
  if (result.status !== 200) throw new Error('Configured recovery container inspection failed');
  const data = JSON.parse(result.body) as { Id?: string; Config?: { Image?: string; Labels?: Record<string, string> }; State?: { Status?: string; Health?: { Status?: string } } };
  const labels = data.Config?.Labels ?? {};
  if (!allowedServices.has(String(labels['com.docker.compose.service'])) || labels['com.docker.compose.project'] !== project || (service === allowedService && allowedImage && data.Config?.Image !== allowedImage)) {
    throw new Error('Container identity did not match the recovery allowlist');
  }
  if (!data.Id || !data.State?.Status) throw new Error('Docker returned incomplete container identity');
  return { id: data.Id, state: data.State.Status, health: data.State.Health?.Status, name: service };
}

async function perform(action: Action, service: string, requested: { containerId?: string; containerName?: string } = {}): Promise<Record<string, unknown>> {
  const before = await inspectAllowedContainer(service, requested);
  if (action === 'CHECK_CONTAINER_STATUS') return { action, containerId: before.id.slice(0, 12), state: before.state, health: before.health ?? 'unavailable' };
  const endpoint = action === 'START_CONTAINER' ? `/containers/${before.id}/start` : action === 'STOP_CONTAINER' ? `/containers/${before.id}/stop?t=10` : `/containers/${before.id}/restart?t=10`;
  const result = await dockerRequest(endpoint, 'POST');
  if (![204, 304].includes(result.status)) throw new Error(`Docker ${action} failed with status ${result.status}`);
  const after = await inspectAllowedContainer(service, requested);
  return { action, containerId: after.id.slice(0, 12), state: after.state, health: after.health ?? 'unavailable' };
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok', service: 'recovery-controller' });
  if (!authorized(request)) return json(response, 401, { error: 'Invalid recovery controller authorization' });
  if (request.method === 'GET' && request.url === '/v1/containers') {
    try {
      const listed = await dockerRequest('/containers/json?all=1');
      if (listed.status !== 200) throw new Error('Docker Engine container listing failed');
      const containers = (JSON.parse(listed.body) as Array<{ Id?: string; Names?: string[]; Image?: string; State?: string; Status?: string; Labels?: Record<string,string> }>).filter((item) => item.Id && item.Labels?.['com.docker.compose.project'] === project && allowedServices.has(String(item.Labels?.['com.docker.compose.service']))).map((item) => ({ id: item.Id, name: (item.Names ?? [])[0]?.replace(/^\//, '') ?? item.Labels?.['com.docker.compose.service'], service: item.Labels?.['com.docker.compose.service'], image: item.Image, state: item.State, status: item.Status }));
      return json(response, 200, { containers });
    } catch (error) { return json(response, 503, { error: error instanceof Error ? error.message : 'Container discovery failed' }); }
  }
  if (request.method !== 'POST' || request.url !== '/v1/recovery') return json(response, 404, { error: 'Not found' });
  let body = '';
  request.on('data', (chunk) => { body += chunk; if (body.length > 4096) request.destroy(new Error('Request too large')); });
  request.on('end', async () => {
    try {
      const parsed = JSON.parse(body) as { service?: unknown; action?: unknown; containerId?: unknown; containerName?: unknown };
      const service = typeof parsed.service === 'string' ? parsed.service : '';
      if (!allowedServices.has(service) || !['START_CONTAINER', 'RESTART_CONTAINER', 'CHECK_CONTAINER_STATUS', 'STOP_CONTAINER'].includes(String(parsed.action))) return json(response, 400, { error: 'Only configured recovery services and actions are permitted' });
      return json(response, 200, await perform(parsed.action as Action, service, { containerId: typeof parsed.containerId === 'string' ? parsed.containerId : undefined, containerName: typeof parsed.containerName === 'string' ? parsed.containerName : undefined }));
    } catch (error) { return json(response, 502, { error: error instanceof Error ? error.message : 'Recovery controller failed' }); }
  });
});

server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ service: 'recovery-controller', port, project, allowedService })));
