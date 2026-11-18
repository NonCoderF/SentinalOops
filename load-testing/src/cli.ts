import {createServer, type Server} from 'node:http';
import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
import client from 'prom-client';

const {Counter, Gauge, Histogram, Registry} = client;

type Result = 'success' | 'failure' | 'stopped';
type Options = {
    command: string;
    total: number;
    vus: number;
    rate: number;
    durationSeconds?: number;
    target: string;
    targets: string[];
    timeoutMs: number;
    failureThreshold: number;
    latencyLimitMs: number;
    unavailableLimit: number;
    metricsPort: number;
    scenario: string;
    yes: boolean;
    loop: boolean;
};

const root = process.cwd();
const stateDir = path.join(root, 'load-testing', 'state');
const reportDir = path.join(root, 'load-testing', 'reports');
const stopFile = path.join(stateDir, 'STOP');

function arg(name: string, fallback?: string): string | undefined {
    const prefix = `--${name}=`;
    const found = process.argv.find(value => value.startsWith(prefix));
    return found?.slice(prefix.length) ?? fallback;
}

function numberArg(name: string, fallback: number): number {
    const value = Number(arg(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function savedTargets(): Promise<string[]> {
    const response = await fetch('http://127.0.0.1:3005/api/setup/endpoints');
    if (!response.ok) throw new Error(`Unable to load saved endpoints from SentinelOps (${response.status}).`);
    const data = await response.json() as { endpoints?: Array<{endpointUrl?: string; enabled?: boolean}> };
    return (data.endpoints ?? []).filter(endpoint => endpoint.enabled !== false && endpoint.endpointUrl).map(endpoint => endpoint.endpointUrl as string);
}

async function fileTargets(): Promise<string[]> {
    const filePath = path.join(root, 'load-testing', 'targets.json');
    const data = JSON.parse(await readFile(filePath, 'utf8')) as {targets?: Array<string | {url?: string; enabled?: boolean}>};
    return (data.targets ?? []).filter(target => typeof target === 'string' || target.enabled !== false)
        .map(target => typeof target === 'string' ? target : target.url)
        .filter((target): target is string => Boolean(target));
}

function validateTarget(target: string): string {
    const parsed = new URL(target);
    if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
        throw new Error(`Target must be an HTTP URL on localhost, 127.0.0.1, or ::1: ${target}`);
    }
    return target;
}

async function parseOptions(): Promise<Options> {
    const command = process.argv[2] ?? 'help';
    const presets: Record<string, number> = {
        smoke: 1_000,
        benchmark: 100_000,
        stress: 1_000_000,
        billion: 1_000_000_000
    };
    const total = numberArg('total', presets[command] ?? 1_000);
    const target = arg('target', 'http://localhost:8080/')!;
    const targetMode = arg('targets');
    const targets = targetMode === 'saved'
        ? await savedTargets()
        : targetMode === 'file'
            ? await fileTargets()
        : (targetMode ? targetMode.split(',').map(value => value.trim()).filter(Boolean) : [target]);
    if (!targets.length) throw new Error('No enabled saved endpoints were found.');
    targets.forEach(validateTarget);
    return {
        command,
        total,
        vus: Math.min(Math.floor(numberArg('vus', 10)), 500),
        rate: numberArg('rate', 100),
        durationSeconds: arg('duration') ? numberArg('duration', 60) : undefined,
        target,
        timeoutMs: Math.min(Math.floor(numberArg('timeout-ms', 5_000)), 60_000),
        failureThreshold: Math.min(numberArg('failure-threshold', 0.05), 1),
        latencyLimitMs: numberArg('latency-limit-ms', 2_000),
        unavailableLimit: Math.floor(numberArg('unavailable-limit', 20)),
        metricsPort: Math.floor(numberArg('metrics-port', 9464)),
        scenario: arg('scenario', command)!,
        targets,
        yes: process.argv.includes('--yes'),
        loop: process.argv.includes('--loop')
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function confirm(options: Options): Promise<void> {
    if (options.total <= 1_000_000 || options.yes) return;
    const rl = readline.createInterface({input, output});
    const answer = await rl.question(`This will attempt ${options.total.toLocaleString()} local requests. Type RUN to continue: `);
    rl.close();
    if (answer.trim() !== 'RUN') throw new Error('Load test cancelled. Use --yes only when the large local test is intentional.');
}

function createMetrics() {
    const registry = new Registry();
    const requests = new Counter({
        name: 'sentinelops_loadtest_requests_total',
        help: 'Load test requests by result and status',
        labelNames: ['scenario', 'result', 'status_code'],
        registers: [registry]
    });
    const duration = new Histogram({
        name: 'sentinelops_loadtest_request_duration_seconds',
        help: 'Load test request duration',
        labelNames: ['scenario'],
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
        registers: [registry]
    });
    const active = new Gauge({
        name: 'sentinelops_loadtest_active_virtual_users',
        help: 'Active load test virtual users',
        registers: [registry]
    });
    const progress = new Gauge({
        name: 'sentinelops_loadtest_progress_ratio',
        help: 'Completed load test request ratio',
        labelNames: ['scenario'],
        registers: [registry]
    });
    const rps = new Gauge({
        name: 'sentinelops_loadtest_requests_per_second',
        help: 'Rolling completed requests per second',
        labelNames: ['scenario'],
        registers: [registry]
    });
    const cpu = new Gauge({
        name: 'sentinelops_loadtest_process_cpu_percent',
        help: 'Load generator process CPU percentage',
        labelNames: ['scenario'],
        registers: [registry]
    });
    const memory = new Gauge({
        name: 'sentinelops_loadtest_process_resident_memory_bytes',
        help: 'Load generator process resident memory',
        labelNames: ['scenario'],
        registers: [registry]
    });
    const network = new Gauge({
        name: 'sentinelops_loadtest_response_bytes_per_second',
        help: 'Load generator response throughput in bytes per second',
        labelNames: ['scenario'],
        registers: [registry]
    });
    return {registry, requests, duration, active, progress, rps, cpu, memory, network};
}

async function metricsServer(port: number, registry: {
    contentType: string;
    metrics: () => Promise<string>
}): Promise<Server> {
    const server = createServer(async (_req, res) => {
        res.writeHead(200, {'Content-Type': registry.contentType});
        res.end(await registry.metrics());
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', resolve);
    });
    return server;
}

async function stopped(): Promise<boolean> {
    try {
        await readFile(stopFile);
        return true;
    } catch {
        return false;
    }
}

function percentile(histogram: number[], value: number): number {
    if (!histogram.length) return 0;
    const sorted = [...histogram].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}

async function writeReport(data: Record<string, unknown>): Promise<void> {
    await mkdir(reportDir, {recursive: true});
    const jsonPath = path.join(reportDir, 'latest.json');
    const mdPath = path.join(reportDir, 'latest.md');
    await writeFile(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
    const s = data.summary as Record<string, number | string>;
    const md = `# SentinelOops Load Test Report\n\n- Scenario: ${data.scenario}\n- Target: ${data.target}\n- Started: ${data.startedAt}\n- Finished: ${data.finishedAt}\n\n| Metric | Value |\n| --- | ---: |\n| Attempted | ${s.attempted.toLocaleString()} |\n| Completed | ${s.completed.toLocaleString()} |\n| Successful | ${s.successful.toLocaleString()} |\n| Failed | ${s.failed.toLocaleString()} |\n| Failure rate | ${(Number(s.failureRate) * 100).toFixed(2)}% |\n| Average latency | ${Number(s.averageLatencyMs).toFixed(2)} ms |\n| p50 latency | ${Number(s.p50LatencyMs).toFixed(2)} ms |\n| p95 latency | ${Number(s.p95LatencyMs).toFixed(2)} ms |\n| p99 latency | ${Number(s.p99LatencyMs).toFixed(2)} ms |\n| Peak RPS | ${Number(s.peakRps).toFixed(2)} |\n| Stop reason | ${data.stopReason} |\n\nResource samples and status-code counts are included in latest.json.\n`;
    await writeFile(mdPath, md);
    console.log(`Reports written to ${jsonPath} and ${mdPath}`);
}

async function run(options: Options): Promise<void> {
    await confirm(options);
    await mkdir(stateDir, {recursive: true});
    try {
        await unlink(stopFile);
    } catch { /* no active stop request */
    }
    const metrics = createMetrics();
    const server = await metricsServer(options.metricsPort, metrics.registry);
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let attempted = 0;
    let completed = 0;
    let successful = 0;
    let failed = 0;
    let stoppedBy = 'completed';
    let consecutiveUnavailable = 0;
    let latencyTotal = 0;
    let peakRps = 0;
    let responseBytes = 0;
    let nextSlot = Date.now();
    const initialCpu = process.cpuUsage();
    const latencies: number[] = [];
    const statusCodes: Record<string, number> = {};
    const resourceSamples: Array<Record<string, number>> = [];
    const queue = async (): Promise<number | undefined> => {
        if (await stopped()) {
            stoppedBy = 'emergency stop';
            return undefined;
        }
        if (options.durationSeconds && (Date.now() - startedMs) / 1000 >= options.durationSeconds) {
            stoppedBy = 'duration reached';
            return undefined;
        }
        if (attempted >= options.total) return undefined;
        attempted += 1;
        const slot = Math.max(Date.now(), nextSlot);
        nextSlot = slot + 1000 / options.rate;
        const delay = slot - Date.now();
        if (delay > 0) await sleep(delay);
        return attempted;
    };
    const worker = async () => {
        metrics.active.inc();
        while (true) {
            const sequence = await queue();
            if (sequence === undefined) break;
            const start = performance.now();
            let result: Result = 'failure';
            let code = 'ERR';
            try {
                const target = options.targets[(sequence - 1) % options.targets.length];
                const response = await fetch(target, {
                    signal: AbortSignal.timeout(options.timeoutMs),
                    headers: {'user-agent': 'sentinelops-load-testing/1.0'}
                });
                code = String(response.status);
                const body = await response.arrayBuffer();
                responseBytes += body.byteLength;
                if (response.ok) {
                    result = 'success';
                    consecutiveUnavailable = 0;
                } else {
                    consecutiveUnavailable += 1;
                }
            } catch {
                consecutiveUnavailable += 1;
            }
            const elapsed = performance.now() - start;
            completed += 1;
            if (result === 'success') successful += 1; else failed += 1;
            latencyTotal += elapsed;
            latencies.push(elapsed);
            statusCodes[code] = (statusCodes[code] ?? 0) + 1;
            metrics.requests.inc({scenario: options.scenario, result, status_code: code});
            metrics.duration.observe({scenario: options.scenario}, elapsed / 1000);
            metrics.progress.set({scenario: options.scenario}, completed / options.total);
            const elapsedSeconds = Math.max((Date.now() - startedMs) / 1000, 0.001);
            const currentRps = completed / elapsedSeconds;
            peakRps = Math.max(peakRps, currentRps);
            metrics.rps.set({scenario: options.scenario}, currentRps);
            const cpuNow = process.cpuUsage(initialCpu);
            const memoryNow = process.memoryUsage();
            metrics.cpu.set({scenario: options.scenario}, ((cpuNow.user + cpuNow.system) / 1_000_000) / elapsedSeconds * 100);
            metrics.memory.set({scenario: options.scenario}, memoryNow.rss);
            metrics.network.set({scenario: options.scenario}, responseBytes / elapsedSeconds);
            if (completed >= 100 && failed / completed > options.failureThreshold) {
                stoppedBy = 'failure threshold exceeded';
                break;
            }
            if (elapsed > options.latencyLimitMs) {
                stoppedBy = 'latency limit exceeded';
                break;
            }
            if (consecutiveUnavailable >= options.unavailableLimit) {
                stoppedBy = 'target unavailable';
                break;
            }
            const memory = process.memoryUsage();
            const freeRatio = os.freemem() / os.totalmem();
            // Keep resource telemetry bounded. Sampling every request makes long
            // runs consume unbounded memory and can overflow the call stack when
            // the report computes the peak value.
            if (completed % 100 === 0) {
                resourceSamples.push({
                    at: Date.now(),
                    rssBytes: memory.rss,
                    heapUsedBytes: memory.heapUsed,
                    freeMemoryRatio: freeRatio
                });
            }
            if (freeRatio < 0.05) {
                stoppedBy = 'local memory safety limit';
                break;
            }
            if (completed % 100 === 0) console.log(`progress ${completed.toLocaleString()}/${options.total.toLocaleString()} | ${currentRps.toFixed(1)} req/s | failures ${(failed / completed * 100).toFixed(2)}%`);
        }
        metrics.active.dec();
    };
    const onSignal = () => {
        stoppedBy = 'interrupt';
        void mkdir(stateDir, {recursive: true}).then(() => writeFile(stopFile, 'stop'));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    await Promise.all(Array.from({length: options.vus}, () => worker()));
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const finishedAt = new Date().toISOString();
    const durationSeconds = (Date.now() - startedMs) / 1000;
    const cpuTotal = process.cpuUsage(initialCpu);
    const finalMemory = process.memoryUsage();
    const report = {
        scenario: options.scenario,
        target: options.targets.join(', '),
        startedAt,
        finishedAt,
        stopReason: stoppedBy,
        configuration: {
            total: options.total,
            virtualUsers: options.vus,
            rate: options.rate,
            timeoutMs: options.timeoutMs
        },
        summary: {
            attempted,
            completed,
            successful,
            failed,
            failureRate: completed ? failed / completed : 0,
            averageLatencyMs: completed ? latencyTotal / completed : 0,
            p50LatencyMs: percentile(latencies, 0.5),
            p95LatencyMs: percentile(latencies, 0.95),
            p99LatencyMs: percentile(latencies, 0.99),
            peakRps,
            durationSeconds,
            processCpuPercent: ((cpuTotal.user + cpuTotal.system) / 1_000_000) / Math.max(durationSeconds, 0.001) * 100,
            peakResidentMemoryBytes: resourceSamples.reduce((peak, sample) => Math.max(peak, sample.rssBytes), finalMemory.rss),
            responseBytes,
            responseBytesPerSecond: responseBytes / Math.max(durationSeconds, 0.001)
        },
        statusCodes,
        resourceSamples: resourceSamples.slice(-1000)
    };
    await writeReport(report);
    console.log(`finished: ${stoppedBy}`);
}

function printHelp(): void {
    console.log(`SentinelOops load testing (localhost only)\n\nCommands:\n  smoke       1,000 requests\n  benchmark   100,000 requests\n  stress      1,000,000 requests\n  billion     1,000,000,000 requests; requires explicit confirmation\n  stop        request an emergency stop\n  report      print the latest JSON report\n\nOptions: --total=N --vus=N --rate=N --duration=SECONDS --target=URL --targets=file|saved|URL,URL --timeout-ms=N --failure-threshold=0.05 --latency-limit-ms=N --yes --loop\nUse --targets=file to load independent targets from load-testing/targets.json.\nUse --loop to repeat the configured request batch until Ctrl+C or an emergency stop.\nMetrics: http://localhost:9464/metrics`);
}

const command = process.argv[2] ?? 'help';
if (command === 'stop') {
    await mkdir(stateDir, {recursive: true});
    await writeFile(stopFile, 'stop');
    console.log('Stop requested.');
} else if (command === 'report') {
    try {
        console.log(await readFile(path.join(reportDir, 'latest.json'), 'utf8'));
    } catch {
        console.error('No report exists yet.');
        process.exitCode = 1;
    }
} else if (['smoke', 'benchmark', 'stress', 'billion'].includes(command)) {
    try {
        const options = await parseOptions();
        do {
            await run(options);
            if (!options.loop || await stopped()) break;
            console.log(`batch completed; starting the next ${options.total.toLocaleString()}-request batch`);
        } while (options.loop);
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
} else printHelp();
