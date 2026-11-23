import test from "node:test";
import assert from "node:assert/strict";

import { pickCacheCreationTokens } from "../../../open-sse/utils/pickCacheCreationTokens.ts";

// #19541: Anthropic-shaped counts that arrive nested under OpenAI-style token details keep
// their `cache_creation_input_tokens` spelling.
test("reads nested cache_creation_input_tokens from prompt and input details", () => {
  assert.equal(
    pickCacheCreationTokens({ prompt_tokens_details: { cache_creation_input_tokens: 12 } }),
    12
  );
  assert.equal(
    pickCacheCreationTokens({ input_tokens_details: { cache_creation_input_tokens: 7 } }),
    7
  );
});

test("the *_tokens spelling still wins over the alias, and the flat key over both", () => {
  assert.equal(
    pickCacheCreationTokens({
      prompt_tokens_details: { cache_creation_tokens: 3, cache_write_tokens: 9 },
    }),
    3
  );
  assert.equal(
    pickCacheCreationTokens({
      cache_creation_input_tokens: 5,
      prompt_tokens_details: { cache_creation_input_tokens: 12 },
    }),
    5
  );
});
