import { execFileSync } from 'child_process';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean);

const blocked = tracked.filter((file) => {
  const lower = file.toLowerCase();
  return (
    /^\.env(\.|$)/.test(lower) ||
    lower.startsWith('.vercel/') ||
    /(^|\/)service-account\.json$/.test(lower) ||
    /(^|\/)(credentials|token|cookies?)\.json$/.test(lower) ||
    /(^|\/).*\.pem$/.test(lower) ||
    /(^|\/).*\.key$/.test(lower)
  );
});

if (blocked.length > 0) {
  console.error('Tracked secret-like files are not allowed:');
  for (const file of blocked) console.error(`- ${file}`);
  process.exit(1);
}

console.log('No tracked secret-like files found.');
