import {
  assertEquals,
  quietLogger,
  responseJson,
} from "../_shared/test_helpers.ts";
import { createHandler } from "./index.ts";

const env = (name: string) => ({
  SUPABASE_URL: "https://project.supabase.co",
}[name]);
const validPdf = "%PDF-1.7\nfixture\n%%EOF";
const validPdfChecksum =
  "025bfabf088fa4396e6638c23e49688c077386554ebe472d6f941d8974bda128";
const nonPdfChecksum =
  "3ef38a2f3b4986776f699401812197c045833fa192240b701b9915fb68ed9e28";

function request(body: unknown = {
  rewardKey: "nehemiah_leadership_handbook",
  expectedUserId: "user-1",
}) {
  return new Request("https://functions.example/reward-download", {
    method: "POST",
    headers: {
      Authorization: "Bearer trusted-test-token",
      Origin: "http://localhost:5173",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

type FixtureOptions = {
  assetState?: "valid" | "missing" | "oversized" | "corrupted" | "not-pdf";
  unavailable?: boolean;
  unsafeDelivery?: boolean;
};

function clients(options: FixtureOptions = {}) {
  const calls: string[] = [];
  const user = {
    rpc: async (name: string) => {
      calls.push(name);
      return options.unavailable
        ? { data: { availability: "unavailable" }, error: null }
        : {
          data: {
            availability: "available",
            ticket: "10000000-0000-4000-8000-000000000001",
          },
          error: null,
        };
    },
  };
  const admin = {
    rpc: async (name: string) => {
      calls.push(name);
      if (name === "redeem_reward_download_ticket") {
        return {
          data: [{
            bucket_name: "reward-downloads",
            object_path: "handbooks/nehemiah-v1.pdf",
            download_filename: "Nehemiah-Leadership-Handbook.pdf",
            content_type: options.unsafeDelivery
              ? "text/html"
              : "application/pdf",
            sha256_hex: options.assetState === "not-pdf"
              ? nonPdfChecksum
              : validPdfChecksum,
            size_bytes: 22,
          }],
          error: null,
        };
      }
      return { data: null, error: null };
    },
    storage: {
      from: () => ({
        download: async () => {
          calls.push("storage.download");
          if (options.assetState === "missing") {
            return { data: null, error: { message: "Object not found" } };
          }
          if (options.assetState === "oversized") {
            return {
              data: {
                size: 52_428_801,
                type: "application/pdf",
                arrayBuffer: async () => new ArrayBuffer(0),
              },
              error: null,
            };
          }
          const contents = options.assetState === "corrupted"
            ? "%PDF-1.7\ncorrupt\n%%EOF"
            : options.assetState === "not-pdf"
            ? "<html>not a PDF</html>"
            : validPdf;
          return {
            data: new Blob([contents], { type: "application/pdf" }),
            error: null,
          };
        },
      }),
    },
  };
  return { calls, user, admin };
}

function handler(options: FixtureOptions = {}) {
  const fixture = clients(options);
  return {
    fixture,
    handle: createHandler({
      requireUser: async () => ({ id: "user-1" }),
      createUserClient: () => fixture.user,
      createAdminClient: () => fixture.admin,
      env,
      logger: quietLogger,
    } as any),
  };
}

Deno.test("reward download streams the exact verified bytes without exposing storage coordinates", async () => {
  const test = handler();
  const response = await test.handle(request());
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "application/pdf");
  assertEquals(
    response.headers.get("content-disposition"),
    'attachment; filename="Nehemiah-Leadership-Handbook.pdf"',
  );
  assertEquals(response.headers.get("content-length"), "22");
  assertEquals(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(
    response.headers.get("content-security-policy"),
    "default-src 'none'; sandbox",
  );
  assertEquals(await response.text(), validPdf);
  assertEquals(test.fixture.calls.includes("storage.download"), true);
  assertEquals(
    test.fixture.calls.includes("record_reward_download_result"),
    true,
  );
  assertEquals(
    JSON.stringify([...response.headers]).includes("handbooks/nehemiah-v1.pdf"),
    false,
  );
});

Deno.test("missing approved asset stays unavailable without a placeholder", async () => {
  const test = handler({ unavailable: true });
  const response = await test.handle(request());
  assertEquals(response.status, 409);
  assertEquals(await responseJson(response), {
    status: "unavailable",
    availability: "unavailable",
    message:
      "You permanently own this reward. The approved handbook edition is being finalized.",
  });
  assertEquals(
    test.fixture.calls.includes("redeem_reward_download_ticket"),
    false,
  );
});

Deno.test("unsupported rewards and stale actors fail closed", async () => {
  const unsupported = handler();
  assertEquals(
    (await unsupported.handle(
      request({ rewardKey: "other", expectedUserId: "user-1" }),
    )).status,
    400,
  );

  const staleActor = handler();
  assertEquals(
    (await staleActor.handle(request({
      rewardKey: "nehemiah_leadership_handbook",
      expectedUserId: "user-2",
    }))).status,
    409,
  );
  assertEquals(staleActor.fixture.calls.length, 0);
});

Deno.test("an unexpected bucket object contract is never downloaded", async () => {
  const test = handler({ unsafeDelivery: true });
  assertEquals((await test.handle(request())).status, 410);
  assertEquals(test.fixture.calls.includes("storage.download"), false);
  assertEquals(
    test.fixture.calls.includes("record_reward_download_result"),
    true,
  );
});

Deno.test("a missing approved object fails closed", async () => {
  const test = handler({ assetState: "missing" });
  assertEquals((await test.handle(request())).status, 410);
  assertEquals(
    test.fixture.calls.includes("record_reward_download_result"),
    true,
  );
});

Deno.test("an oversized stored object fails closed", async () => {
  const test = handler({ assetState: "oversized" });
  assertEquals((await test.handle(request())).status, 410);
  assertEquals(
    test.fixture.calls.includes("record_reward_download_result"),
    true,
  );
});

Deno.test("a checksum-mismatched stored object fails closed", async () => {
  const test = handler({ assetState: "corrupted" });
  assertEquals((await test.handle(request())).status, 410);
  assertEquals(
    test.fixture.calls.includes("record_reward_download_result"),
    true,
  );
});

Deno.test("matching metadata cannot disguise non-PDF bytes", async () => {
  const test = handler({ assetState: "not-pdf" });
  assertEquals((await test.handle(request())).status, 410);
  assertEquals(
    test.fixture.calls.includes("record_reward_download_result"),
    true,
  );
});
