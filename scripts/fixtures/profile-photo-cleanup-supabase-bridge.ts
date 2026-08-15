// FOU-802 local rehearsal only. The production function imports the pinned
// Supabase client from JSR. The isolated rehearsal runtime maps that one import
// to this deliberately small adapter so the proof cannot download dependencies
// or address a hosted project.

type ClientResult<T> = Promise<{ data: T | null; error: Error | null }>;
type ClientOptions = {
  global?: { headers?: Record<string, string> };
};
type ListOptions = {
  limit?: number;
  offset?: number;
  search?: string;
  sortBy?: { column: string; order: string };
};

const allowedOrigin =
  "http://supabase_kong_77-dominion-challenge:8000";

function assertLocalOrigin(value: string) {
  const parsed = new URL(value);
  if (parsed.origin !== allowedOrigin || parsed.pathname !== "/") {
    throw new Error("FOU-802 rehearsal bridge rejected a non-local origin.");
  }
  return parsed.origin;
}

async function request<T>(
  origin: string,
  key: string,
  path: string,
  method: "POST" | "DELETE",
  body: Record<string, unknown>,
  extraHeaders: Record<string, string>,
): ClientResult<T> {
  try {
    const response = await fetch(new URL(path, `${origin}/`), {
      method,
      redirect: "error",
      headers: {
        "Authorization": `Bearer ${key}`,
        "apikey": key,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { data: null, error: new Error("Local Supabase request failed.") };
    }
    return {
      data: await response.json() as T,
      error: null,
    };
  } catch {
    return { data: null, error: new Error("Local Supabase request failed.") };
  }
}

export function createClient(
  url: string,
  key: string,
  options: ClientOptions = {},
) {
  const origin = assertLocalOrigin(url);
  if (!key) throw new Error("FOU-802 rehearsal bridge requires a local key.");
  const extraHeaders = options.global?.headers || {};

  return {
    rpc<T>(name: string, args: Record<string, unknown> = {}) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        return Promise.resolve({
          data: null,
          error: new Error("Invalid local RPC name."),
        }) as ClientResult<T>;
      }
      return request<T>(
        origin,
        key,
        `/rest/v1/rpc/${name}`,
        "POST",
        args,
        extraHeaders,
      );
    },
    storage: {
      from(bucket: string) {
        if (bucket !== "profile-photos") {
          throw new Error("FOU-802 rehearsal bridge rejected a bucket.");
        }
        return {
          list(folder: string, listOptions: ListOptions = {}) {
            return request<unknown[]>(
              origin,
              key,
              `/storage/v1/object/list/${bucket}`,
              "POST",
              {
                prefix: folder,
                limit: listOptions.limit ?? 100,
                offset: listOptions.offset ?? 0,
                search: listOptions.search ?? "",
                sortBy: listOptions.sortBy ?? {
                  column: "name",
                  order: "asc",
                },
              },
              extraHeaders,
            );
          },
          remove(paths: string[]) {
            return request<unknown[]>(
              origin,
              key,
              `/storage/v1/object/${bucket}`,
              "DELETE",
              { prefixes: paths },
              extraHeaders,
            );
          },
        };
      },
    },
  };
}
