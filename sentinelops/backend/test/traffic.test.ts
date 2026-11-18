import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateTrafficSummary, summarizeTrafficStatus } from '../src/app.js';
import { counterDelta } from '../src/traffic-stream.js';

test('traffic summary uses interval count and observed coverage for average RPS', () => {
  const summary = calculateTrafficSummary([[100, 2], [110, 3], [120, 4]], 27, 2, 900, 10);
  assert.equal(summary.coverageSeconds, 20);
  assert.equal(summary.averageRps, 1.35);
  assert.equal(summary.peakRps, 4);
  assert.equal(summary.errorPercent, 2 / 27 * 100);
});

test('traffic summary distinguishes incomplete coverage from zero requests', () => {
  const summary = calculateTrafficSummary([[100, 0], [110, 0]], 0, 0, 900, 10);
  assert.equal(summary.coverageSeconds, 10);
  assert.equal(summary.averageRps, 0);
  assert.equal(summary.peakRps, 0);
  assert.equal(summary.errorPercent, 0);
});

test('status distribution preserves successful and error totals', () => {
  const distribution = summarizeTrafficStatus([
    { statusCode: '200', total: 20 },
    { statusCode: '201', total: 3 },
    { statusCode: '404', total: 2 },
    { statusCode: '500', total: 1 }
  ]);
  assert.deepEqual(distribution, { total: 26, success: 23, clientErrors: 2, serverErrors: 1 });
});

test('live counter deltas handle first samples and counter resets', () => {
  assert.equal(counterDelta(10), 0);
  assert.equal(counterDelta(15, 10), 5);
  assert.equal(counterDelta(3, 15), 3);
});
