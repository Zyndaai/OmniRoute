// @vitest-environment jsdom
//
// clientOnlyLazy replaces next/dynamic(load, { ssr: false }): the server render (and the first
// browser render, so hydration matches) shows only the fallback; the browser then loads the
// chunk and renders the component with its props.
import React from "react";
import { renderToString } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { clientOnlyLazy } from "@/shared/components/ClientOnly";

function Greeting({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

describe("clientOnlyLazy", () => {
  it("renders only the fallback on the server and never loads the chunk there", () => {
    const load = vi.fn(async () => ({ default: Greeting }));
    const Lazy = clientOnlyLazy(load, <span>loading</span>);
    const html = renderToString(<Lazy name="Ada" />);
    expect(html).toContain("loading");
    expect(html).not.toContain("Hello");
    expect(load).not.toHaveBeenCalled();
  });

  it("loads and renders the component with its props in the browser", async () => {
    const Lazy = clientOnlyLazy(async () => ({ default: Greeting }));
    render(<Lazy name="Ada" />);
    expect(await screen.findByText("Hello Ada")).toBeTruthy();
  });

  it("works for a named export mapped to default", async () => {
    const Lazy = clientOnlyLazy(() =>
      Promise.resolve({ Named: Greeting }).then((m) => ({ default: m.Named }))
    );
    render(<Lazy name="Grace" />);
    expect(await screen.findByText("Hello Grace")).toBeTruthy();
  });
});
