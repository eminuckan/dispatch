import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));

import { Route } from "./__root";

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
});

it("recovers from a transient root route render failure with Try again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now++);
  let shouldThrow = true;
  function TransientlyFailingRoute() {
    if (shouldThrow) throw new Error("temporary render failure");
    return <span>Recovered route</span>;
  }
  const rootErrorView = Route.options.errorComponent as
    | ((props: ErrorComponentProps) => React.ReactNode)
    | undefined;
  expect(rootErrorView).toBeDefined();

  const router = createRouter({
    routeTree: createRootRoute({
      component: TransientlyFailingRoute,
      errorComponent: rootErrorView,
    }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(() => {
    renderer = create(<RouterProvider router={router} />);
  });
  expect(
    renderer!.root
      .findAllByType("button")
      .some((button) => button.children.join("").includes("Try again")),
  ).toBe(true);

  shouldThrow = false;
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((button) => button.children.join("").includes("Try again"))!
      .props.onClick();
    await router.load();
  });

  expect(renderer!.root.findByType("span").children.join("")).toBe("Recovered route");
});
