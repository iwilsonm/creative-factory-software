import { runGauntlet } from '../services/lpAutoGenerator.js';

const [projectId, dryRunArg, ...angleParts] = process.argv.slice(2);

if (!projectId || !dryRunArg || angleParts.length === 0) {
  console.error('Usage: node backend/scripts/run_lp_gauntlet.mjs <projectId> <dryRun:true|false> <angle>');
  process.exit(1);
}

const dryRun = dryRunArg === 'true';
const angle = angleParts.join(' ');

try {
  const report = await runGauntlet(
    projectId,
    { dryRun, angle },
    (event) => {
      if (!event) return;
      if (event.type === 'progress' || event.type === 'complete' || event.type === 'error') {
        console.log(JSON.stringify(event));
      }
    }
  );
  console.log(`REPORT_JSON ${JSON.stringify(report)}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
