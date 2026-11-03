import '../loadEnv.js';
import { runMorningJobs } from '../jobs/morning.js';

console.log('--- Triggering Mill Mate Morning Jobs Manually ---');
runMorningJobs({ force: true })
  .then(res => {
    console.log('Result:', JSON.stringify(res, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error('Job error:', err);
    process.exit(1);
  });

