import { describe, it, expect } from 'vitest';
import { AsyncSemaphore } from '../services/rateLimiter.js';

// Helper to flush microtask queue so async acquire() calls resolve
const tick = () => new Promise(r => setTimeout(r, 0));

describe('AsyncSemaphore', () => {
  it('runs immediately when under concurrency limit', async () => {
    const sem = new AsyncSemaphore(2);
    expect(sem.active).toBe(0);
    expect(sem.pending).toBe(0);

    const result = await sem.run(() => Promise.resolve('done'));
    expect(result).toBe('done');
    expect(sem.active).toBe(0);
  });

  it('returns the function result from run()', async () => {
    const sem = new AsyncSemaphore(1);
    const result = await sem.run(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('releases on error and re-throws', async () => {
    const sem = new AsyncSemaphore(1);
    const err = new Error('boom');

    await expect(sem.run(() => Promise.reject(err))).rejects.toThrow('boom');
    // Semaphore should be released after error
    expect(sem.active).toBe(0);
    expect(sem.pending).toBe(0);
  });

  it('queues calls that exceed concurrency', async () => {
    const sem = new AsyncSemaphore(1);
    const order = [];

    // Hold a slot with a long-running task
    let resolveFirst;
    const firstPromise = sem.run(() => new Promise(resolve => {
      resolveFirst = resolve;
      order.push('first-started');
    }));

    // Let microtask queue flush so acquire() in run() completes
    await tick();

    // Second call should be queued
    const secondPromise = sem.run(async () => {
      order.push('second-started');
      return 'second';
    });

    // Let the second run() attempt to acquire
    await tick();

    expect(sem.active).toBe(1);
    expect(sem.pending).toBe(1);

    // Release first
    resolveFirst('first');

    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    expect(firstResult).toBe('first');
    expect(secondResult).toBe('second');
    expect(order).toEqual(['first-started', 'second-started']);
    expect(sem.active).toBe(0);
    expect(sem.pending).toBe(0);
  });

  it('allows N concurrent calls with concurrency=N', async () => {
    const sem = new AsyncSemaphore(3);
    const resolvers = [];

    // Start 3 concurrent tasks — each creates a pending promise
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(sem.run(() => new Promise(resolve => {
        resolvers.push(resolve);
      })));
      await tick();
    }

    // All 3 should be active
    expect(sem.active).toBe(3);
    expect(sem.pending).toBe(0);

    // 4th should be queued
    const fourthPromise = sem.run(() => Promise.resolve('fourth'));
    await tick();
    expect(sem.pending).toBe(1);

    // Resolve all 3 → 4th should eventually start
    resolvers[0]('zero');
    resolvers[1]('one');
    resolvers[2]('two');

    await Promise.all(promises);
    const fourthResult = await fourthPromise;
    expect(fourthResult).toBe('fourth');
    expect(sem.active).toBe(0);
  });

  it('acquire/release work correctly', async () => {
    const sem = new AsyncSemaphore(1);

    await sem.acquire();
    expect(sem.active).toBe(1);

    sem.release();
    expect(sem.active).toBe(0);
  });

  it('pending getter reflects queue length', async () => {
    const sem = new AsyncSemaphore(1);

    let resolveFirst;
    const first = sem.run(() => new Promise(r => { resolveFirst = r; }));
    await tick();

    const second = sem.run(() => Promise.resolve('b'));
    const third = sem.run(() => Promise.resolve('c'));
    await tick();

    expect(sem.pending).toBe(2);

    resolveFirst('a');
    await Promise.all([first, second, third]);
    expect(sem.pending).toBe(0);
  });
});
