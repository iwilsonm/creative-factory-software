import { describe, expect, it } from 'vitest';

import { convertToShopifyFragment } from '../services/shopifyFragment.js';

describe('convertToShopifyFragment', () => {
  it('converts a full HTML document into a Shopify-safe fragment', () => {
    const input = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&display=swap" />
    <style>body { background: #fff; }</style>
  </head>
  <body>
    <section class="hero">
      <h1>Hello world</h1>
    </section>
  </body>
</html>`;

    const output = convertToShopifyFragment(input);

    expect(output).not.toContain('<html');
    expect(output).not.toContain('<head');
    expect(output).not.toContain('<body');
    expect(output).toContain("@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&display=swap');");
    expect(output).toContain('<style>body { background: #fff; }</style>');
    expect(output).toContain('<section class="hero">');
    expect(output).toContain('<h1>Hello world</h1>');
  });

  it('returns existing fragments unchanged', () => {
    const input = '<style>.hero{color:red;}</style><section><h1>Fragment</h1></section>';

    expect(convertToShopifyFragment(input)).toBe(input);
  });
});
