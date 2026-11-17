-- Allow rerank-typed provider nodes (#16929). The SQLite column was unconstrained text; the CHECK
-- added in 0001_init.sql left out 'rerank', which the provider-node validation schema
-- (src/shared/validation/schemas/provider.ts) and defaultEndpointsForProviderNodeApiType accept.
ALTER TABLE provider_nodes DROP CONSTRAINT IF EXISTS provider_nodes_api_type_check;
ALTER TABLE provider_nodes ADD CONSTRAINT provider_nodes_api_type_check
  CHECK (api_type IN ('chat', 'responses', 'embeddings', 'rerank', 'audio-transcriptions',
                      'audio-speech', 'images-generations'));
