import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";

import { DEFAULT_LOCALE } from "./config";
import { getLoadedMessages } from "./messages";

interface IntlRootProps {
  /** `locale`, `timeZone` and `now` from the root loader (`getRootIntlData`). */
  locale?: string;
  timeZone?: string;
  now?: string;
  children: ReactNode;
}

/**
 * The one i18n provider, wrapped around the whole document. The catalog is read from the
 * cache that the root loader fills on the server and `entry.client.tsx` fills in the browser
 * before hydrating, so it is never serialised into the HTML. When it is not available (an
 * error before the loader ran), components fall back to rendering message keys.
 */
export function IntlRoot({ locale = DEFAULT_LOCALE, timeZone, now, children }: IntlRootProps) {
  return (
    <IntlProvider
      locale={locale}
      messages={getLoadedMessages(locale)}
      timeZone={timeZone}
      now={now ? new Date(now) : undefined}
    >
      {children}
    </IntlProvider>
  );
}
