export const allowedDifferenceCategories = [
  "hairstyle",
  "clothing",
  "expression",
  "accessory",
] as const;

export type DifferenceCategory = (typeof allowedDifferenceCategories)[number];
export type DemoCase =
  | "success"
  | "no-face"
  | "multiple-faces"
  | "unmatched"
  | "provider-error";

export interface PhotoInput {
  bytes: Buffer;
  mimeType: string;
  demoCase: DemoCase;
}

export interface MatchCandidate {
  personId: string;
  score: number;
}

export interface FaceMatchOutput {
  faceCount: number;
  candidates: MatchCandidate[];
}

export interface VisibleDifference {
  category: DifferenceCategory;
  description: string;
}

export interface FictionStory {
  label: "AI 创作/虚构";
  title: string;
  content: string;
  disclaimer: string;
}

export interface Narration {
  mimeType: "audio/mpeg" | "audio/wav";
  audioBase64: string;
  provider: "azure-speech" | "mock";
}

export interface FaceMatchProvider {
  match(photo: PhotoInput): Promise<FaceMatchOutput>;
}

export interface DifferenceProvider {
  analyze(photo: PhotoInput, personId: string): Promise<VisibleDifference[]>;
}

export interface StoryProvider {
  generate(displayName: string, differences: VisibleDifference[]): Promise<FictionStory>;
}

export interface NarrationProvider {
  synthesize(text: string): Promise<Narration>;
}

export interface ProviderSet {
  faceMatch: FaceMatchProvider;
  difference: DifferenceProvider;
  story: StoryProvider;
  narration: NarrationProvider;
}
