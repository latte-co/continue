// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandLogo } from "./BrandLogo";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("BrandLogo", () => {
  it("maps live session status to idle, working, waiting, and completion celebration moods", () => {
    vi.useFakeTimers();
    const view = render(<BrandLogo sessionKey="s1" status="ready" />);
    const mark = () =>
      view.container.querySelector(".brand-mark") as HTMLElement;

    expect(mark().dataset.mood).toBe("idle");

    view.rerender(<BrandLogo sessionKey="s1" status="running" />);
    expect(mark().dataset.mood).toBe("working");

    view.rerender(<BrandLogo sessionKey="s1" status="waiting" />);
    expect(mark().dataset.mood).toBe("waiting");

    view.rerender(<BrandLogo sessionKey="s1" status="completed" />);
    expect(mark().dataset.mood).toBe("done");

    act(() => {
      vi.advanceTimersByTime(950);
    });
    expect(mark().dataset.mood).toBe("idle");
  });

  it("does not celebrate merely when switching between already-completed sessions", () => {
    const view = render(<BrandLogo sessionKey="s1" status="running" />);
    view.rerender(<BrandLogo sessionKey="s2" status="completed" />);
    const mark = view.container.querySelector(".brand-mark") as HTMLElement;
    expect(mark.dataset.mood).toBe("idle");
  });
});
