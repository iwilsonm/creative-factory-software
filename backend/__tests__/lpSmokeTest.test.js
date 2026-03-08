import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launchMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('puppeteer', () => ({
  default: {
    launch: (...args) => launchMock(...args),
  },
}));

function createBrowserWithEvaluateResults(results) {
  const evaluateMock = vi.fn();
  for (const result of results) {
    evaluateMock.mockResolvedValueOnce(result);
  }

  return {
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue({
      setViewport: vi.fn().mockResolvedValue(undefined),
      setContent: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: evaluateMock,
    }),
  };
}

describe('lpSmokeTest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(global, 'setTimeout').mockImplementation((fn, _ms, ...args) => {
      if (typeof fn === 'function') fn(...args);
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('passes when only raw HTML placeholders exist inside non-visible source', async () => {
    launchMock.mockResolvedValueOnce(createBrowserWithEvaluateResults([
      [],
      { total: 1, loaded: 1 },
      false,
    ]));
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('<html><script>window.money_format = "${{amount}}"</script><body><h1>Sleep better</h1></body></html>'),
    });

    const { runSmokeTest } = await import('../services/lpSmokeTest.js');
    const result = await runSmokeTest('https://example.com/test');

    expect(result.passed).toBe(true);
    expect(result.visiblePlaceholderCount).toBe(0);
    expect(result.rawHtmlPlaceholderCount).toBe(1);
    expect(result.checks.find((check) => check.name === 'no_placeholders')?.passed).toBe(true);
  });

  it('fails when placeholder text is visible in rendered DOM text', async () => {
    launchMock.mockResolvedValueOnce(createBrowserWithEvaluateResults([
      ['{{headline}}'],
      { total: 1, loaded: 1 },
      false,
    ]));
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('<html><body><h1>{{headline}}</h1></body></html>'),
    });

    const { runSmokeTest } = await import('../services/lpSmokeTest.js');
    const result = await runSmokeTest('https://example.com/test');

    expect(result.passed).toBe(false);
    expect(result.visiblePlaceholderCount).toBe(1);
    expect(result.checks.find((check) => check.name === 'no_placeholders')?.passed).toBe(false);
  });
});
