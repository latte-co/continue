// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnErrorRow } from "./TurnErrorRow";

afterEach(cleanup);

describe("TurnErrorRow", () => {
  const raw429 =
    "API Error: Request rejected (429) · [1302][您的账户已达到速率限制，请您控制请求频率][20261125162645e418428b3b184a3a]";

  it("renders a concise borderless summary row and expands the 22px raw well on demand", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<TurnErrorRow message={raw429} />);

    const toggle = screen.getByRole("button", {
      name: /请求达到速率限制 \(429\)/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain(
      "您的账户已达到速率限制，请您控制请求频率",
    );
    expect(toggle.textContent).not.toContain("1302");
    expect(toggle.textContent).not.toContain("20261125162645e418428b3b184a3a");
    expect(screen.queryByText(raw429)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(raw429)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith(raw429);
    expect(await screen.findByRole("button", { name: "已复制" })).toBeTruthy();
  });

  it("triggers the contextual recovery action independently without opening raw details", () => {
    const onRecover = vi.fn();
    render(
      <TurnErrorRow
        message={raw429}
        action={{ label: "继续", onClick: onRecover }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(raw429)).toBeNull();
  });
});
