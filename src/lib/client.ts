"use client";

/**
 * Thin wrapper over fetch for this app's JSON contract: every response is
 * `{ ok: true, ... }` or `{ ok: false, error, field? }`. Failures throw an
 * `ApiCallError` carrying the message the server wrote for the user, so
 * components can render `e.message` directly instead of inventing wording.
 */
export class ApiCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

type Options = { method?: string; body?: unknown; signal?: AbortSignal };

/** Unwraps the `{ ok }` envelope, turning a failure into an ApiCallError. */
async function unwrap<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => null)) as
    | ({ ok: boolean; error?: string; field?: string } & Record<string, unknown>)
    | null;

  if (!data) throw new ApiCallError("The server sent an unreadable reply.", res.status);
  if (!data.ok)
    throw new ApiCallError(data.error ?? "Something went wrong.", res.status, data.field);

  return data as T;
}

export async function api<T = Record<string, unknown>>(
  path: string,
  { method, body, signal }: Options = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal,
    });
  } catch {
    throw new ApiCallError("No connection. Check your internet and try again.", 0);
  }

  return unwrap<T>(res);
}

/**
 * Posts one file as multipart/form-data — the JSON helper above cannot carry
 * bytes. Used by the question editor to upload a picture. The Content-Type
 * header is deliberately left unset so the browser adds the MIME boundary.
 */
export async function upload<T = Record<string, unknown>>(
  path: string,
  file: File,
  signal?: AbortSignal,
): Promise<T> {
  const form = new FormData();
  form.append("file", file, file.name);

  let res: Response;
  try {
    res = await fetch(path, { method: "POST", body: form, cache: "no-store", signal });
  } catch {
    throw new ApiCallError("The upload did not go through. Check your connection.", 0);
  }

  return unwrap<T>(res);
}

/** Retries transient failures (offline, 5xx) with a short backoff. */
export async function apiRetry<T = Record<string, unknown>>(
  path: string,
  options: Options = {},
  attempts = 3,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await api<T>(path, options);
    } catch (e) {
      last = e;
      const status = e instanceof ApiCallError ? e.status : 0;
      // 4xx means the request itself is wrong — retrying cannot help.
      if (status >= 400 && status < 500) throw e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw last;
}

export const errText = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please try again.";
