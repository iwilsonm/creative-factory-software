#!/usr/bin/env node

import { repairFailedAdStudioImageJob } from '../services/adStudioImageJobs.js';

const adId = process.argv[2];

if (!adId) {
  console.error('Usage: node backend/scripts/repair-ad-studio-image-job.mjs <ad-id>');
  process.exit(1);
}

try {
  const result = await repairFailedAdStudioImageJob(adId);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
