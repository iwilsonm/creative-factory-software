import { getSetting } from '/opt/ad-platform/backend/convexClient.js';

const apiKey = await getSetting('anthropic_api_key');

if (!apiKey) {
  console.log(JSON.stringify({ error: 'No anthropic_api_key configured' }, null, 2));
  process.exit(0);
}

const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Say hi.' }],
  }),
});

const headers = Object.fromEntries(
  [...response.headers.entries()].sort((left, right) => left[0].localeCompare(right[0])),
);

const body = await response.text();

console.log(JSON.stringify({
  status: response.status,
  headers,
  body,
}, null, 2));
