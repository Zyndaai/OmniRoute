import { lazy, Suspense } from "react";
import type { BeforeMount, EditorProps } from "@monaco-editor/react";
import { ClientOnly } from "./ClientOnly";
import { defineKitMonacoThemes, kitMonacoThemeName } from "./monacoKitTheme";

// Self-hosted Monaco. Configures @monaco-editor/react to use the bundled
// `monaco-editor` package instead of the default jsdelivr CDN, which is
// blocked by our CSP (script-src 'self'). Keep all Editor imports going
// through this wrapper so the loader is configured exactly once.
//
// Colours: the wrapper registers editor themes built from the kit's CSS variables at runtime
// (monacoKitTheme.ts — no hex palette here) and maps the built-in names consumers pass
// ("vs-dark", "light") onto them; if the kit themes cannot be built, the built-ins stay.
const KitEditor = lazy(async () => {
  const [{ default: Editor, loader }, monaco] = await Promise.all([
    import("@monaco-editor/react"),
    import("monaco-editor/editor/editor.api.js"),
  ]);
  loader.config({ monaco });
  // Before the first render, so the first editor already mounts with the kit theme.
  defineKitMonacoThemes(monaco);

  function KitThemedEditor(props: EditorProps) {
    const { beforeMount, theme, ...rest } = props;
    const handleBeforeMount: BeforeMount = (instance) => {
      // Refresh: the page theme may have flipped since the module loaded.
      defineKitMonacoThemes(instance);
      beforeMount?.(instance);
    };
    return <Editor {...rest} theme={kitMonacoThemeName(theme)} beforeMount={handleBeforeMount} />;
  }
  return { default: KitThemedEditor };
});

// Monaco needs `window`, so it only renders in the browser.
function MonacoEditor(props: EditorProps) {
  return (
    <ClientOnly>
      {() => (
        <Suspense fallback={null}>
          <KitEditor {...props} />
        </Suspense>
      )}
    </ClientOnly>
  );
}

export type { EditorProps };
export default MonacoEditor;
