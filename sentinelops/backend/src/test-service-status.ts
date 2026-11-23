import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

type ContainerState = { Status?: string; Running?: boolean; StartedAt?: string };
type CommandResult = { code: number | null; stdout: string; stderr: string };

function runDocker(args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { windowsHide: true, shell: false });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function readTestServiceStatus(options: { containerName?: string; target?: string } = {}) {
  const checkedAt = new Date().toISOString();
  const containerName = options.containerName ?? process.env.TEST_SERVICE_CONTAINER ?? 'sentinelops-test-service';
  const defaultHost = existsSync('/.dockerenv') ? 'host.docker.internal' : '127.0.0.1';
  const target = options.target ?? process.env.TEST_SERVICE_URL ?? `http://${defaultHost}:8080/api/health`;
  const inspected = await runDocker(['inspect', '--format={{json .State}}', containerName]);
  let container: 'RUNNING' | 'STOPPED' | 'NOT_FOUND' | 'UNKNOWN' = 'UNKNOWN';
  if (inspected.code === 0) {
    try { const state = JSON.parse(inspected.stdout.trim()) as ContainerState; container = state.Running ? 'RUNNING' : 'STOPPED'; } catch { container = 'UNKNOWN'; }
  } else if (/no such object|not found/i.test(inspected.stderr)) container = 'NOT_FOUND';

  const started = Date.now();
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(2000), cache: 'no-store' });
    return { container, api: response.ok ? 'REACHABLE' : 'UNREACHABLE', statusCode: response.status, latencyMs: Date.now() - started, checkedAt, target, error: null };
  } catch (error) {
    return { container, api: 'UNREACHABLE', statusCode: null, latencyMs: Date.now() - started, checkedAt, target, error: error instanceof Error ? error.message : 'Health check failed' };
  }
}
