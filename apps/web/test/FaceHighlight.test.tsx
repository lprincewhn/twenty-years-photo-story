import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FaceHighlight } from "../src/FaceHighlight";

describe("FaceHighlight", () => {
  it.each([
    {
      name: "centered portrait face",
      faceBox: { left: 0.2, top: 0.15, width: 0.3, height: 0.4 },
      expected: { left: 12.5, top: 5, width: 45, height: 60 },
    },
    {
      name: "top-left edge",
      faceBox: { left: 0.01, top: 0.02, width: 0.2, height: 0.3 },
      expected: { left: 0, top: 0, width: 26, height: 39.5 },
    },
    {
      name: "bottom-right edge",
      faceBox: { left: 0.8, top: 0.7, width: 0.2, height: 0.3 },
      expected: { left: 75, top: 62.5, width: 25, height: 37.5 },
    },
    {
      name: "full-photo face",
      faceBox: { left: 0, top: 0, width: 1, height: 1 },
      expected: { left: 0, top: 0, width: 100, height: 100 },
    },
    {
      name: "small face in a group photo",
      faceBox: { left: 0.4, top: 0.4, width: 0.02, height: 0.03 },
      expected: { left: 39.5, top: 39.25, width: 3, height: 4.5 },
    },
    {
      name: "wide face box",
      faceBox: { left: 0.3, top: 0.4, width: 0.4, height: 0.2 },
      expected: { left: 20, top: 35, width: 60, height: 30 },
    },
  ])("expands $name without moving outside the photo", ({ faceBox, expected }) => {
    const original = { ...faceBox };
    render(<FaceHighlight faceBox={faceBox} />);
    const highlight = screen.getByLabelText("匹配人物位置");

    for (const property of ["left", "top", "width", "height"] as const) {
      expect(highlight.style[property]).toMatch(/%$/);
      expect(parseFloat(highlight.style[property])).toBeCloseTo(expected[property]);
    }
    expect(highlight).toBeEmptyDOMElement();
    expect(faceBox).toEqual(original);
  });
});
