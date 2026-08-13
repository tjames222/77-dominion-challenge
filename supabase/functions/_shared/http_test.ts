import { assert, assertEquals } from "./test_helpers.ts";
import {
  errorResponse,
  HttpError,
  isAllowedOrigin,
  optionsResponse,
  resolveSiteOrigin,
} from "./http.ts";

const env = (values: Record<string, string>) => (name: string) => values[name];

Deno.test("HTTP origin policy accepts exact configured origins only", () => {
  const read = env({
    PUBLIC_ALLOWED_SITE_URLS:
      "https://app.example.com,https://members.example.com/path,http://localhost:5173",
  });

  assert(isAllowedOrigin("https://app.example.com", read));
  assert(isAllowedOrigin("https://members.example.com", read));
  assert(isAllowedOrigin("http://localhost:5173", read));
  assert(!isAllowedOrigin("https://feature.app.example.com", read));
  assert(!isAllowedOrigin("http://127.0.0.1:5173", read));
  assert(!isAllowedOrigin("https://attacker.example", read));
});

Deno.test("OPTIONS rejects a disallowed origin without reflecting it", async () => {
  const req = new Request("https://functions.test.local", {
    method: "OPTIONS",
    headers: { Origin: "https://attacker.example" },
  });
  const response = optionsResponse(req, env({}));

  assertEquals(response.status, 403);
  assertEquals(response.headers.get("access-control-allow-origin"), null);
  assertEquals(await response.text(), "origin not allowed");
});

Deno.test("site origin is resolved lazily from injected environment", () => {
  const req = new Request("https://functions.test.local");
  assertEquals(
    resolveSiteOrigin(
      req,
      env({ PUBLIC_SITE_URL: "https://app.example.com/billing" }),
    ),
    "https://app.example.com",
  );
});

Deno.test("HTTP errors expose safe client messages but redact server details", async () => {
  const clientResponse = errorResponse(
    new HttpError("Choose a valid option.", 400),
    "Request failed.",
  );
  assertEquals(await clientResponse.json(), {
    error: "Choose a valid option.",
  });

  const serverResponse = errorResponse(
    new Error("database password appeared here"),
    "Request failed.",
  );
  assertEquals(serverResponse.status, 500);
  assertEquals(await serverResponse.json(), { error: "Request failed." });

  const configurationResponse = errorResponse(
    new HttpError("Missing secret value.", 500),
    "Request failed.",
  );
  assertEquals(await configurationResponse.json(), {
    error: "Request failed.",
  });
});
