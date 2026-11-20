// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("dom test infrastructure", () => {
  it("renders an element into jsdom", () => {
    render(<p>raised</p>);
    expect(screen.getByText("raised")).toBeInTheDocument();
  });
});
