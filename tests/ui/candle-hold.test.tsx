// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CandleHold } from "../../components/CandleHold";

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function setup(props: { disabled?: boolean } = {}) {
  const onRelease = vi.fn(async () => {});
  render(<CandleHold onRelease={onRelease} {...props} />);
  return { onRelease, button: screen.getByRole("button", { name: "Hold to release" }) };
}

describe("CandleHold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.removeAttribute("data-still");
    vi.unstubAllGlobals();
  });

  it("sends nothing when the pointer is released at 1000 ms", () => {
    const { onRelease, button } = setup();
    fireEvent.pointerDown(button);
    advance(1000);
    fireEvent.pointerUp(button);
    advance(3000);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("sends exactly once after a 2000 ms pointer hold, then shows Released and disables", async () => {
    const { onRelease, button } = setup();
    fireEvent.pointerDown(button);
    advance(2100);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Released");
    expect(button).toBeDisabled();
  });

  it("sends once for Space held 2000 ms, and keyup early cancels", async () => {
    const { onRelease, button } = setup();
    fireEvent.keyDown(button, { key: " " });
    advance(1000);
    fireEvent.keyUp(button, { key: " " });
    advance(3000);
    expect(onRelease).not.toHaveBeenCalled();

    fireEvent.keyDown(button, { key: " " });
    advance(2100);
    fireEvent.keyUp(button, { key: " " });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("ignores auto-repeat keydown: it neither restarts nor shortens the hold", () => {
    const { onRelease, button } = setup();
    fireEvent.keyDown(button, { key: "Enter" });
    advance(1500);
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    advance(400);
    expect(onRelease).not.toHaveBeenCalled(); // restart would also be silent; check the end below
    advance(200);
    expect(onRelease).toHaveBeenCalledTimes(1); // 2100 ms since the first keydown
  });

  it("cancels on blur", () => {
    const { onRelease, button } = setup();
    fireEvent.keyDown(button, { key: " " });
    advance(1000);
    fireEvent.blur(button);
    advance(3000);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("prevents the context menu", () => {
    const { button } = setup();
    expect(fireEvent.contextMenu(button)).toBe(false);
  });

  it("shows the text countdown under reduced motion and still needs 2000 ms", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { onRelease, button } = setup();
    fireEvent.pointerDown(button);
    advance(500);
    expect(button).toHaveTextContent(/Hold… 1\.5 s/);
    advance(1000);
    expect(onRelease).not.toHaveBeenCalled();
    advance(600);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("shows the countdown in Still mode", () => {
    document.documentElement.setAttribute("data-still", "true");
    const { button } = setup();
    fireEvent.pointerDown(button);
    advance(1000);
    expect(button).toHaveTextContent(/Hold… 1\.0 s/);
  });

  it("does nothing when disabled", () => {
    const { onRelease, button } = setup({ disabled: true });
    fireEvent.pointerDown(button);
    advance(3000);
    expect(button).toBeDisabled();
    expect(onRelease).not.toHaveBeenCalled();
  });
});
