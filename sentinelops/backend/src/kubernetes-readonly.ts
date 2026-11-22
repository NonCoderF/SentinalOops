import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';

export const readonlyCommands = ['cluster-info', 'list-clusters', 'get-nodes', 'get-pods'] as const;
export type ReadonlyCommand = typeof readonlyCommands[number] | 'docker-ps' | 'curl';
export type TerminalEvent = { type: 'start' | 'stdout' | 'stderr' | 'complete'; timestamp: string; data: Record<string, unknown> };
export type TerminalOperation = {
  id: string;
  command: ReadonlyCommand;
  executable: string;
  args: string[];
  displayCommand: string;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELED';
  startedAt: string;
  completedAt?: string;
  exitCode?: number | null;
  durationMs?: number;
  stdout: string;
  stderr: string;
};

type Subscriber = (event: TerminalEvent) => void;

const safeName = (value: string, fallback: string): string => /^[a-z0-9][a-z0-9.-]{0,62}$/i.test(value) ? value : fallback;

export class ReadonlyKubernetesCommandRunner {
  private readonly operations = new Map<string, TerminalOperation>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly canceled = new Set<string>();
  readonly context = safeName(process.env.KUBERNETES_CONTEXT?.trim() ?? '', 'kind-sentinelops-dev');
  readonly namespace = safeName(process.env.KUBERNETES_NAMESPACE?.trim() ?? '', 'sentinelops-test');

  list(): TerminalOperation[] {
    return [...this.operations.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
  }

  get(id: string): TerminalOperation | undefined { return this.operations.get(id); }

  subscribe(id: string, subscriber: Subscriber): () => void {
    const listeners = this.subscribers.get(id) ?? new Set<Subscriber>();
    listeners.add(subscriber);
    this.subscribers.set(id, listeners);
    return () => listeners.delete(subscriber);
  }

  start(command: typeof readonlyCommands[number]): TerminalOperation {
    return this.startSpec(command, this.spec(command));
  }

  startInteractive(commandLine: string): TerminalOperation {
    const parsed = this.parseInteractive(commandLine);
    if ('error' in parsed) throw new Error(parsed.error);
    return this.startSpec(parsed.command, parsed.spec);
  }

  cancel(id: string): boolean {
    const child = this.processes.get(id);
    const operation = this.operations.get(id);
    if (!child || !operation || operation.status !== 'RUNNING') return false;
    this.canceled.add(id);
    child.kill();
    return true;
  }

  private startSpec(command: ReadonlyCommand, spec: { executable: string; args: string[] }): TerminalOperation {
    const operation: TerminalOperation = {
      id: crypto.randomUUID(), command, executable: spec.executable, args: spec.args,
      displayCommand: [spec.executable, ...spec.args].join(' '), status: 'RUNNING',
      startedAt: new Date().toISOString(), stdout: '', stderr: ''
    };
    this.operations.set(operation.id, operation);
    this.emit(operation.id, { type: 'start', timestamp: operation.startedAt, data: { operation } });
    const child = spawn(spec.executable, spec.args, { windowsHide: true, shell: false });
    this.processes.set(operation.id, child);
    this.pipe(child, operation, 'stdout');
    this.pipe(child, operation, 'stderr');
    child.once('error', (error) => {
      // On Windows (and in some container runtimes) a process that cannot be
      // launched can later close with the synthetic code -2. That is not a
      // command exit code and used to make the terminal report a misleading
      // "exit -2". Preserve the real launch error and expose no exit code.
      operation.exitCode = null;
      const message = `Process launch failed: ${error.message}`;
      operation.stderr += `${message}\n`;
      this.emit(operation.id, { type: 'stderr', timestamp: new Date().toISOString(), data: { text: `${message}\n` } });
    });
    child.once('close', (code) => {
      operation.exitCode = code === -2 ? null : code;
      operation.completedAt = new Date().toISOString();
      operation.durationMs = Date.parse(operation.completedAt) - Date.parse(operation.startedAt);
      operation.status = this.canceled.has(operation.id) ? 'CANCELED' : code === 0 ? 'SUCCESS' : 'FAILED';
      this.processes.delete(operation.id);
      this.canceled.delete(operation.id);
      this.emit(operation.id, { type: 'complete', timestamp: operation.completedAt, data: { operation } });
      this.subscribers.delete(operation.id);
    });
    return operation;
  }

  private pipe(child: ChildProcessWithoutNullStreams, operation: TerminalOperation, stream: 'stdout' | 'stderr'): void {
    child[stream].setEncoding('utf8');
    child[stream].on('data', (chunk: string) => {
      operation[stream] += chunk;
      this.emit(operation.id, { type: stream, timestamp: new Date().toISOString(), data: { text: chunk } });
    });
  }

  private emit(id: string, event: TerminalEvent): void {
    for (const subscriber of this.subscribers.get(id) ?? []) {
      try { subscriber(event); } catch { /* disconnected terminal client */ }
    }
  }

  private spec(command: ReadonlyCommand): { executable: string; args: string[] } {
    switch (command) {
      case 'cluster-info': return { executable: 'kubectl', args: ['--context', this.context, 'cluster-info'] };
      case 'list-clusters': return { executable: 'kind', args: ['get', 'clusters'] };
      case 'get-nodes': return { executable: 'kubectl', args: ['--context', this.context, 'get', 'nodes', '-o', 'wide'] };
      case 'get-pods': return { executable: 'kubectl', args: ['--context', this.context, '-n', this.namespace, 'get', 'pods', '-o', 'wide'] };
      default: throw new Error('Interactive command specifications must provide their own validated arguments');
    }
  }

  private parseInteractive(line: string): { command: ReadonlyCommand; spec: { executable: string; args: string[] } } | { error: string } {
    const input = line.trim();
    if (!input || input.length > 500) return { error: 'Enter a supported read-only command.' };
    const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? [];
    if (tokens.length === 3 && tokens[0] === 'kind' && tokens[1] === 'get' && tokens[2] === 'clusters') return { command: 'list-clusters', spec: this.spec('list-clusters') };
    if (tokens[0] === 'docker' && tokens.length === 2 && tokens[1] === 'ps') return { command: 'docker-ps', spec: { executable: 'docker', args: ['ps'] } };
    if (tokens[0] === 'curl' || tokens[0] === 'curl.exe') {
      if (tokens.length !== 3 || tokens[1] !== '-i') return { error: 'curl is restricted to: curl -i http://localhost:8080/<path>' };
      let target: URL;
      try { target = new URL(tokens[2]); } catch { return { error: 'curl target must be a valid URL' }; }
      if (!['http:', 'https:'].includes(target.protocol) || !['localhost', '127.0.0.1', 'host.docker.internal'].includes(target.hostname) || target.port !== '8080' || target.username || target.password || target.search || target.hash) return { error: 'curl is restricted to the configured Test Service on localhost:8080' };
      return { command: 'curl', spec: { executable: process.platform === 'win32' ? 'curl.exe' : 'curl', args: ['-i', '--max-time', '5', '--noproxy', '*', target.toString()] } };
    }
    if (tokens[0] !== 'kubectl') return { error: 'Only approved kubectl, kind, docker, and curl read-only commands are supported.' };
    if (tokens.length === 2 && tokens[1] === 'cluster-info') return { command: 'cluster-info', spec: this.spec('cluster-info') };
    if (tokens.length === 3 && tokens[1] === 'get' && tokens[2] === 'nodes') return { command: 'get-nodes', spec: this.spec('get-nodes') };
    if (tokens.length === 4 && tokens[1] === 'get' && tokens[2] === 'nodes' && tokens[3] === '-o') return { error: 'Use: kubectl get nodes -o wide' };
    if (tokens.length === 5 && tokens[1] === 'get' && tokens[2] === 'nodes' && tokens[3] === '-o' && tokens[4] === 'wide') return { command: 'get-nodes', spec: this.spec('get-nodes') };
    if (tokens.length === 7 && tokens[1] === '-n' && tokens[2] === this.namespace && tokens[3] === 'get' && tokens[4] === 'pods' && tokens[5] === '-o' && tokens[6] === 'wide') return { command: 'get-pods', spec: this.spec('get-pods') };
    if (tokens.length === 4 && tokens[1] === '--context' && tokens[2] === this.context && tokens[3] === 'cluster-info') return { command: 'cluster-info', spec: this.spec('cluster-info') };
    if (tokens.length === 6 && tokens[1] === '--context' && tokens[2] === this.context && tokens[3] === 'get' && tokens[4] === 'nodes' && tokens[5] === '-o') return { error: 'Use: kubectl --context <context> get nodes -o wide' };
    if (tokens.length === 7 && tokens[1] === '--context' && tokens[2] === this.context && tokens[3] === 'get' && tokens[4] === 'nodes' && tokens[5] === '-o' && tokens[6] === 'wide') return { command: 'get-nodes', spec: this.spec('get-nodes') };
    if (tokens.length === 8 && tokens[1] === '--context' && tokens[2] === this.context && tokens[3] === '-n' && tokens[4] === this.namespace && tokens[5] === 'get' && tokens[6] === 'pods' && tokens[7] === '-o') return { error: 'Use: kubectl --context <context> -n <namespace> get pods -o wide' };
    if (tokens.length === 9 && tokens[1] === '--context' && tokens[2] === this.context && tokens[3] === '-n' && tokens[4] === this.namespace && tokens[5] === 'get' && tokens[6] === 'pods' && tokens[7] === '-o' && tokens[8] === 'wide') return { command: 'get-pods', spec: this.spec('get-pods') };
    return { error: `Unsupported command. Context must be ${this.context} and namespace must be ${this.namespace}.` };
  }
}
