import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src', import.meta.url));
const scannedDirs = ['components', 'pages'];
const forbidden = [
  /Flex Ad/i,
  /Flexible/i,
  /Staging Page/i,
  /staging area/i,
  /Phase [23456]/i,
  /Dacia/i,
  /Scout/i,
  /Recursive Agent/i,
  /LP Agent/i,
  /Gauntlet/i,
];

const allow = [];

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...listFiles(path));
    else if (/\.(jsx|js)$/.test(name)) out.push(path);
  }
  return out;
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const failures = [];
for (const dir of scannedDirs) {
  for (const file of listFiles(join(root, dir))) {
    const rel = relative(process.cwd(), file);
    if (allow.some((rx) => rx.test(rel))) continue;
    const text = stripComments(readFileSync(file, 'utf8'));
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (/className\s*=|localStorage\.|dacia_testRunQueue/.test(line)) return;
      const chunks = [];
      const literalRe = /(['"`])((?:\\.|(?!\1).){2,})\1/g;
      let match;
      while ((match = literalRe.exec(line))) chunks.push(match[2]);
      const jsxText = line.match(/>\s*([^<{}`'"]{3,})\s*</);
      if (jsxText) chunks.push(jsxText[1]);
      if (chunks.length === 0) return;
      for (const rx of forbidden) {
        for (const chunk of chunks) {
          if (rx.test(chunk)) failures.push(`${rel}:${index + 1}: ${rx} -> ${chunk.trim()}`);
        }
      }
    });
  }
}

if (failures.length) {
  console.error('Customer-facing copy audit failed:\n' + failures.join('\n'));
  process.exit(1);
}

console.log('Customer-facing copy audit passed.');
