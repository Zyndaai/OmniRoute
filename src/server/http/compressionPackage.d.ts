// The `compression` package ships no type declarations; this covers the part the server uses.
declare module "compression" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  type CompressionFilter = (req: IncomingMessage, res: ServerResponse) => boolean;

  interface CompressionOptions {
    filter?: CompressionFilter;
    threshold?: number | string;
    level?: number;
  }

  type CompressionMiddleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: (error?: unknown) => void
  ) => void;

  interface Compression {
    (options?: CompressionOptions): CompressionMiddleware;
    /** The default filter: compressible `Content-Type` per mime-db. */
    filter: CompressionFilter;
  }

  const compression: Compression;
  export default compression;
}
