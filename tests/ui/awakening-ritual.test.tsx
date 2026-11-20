// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AwakeningRitual } from "../../components/AwakeningRitual";

const noop = (): void => {};

describe("AwakeningRitual portal", () => {
  it("renders the overlay as a direct child of document.body, outside the form container", () => {
    const { container } = render(
      <div data-testid="form-container" style={{ transform: "translateY(0)" }}>
        <AwakeningRitual kind="summon" summonStatus="pending" onDone={noop} onClosed={noop} />
      </div>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.parentElement).toBe(document.body);
    expect(container.contains(dialog)).toBe(false);
    expect(screen.getByTestId("form-container")).not.toContainElement(dialog);
    expect(dialog.className).toMatch(/\binset-0\b/);
    expect(dialog.className).toMatch(/\bh-dvh\b/);
    expect(dialog.className).toMatch(/\bw-screen\b/);
  });

  it("locks body scroll while open and restores the previous value on close", () => {
    document.body.style.overflow = "scroll";
    const { unmount } = render(
      <AwakeningRitual kind="summon" summonStatus="pending" onDone={noop} onClosed={noop} />,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("scroll");
    expect(screen.queryByRole("dialog")).toBeNull();
    document.body.style.overflow = "";
  });
});
