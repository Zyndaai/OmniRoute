/**
 * `request` with another URL and/or other headers. Method, body and abort signal carry over,
 * so a streamed upload is passed on unread and a client disconnect still reaches the route.
 */
export function rebuildRequest(
  request: Request,
  { url = request.url, headers = request.headers }: { url?: string; headers?: Headers } = {}
): Request {
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
    redirect: request.redirect,
  };
  if (request.body !== null && request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(url, init);
}
