import { describe, expect, it } from "vitest";
import { removeTrailingUnmatchedBraces } from "../src/story-text.js";

describe("story text normalization", () => {
  it.each([
    ["你在二十年后说：“会暖起来。”}", "你在二十年后说：“会暖起来。”"],
    ["故事。} \n}\t", "故事。"],
    ["故事。｝\n", "故事。"],
    ["故事。}｝ }", "故事。"],
    ["故事里的 {约定}}", "故事里的 {约定}"],
    ["故事里的 ｛约定｝｝", "故事里的 ｛约定｝"],
    ["}", ""],
  ])("removes only unmatched trailing braces from %s", (input, expected) => {
    expect(removeTrailingUnmatchedBraces(input)).toBe(expected);
  });

  it.each([
    "你在二十年后说：“会暖起来。”",
    "故事里的 {约定}",
    "故事里的 ｛约定｝",
    '你写下 {"约定":"二十年"}',
    "你写下 }，然后继续讲故事。",
    "故事。\n",
    "",
  ])("preserves legitimate text: %s", (input) => {
    expect(removeTrailingUnmatchedBraces(input)).toBe(input);
  });
});
