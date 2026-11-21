import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

import { DEFAULT_LOCALE } from "@/i18n/config";
import { loadMessages } from "@/i18n/messages";

// The catalog is not in the HTML: load the active locale's chunk (cached by the browser) and
// put it in the cache `IntlRoot` reads, so the first client render matches the server's.
// A failed load must not block hydration; the UI then shows message keys.
const locale = document.documentElement.lang || DEFAULT_LOCALE;

loadMessages(locale)
  .catch(() => undefined)
  .then(() => {
    startTransition(() => {
      hydrateRoot(
        document,
        <StrictMode>
          <HydratedRouter />
        </StrictMode>
      );
    });
  });
