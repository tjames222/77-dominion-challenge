import { createOAuthCallbackHandler } from "../_shared/integration_oauth_callback.ts";

export const handler = createOAuthCallbackHandler("slack");

if (import.meta.main) Deno.serve(handler);
