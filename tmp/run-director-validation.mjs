import { runFullTestPipeline } from '/opt/ad-platform/backend/services/conductorEngine.js';

const projectId = '5f90d728-4404-430a-991c-bc882ce02e08';
const angleId = '4684d523-c1d4-4021-883f-802dba5aefde';

const result = await runFullTestPipeline(
  projectId,
  (event) => {
    if (event && event.type === 'progress') {
      const parts = [event.step || 'progress', event.message || ''];
      console.log('[progress] ' + parts.join(' :: '));
      return;
    }
    console.log(JSON.stringify(event));
  },
  { angleOverride: angleId, skipLPGen: false },
);

console.log('RESULT ' + JSON.stringify(result));
