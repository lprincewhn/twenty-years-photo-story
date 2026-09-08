import { describe, expect, it } from "vitest";
import { selectRandomEligibleCandidate } from "../src/app.js";
import { summarizeMatchedPhotos } from "../src/match-summary.js";

const people = [
  { id: "highest", oldPhotoFile: "highest.jpg" },
  { id: "lowest", oldPhotoFile: "lowest.jpg" },
  { id: "selected", oldPhotoFile: "selected.jpg" },
  { id: "other-face", oldPhotoFile: "highest.jpg" },
];

describe("matched photo summary", () => {
  it("does not truncate 100 eligible photos to five", () => {
    const photos = Array.from({ length: 100 }, (_, index) => ({
      id: `person-${index}`,
      oldPhotoFile: `photo-${index}.jpg`,
    }));
    const { eligibleCandidates, candidate } = selectRandomEligibleCandidate(
      photos.map((photo) => ({ personId: photo.id, score: 0.9 })),
      0.6,
      () => 99,
    );
    expect(candidate?.personId).toBe("person-99");
    expect(summarizeMatchedPhotos(eligibleCandidates, photos, "photo-99.jpg").count).toBe(100);
  });

  it("summarizes all strictly eligible photos, independently of random selection", () => {
    const { eligibleCandidates, candidate } = selectRandomEligibleCandidate([
      { personId: "lowest", score: 0.85 },
      { personId: "at-threshold", score: 0.82 },
      { personId: "highest", score: 0.99 },
      { personId: "selected", score: 0.94 },
      { personId: "below", score: 0.3 },
    ], 0.82, () => 2);
    expect(candidate?.personId).toBe("selected");
    const summary = summarizeMatchedPhotos(eligibleCandidates, people, "selected.jpg");
    expect(summary).toEqual({
      count: 3,
      averageScore: expect.closeTo((0.85 + 0.99 + 0.94) / 3),
      highestScore: 0.99,
      highestPhotoPath: "highest.jpg",
      lowestPhotoPath: "lowest.jpg",
      selectedPhotoPath: "selected.jpg",
    });
  });

  it("counts a group photo once using the best face score", () => {
    const summary = summarizeMatchedPhotos([
      { personId: "highest", score: 0.99 },
      { personId: "other-face", score: 0.86 },
      { personId: "selected", score: 0.91 },
    ], people, "highest.jpg");
    expect(summary.count).toBe(2);
    expect(summary.averageScore).toBeCloseTo(0.95);
    expect(summary.lowestPhotoPath).toBe("selected.jpg");
  });

  it("uses the same path for all three fields with a single photo", () => {
    expect(summarizeMatchedPhotos([
      { personId: "selected", score: 0.94 },
    ], people, "selected.jpg")).toEqual({
      count: 1,
      averageScore: 0.94,
      highestScore: 0.94,
      highestPhotoPath: "selected.jpg",
      lowestPhotoPath: "selected.jpg",
      selectedPhotoPath: "selected.jpg",
    });
  });

  it("resolves tied scores deterministically in provider order", () => {
    const summary = summarizeMatchedPhotos([
      { personId: "highest", score: 0.94 },
      { personId: "lowest", score: 0.94 },
    ], people, "lowest.jpg");
    expect(summary.highestPhotoPath).toBe("highest.jpg");
    expect(summary.lowestPhotoPath).toBe("lowest.jpg");
  });

  it("does not fabricate statistics when no candidate exceeds the threshold", () => {
    const selection = selectRandomEligibleCandidate([
      { personId: "selected", score: 0.82 },
    ], 0.82);
    expect(selection.candidate).toBeUndefined();
    expect(selection.eligibleCandidates).toEqual([]);
    expect(() => summarizeMatchedPhotos([], people, "selected.jpg")).toThrow();
  });

  it("rejects candidates outside the authorized library", () => {
    expect(() => summarizeMatchedPhotos([
      { personId: "unknown", score: 0.99 },
    ], people, "selected.jpg")).toThrow("provider 候选不在授权人物库");
  });
});
