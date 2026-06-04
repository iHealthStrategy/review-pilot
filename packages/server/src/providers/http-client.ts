/**
 * Minimal HTTP client port. Provider adapters depend on this rather than a
 * concrete `fetch`/library, so contract tests inject recorded responses and
 * run with zero network access and no credentials.
 */
export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  /** Already-serialised request body (JSON string), if any. */
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Thrown when a provider receives a non-2xx HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly responseBody: string,
  ) {
    super(`HTTP ${status} for ${url}: ${responseBody.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

/**
 * Default {@link HttpClient} backed by the global `fetch` (Node 18+). Kept tiny
 * and dependency-free; swapped for a fake in tests.
 */
export class FetchHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: res.status, headers, body };
  }
}

/** Parse a JSON response body, raising {@link HttpError} on non-2xx. */
export function parseJson<T>(res: HttpResponse, url: string): T {
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(res.status, url, res.body);
  }
  return JSON.parse(res.body) as T;
}
