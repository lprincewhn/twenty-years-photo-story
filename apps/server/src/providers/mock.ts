import { AppError, faceCountError } from "../errors.js";
import type {
  DifferenceProvider,
  FaceMatchProvider,
  FictionStory,
  PhotoInput,
  ProviderSet,
  StoryProvider,
  VisibleDifference,
} from "./types.js";

function failWhenRequested(photo: PhotoInput): void {
  if (photo.demoCase === "provider-error") {
    throw new AppError(
      502,
      "PROVIDER_UNAVAILABLE",
      "分析服务暂时不可用",
      "照片没有被保存。请稍后再试，或返回重新选择照片。",
      true,
    );
  }
}

export class MockFaceMatchProvider implements FaceMatchProvider {
  async match(photo: PhotoInput) {
    failWhenRequested(photo);
    if (photo.demoCase === "no-face") {
      throw faceCountError(0);
    }
    if (photo.demoCase === "multiple-faces") {
      throw faceCountError(2);
    }
    return {
      faceCount: 1,
      candidates: [
        {
          personId: "demo-xiaoxia",
          score: photo.demoCase === "unmatched" ? 0.61 : 0.94,
        },
      ],
    };
  }
}

export class MockDifferenceProvider implements DifferenceProvider {
  async analyze(photo: PhotoInput): Promise<VisibleDifference[]> {
    failWhenRequested(photo);
    return [
      { category: "hairstyle", description: "发型从齐耳短发变为自然长发。" },
      { category: "clothing", description: "旧照是浅色校服风上衣，新照是蓝色外套。" },
      { category: "expression", description: "两张照片里都能看到放松的微笑。" },
      { category: "accessory", description: "新照中多了一副圆框眼镜。" },
    ];
  }
}

export class MockStoryProvider implements StoryProvider {
  async generate(
    displayName: string,
    differences: VisibleDifference[],
  ): Promise<FictionStory> {
    const details = differences.slice(0, 2).map((item) => item.description).join(" ");
    return {
      label: "AI 创作/虚构",
      title: "寄给二十年后的一张明信片",
      content: `${displayName}在虚构的午后翻开旧相册。${details} 照片之间仿佛夹着一张未寄出的明信片，提醒人们珍惜每一次真诚的笑容。`,
      disclaimer: "本故事由 AI 根据可见元素虚构，不代表人物的真实经历。",
    };
  }
}

export function createMockProviders(): ProviderSet {
  return {
    faceMatch: new MockFaceMatchProvider(),
    difference: new MockDifferenceProvider(),
    story: new MockStoryProvider(),
  };
}
