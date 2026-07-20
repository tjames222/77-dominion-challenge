export function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "Values are not equal",
) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}: expected ${expectedJson}, received ${actualJson}`,
    );
  }
}

export async function responseJson(response: Response) {
  return await response.json() as Record<string, unknown>;
}

export function request(
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request("https://functions.test.local/function", {
    method,
    headers: {
      Authorization: "Bearer test-token",
      Origin: "http://localhost:5173",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined
      ? undefined
      : typeof body === "string"
      ? body
      : JSON.stringify(body),
  });
}

export const quietLogger = { error: () => undefined };
