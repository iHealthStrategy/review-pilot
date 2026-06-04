import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from "../src/providers/http-client.js";

export interface Route {
  /** Match by method and a URL substring. */
  method: HttpRequest["method"];
  urlIncludes: string;
  status?: number;
  /** Response body; objects are JSON-stringified. */
  body: unknown;
}

/**
 * Recording, route-table {@link HttpClient} fake. Returns canned responses
 * matched by method + URL substring and records every request, so provider
 * adapter tests run against fixtures with no network and no credentials.
 */
export class FakeHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];

  constructor(private readonly routes: Route[]) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const route = this.routes.find(
      (r) => r.method === req.method && req.url.includes(r.urlIncludes),
    );
    if (!route) {
      return { status: 404, headers: {}, body: `no route for ${req.url}` };
    }
    const body =
      typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return { status: route.status ?? 200, headers: {}, body };
  }

  lastRequest(): HttpRequest {
    const r = this.requests.at(-1);
    if (!r) throw new Error("no requests recorded");
    return r;
  }
}
