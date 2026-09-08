export function removeTrailingUnmatchedBraces(text: string): string {
  const unmatched = new Set<number>();
  const balance = { "}": 0, "｝": 0 };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") balance["}"] += 1;
    if (character === "｛") balance["｝"] += 1;
    if (character === "}" || character === "｝") {
      if (balance[character] > 0) balance[character] -= 1;
      else unmatched.add(index);
    }
  }

  // Only remove unmatched closing braces at the end, never balanced story text.
  let end = text.trimEnd().length;
  if (!unmatched.has(end - 1)) return text;
  while (unmatched.has(end - 1)) {
    end = text.slice(0, end - 1).trimEnd().length;
  }
  return text.slice(0, end);
}
