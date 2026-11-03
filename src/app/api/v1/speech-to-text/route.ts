import {
  elevenLabsOptionsResponse,
  proxyElevenLabsRequest,
} from "@/app/api/v1/_shared/elevenLabsProxy";

export async function OPTIONS() {
  return elevenLabsOptionsResponse();
}

export async function POST(request: Request) {
  const init = {
    method: "POST",
    body: request.body,
    duplex: "half",
  };
  return proxyElevenLabsRequest(request, "/speech-to-text", init);
}
