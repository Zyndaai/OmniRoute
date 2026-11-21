// #12491 — keep the module-name argument dynamic (never a literal string)
// when calling a createRequire()-returned function. A bundler that statically
// detects a literal specifier can rewrite the call into a bundled require()
// target that is absent from the Docker runtime image; resolving the name at
// run time keeps the native module loaded from node_modules. Mirrors
// open-sse/utils/tlsClient.ts's loadRuntimeModule().
export function loadDynamicModule(requireFn: NodeRequire, moduleName: string): unknown {
  return Reflect.apply(requireFn, undefined, [moduleName]);
}
