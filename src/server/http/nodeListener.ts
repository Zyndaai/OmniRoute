/**
 * Node `(req, res)` listener around the fetch pipeline. Besides converting between Node and
 * fetch objects, it gives each request an `afterResponse()` queue that is released on the
 * response's `close` event: by then the last byte has been handed to the socket (after any
 * compressor has flushed its trailer) or the client has gone. Releasing when the fetch body
 * stream ends would be too early, because a compressor still holds the tail of the body then.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { createRequestListener, type RequestListenerOptions } from "@remix-run/node-fetch-server";

import { AfterResponseQueue, runWithAfterResponseQueue } from "../requestContext";
import type { FetchHandler } from "./handler";

export type NodeListener = (req: IncomingMessage, res: ServerResponse) => void;

export function createNodeListener(
  handler: FetchHandler,
  options?: RequestListenerOptions
): NodeListener {
  const listener = createRequestListener(handler, options);
  return (req, res) => {
    const queue = new AfterResponseQueue();
    res.once("close", () => queue.release());
    runWithAfterResponseQueue(queue, () => {
      void listener(req, res);
    });
  };
}
