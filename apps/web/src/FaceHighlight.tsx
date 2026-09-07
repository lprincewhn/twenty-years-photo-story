import type { ExperienceResult } from "./api";

type FaceBox = NonNullable<ExperienceResult["match"]["person"]["faceBox"]>;

export function FaceHighlight({ faceBox }: { faceBox: FaceBox }) {
  // Leave a quarter-face margin on each side, bounded by the photo edges.
  const left = Math.max(0, faceBox.left - faceBox.width * 0.25);
  const top = Math.max(0, faceBox.top - faceBox.height * 0.25);
  const right = Math.min(1, faceBox.left + faceBox.width * 1.25);
  const bottom = Math.min(1, faceBox.top + faceBox.height * 1.25);

  return (
    <span
      className="face-highlight"
      aria-label="匹配人物位置"
      style={{
        left: `${left * 100}%`,
        top: `${top * 100}%`,
        width: `${(right - left) * 100}%`,
        height: `${(bottom - top) * 100}%`,
      }}
    />
  );
}
