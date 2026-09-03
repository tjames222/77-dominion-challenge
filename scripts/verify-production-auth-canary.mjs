import { pathToFileURL } from 'node:url';
import { verifyProductionAuthCanary } from './production-auth-canary-policy.mjs';

export {
  productionAuthCanaryErrors,
  verifyProductionAuthCanary,
} from './production-auth-canary-policy.mjs';

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  try {
    await verifyProductionAuthCanary();
    console.log('Supabase Auth signup paths and reviewed production URLs are verified.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Supabase Auth canary gate failed.');
    process.exitCode = 1;
  }
}
