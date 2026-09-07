import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FaceHighlight } from "../src/FaceHighlight";
import styles from "../src/styles.css?raw";

describe("FaceHighlight", () => {
  it.each([
    {
      name: "centered portrait face",
      faceBox: { left: 0.2, top: 0.15, width: 0.3, height: 0.4 },
      expected: { left: 5, top: 0, width: 60, height: 75 },
    },
    {
      name: "top-left edge",
      faceBox: { left: 0.01, top: 0.02, width: 0.2, height: 0.3 },
      expected: { left: 0, top: 0, width: 31, height: 47 },
    },
    {
      name: "bottom-right edge",
      faceBox: { left: 0.8, top: 0.7, width: 0.2, height: 0.3 },
      expected: { left: 70, top: 55, width: 30, height: 45 },
    },
    {
      name: "full-photo face",
      faceBox: { left: 0, top: 0, width: 1, height: 1 },
      expected: { left: 0, top: 0, width: 100, height: 100 },
    },
    {
      name: "small face in a group photo",
      faceBox: { left: 0.4, top: 0.4, width: 0.02, height: 0.03 },
      expected: { left: 39, top: 38.5, width: 4, height: 6 },
    },
    {
      name: "wide face box",
      faceBox: { left: 0.3, top: 0.4, width: 0.4, height: 0.2 },
      expected: { left: 10, top: 30, width: 80, height: 40 },
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

  it("draws only one thin outline outside the box, without a second shadow frame", () => {
    const stylesheet = document.createElement("style");
    stylesheet.textContent = styles;
    document.head.append(stylesheet);
    try {
      render(<FaceHighlight faceBox={{ left: 0.4, top: 0.4, width: 0.02, height: 0.03 }} />);
      const highlights = screen.getAllByLabelText("匹配人物位置");
      expect(highlights).toHaveLength(1);
      const highlight = highlights[0]!;
      const style = getComputedStyle(highlight);
      expect(style.outline).toBe("2px solid #ffdf52");
      expect(style.outlineOffset).toBe("2px");
      expect(style.boxShadow).toBe("none");
      expect(parseFloat(style.borderTopWidth) || 0).toBe(0);
      expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(style.pointerEvents).toBe("none");
      expect(highlight).toBeEmptyDOMElement();
    } finally {
      stylesheet.remove();
    }
  });
});
