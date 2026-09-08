import type { ResolvedPersonEntry } from "./people.js";
import type { MatchCandidate } from "./providers/types.js";

export function summarizeMatchedPhotos(
  eligibleCandidates: MatchCandidate[],
  people: Pick<ResolvedPersonEntry, "id" | "oldPhotoFile">[],
  selectedPhotoPath: string,
) {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const scoresByPhoto = new Map<string, number>();
  for (const candidate of eligibleCandidates) {
    const person = peopleById.get(candidate.personId);
    if (!person) throw new Error("provider 候选不在授权人物库");
    // A group photo counts once, using its best matching face.
    scoresByPhoto.set(
      person.oldPhotoFile,
      Math.max(scoresByPhoto.get(person.oldPhotoFile) ?? 0, candidate.score),
    );
  }
  const photos = [...scoresByPhoto].sort((a, b) => b[1] - a[1]);
  const highest = photos[0];
  const lowest = photos.at(-1);
  if (!highest || !lowest || !scoresByPhoto.has(selectedPhotoPath)) {
    throw new Error("匹配照片统计缺少达标或已选照片");
  }
  return {
    count: photos.length,
    averageScore: photos.reduce((sum, [, score]) => sum + score, 0) / photos.length,
    highestScore: highest[1],
    highestPhotoPath: highest[0],
    lowestPhotoPath: lowest[0],
    selectedPhotoPath,
  };
}
