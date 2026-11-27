// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderAnsiText, stripAnsi } from "./ansi";

describe("ansi terminal sanitizer and SGR renderer", () => {
  it("returns plain strings untouched without extra wrapper nodes", () => {
    const plain = "Exit code 255\n---SOURCE---\nnormal output";
    expect(stripAnsi(plain)).toBe(plain);
    expect(renderAnsiText(plain)).toBe(plain);
  });

  it("renders SGR color and bold codes from CLI tools without leaking 0x1B tofu characters", () => {
    const raw =
      "\x1b[32;1mInfo:\x1b[0m Use TOS Bucket doas-user-binary for updates\n" +
      "\x1b[31mError:\x1b[m failed";
    expect(stripAnsi(raw)).toBe(
      "Info: Use TOS Bucket doas-user-binary for updates\nError: failed",
    );

    const { container } = render(<pre>{renderAnsiText(raw)}</pre>);
    expect(container.textContent).toBe(
      "Info: Use TOS Bucket doas-user-binary for updates\nError: failed",
    );
    expect(container.textContent).not.toContain("\x1b");

    const infoSpan = container.querySelector(".ansi-bold.ansi-fg-green");
    expect(infoSpan?.textContent).toBe("Info:");
    const errSpan = container.querySelector(".ansi-fg-red");
    expect(errSpan?.textContent).toBe("Error:");
  });

  it("strips non-SGR CSI cursor codes, OSC hyperlinks, extended 256/truecolor sequences, and stray ESC bytes", () => {
    const noisy =
      "\x1b[?25l\x1b]0;window-title\x07\x1b[38;5;208mWarn:\x1b[38;2;10;20;30m ok\x1b[2K\x1b[?25h\x1b";
    expect(stripAnsi(noisy)).toBe("Warn: ok");
    const { container } = render(<pre>{renderAnsiText(noisy)}</pre>);
    expect(container.textContent).toBe("Warn: ok");
  });
});
