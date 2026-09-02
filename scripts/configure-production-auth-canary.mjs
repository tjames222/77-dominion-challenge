import { pathToFileURL } from "node:url";
import { configureProductionAuthCanary } from "./production-auth-canary-policy.mjs";

export { configureProductionAuthCanary } from "./production-auth-canary-policy.mjs";

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  try {
    await configureProductionAuthCanary();
    console.log(
      "Supabase Auth signup paths and reviewed production URLs are configured and verified.",
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Supabase Auth canary policy update failed.",
    );
    process.exitCode = 1;
  }
}
