import assert from 'node:assert/strict';
import {
  getGatewayRequestId,
  normalizeApiError,
} from '../src/utils/apiErrors.js';

const gateway = normalizeApiError({
  status: 403,
  data: { error: 'Forbidden Forbidden sin1::jzsgb-1778018076460-d2d69ab85861' },
  rawText: 'Forbidden Forbidden sin1::jzsgb-1778018076460-d2d69ab85861',
  fallback: 'Upload failed',
});
assert.equal(gateway.code, 'GATEWAY_FORBIDDEN');
assert.match(gateway.message, /blocked before it reached the app/i);
assert.equal(gateway.request_id, 'sin1::jzsgb-1778018076460-d2d69ab85861');

const oversized = normalizeApiError({
  status: 413,
  data: { error: 'Request Entity Too Large' },
  rawText: 'Request Entity Too Large',
});
assert.equal(oversized.code, 'FILE_TOO_LARGE');
assert.match(oversized.message, /too large/i);

const html = normalizeApiError({
  status: 500,
  data: { error: 'Internal Server Error', raw_body: '<html><body>Internal Server Error</body></html>' },
  rawText: '<html><body>Internal Server Error</body></html>',
});
assert.equal(html.code, 'SERVER_ERROR');

const expired = normalizeApiError({ status: 401 });
assert.equal(expired.code, 'AUTH_EXPIRED');

const rateLimited = normalizeApiError({ status: 429 });
assert.equal(rateLimited.code, 'RATE_LIMITED');

assert.equal(getGatewayRequestId('Forbidden iad1::abc-123'), 'iad1::abc-123');

console.log('api error normalization tests passed');
