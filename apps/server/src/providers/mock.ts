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

interface StoryVariant {
  title: string;
  createContent: (displayName: string, details: string[]) => string;
}

const storyVariants: readonly StoryVariant[] = [
  {
    title: "寄给二十年后的一张明信片",
    createContent: (displayName, details) =>
      `${displayName}在虚构的午后翻开旧相册。${details[0]} ${details[1]} 照片之间仿佛夹着一张未寄出的明信片，提醒人们珍惜每一次真诚的笑容。`,
  },
  {
    title: "相册里的两束光",
    createContent: (displayName, details) =>
      `在这则虚构故事里，两束相隔多年的光落在${displayName}的照片上。${details[1]} ${details[2]} 时间改变了画面里的细节，却把熟悉的从容悄悄留了下来。`,
  },
  {
    title: "旧照片醒来的清晨",
    createContent: (displayName, details) =>
      `假如旧照片会说话，它会在清晨向${displayName}讲起那天的风。${details[2]} ${details[3]} 新旧画面隔着岁月相望，共同收藏了一个温柔的瞬间。`,
  },
  {
    title: "跨越时光的合影",
    createContent: (displayName, details) =>
      `${displayName}在虚构的时光车站遇见了照片里的自己。${details[3]} ${details[0]} 两个身影并肩停留片刻，又带着各自的笑意走向下一段旅程。`,
  },
] as const;

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
  private nextVariantIndex = 0;

  async generate(
    displayName: string,
    differences: VisibleDifference[],
  ): Promise<FictionStory> {
    const details = differences.map((item) => item.description);
    const fallbackDetail = "照片保留了自然、温暖的瞬间。";
    const paddedDetails = Array.from(
      { length: 4 },
      (_, index) => details[index % Math.max(details.length, 1)] ?? fallbackDetail,
    );
    const variant = storyVariants[this.nextVariantIndex];
    if (!variant) {
      throw new Error("mock 故事模板配置无效");
    }
    this.nextVariantIndex = (this.nextVariantIndex + 1) % storyVariants.length;

    return {
      label: "AI 创作/虚构",
      title: variant.title,
      content: variant.createContent(displayName, paddedDetails),
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
