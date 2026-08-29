import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import {
  MockDifferenceProvider,
  MockFaceMatchProvider,
  MockStoryProvider,
} from "../src/providers/mock.js";
import type { PhotoInput } from "../src/providers/types.js";

function photo(demoCase: PhotoInput["demoCase"]): PhotoInput {
  return {
    bytes: Buffer.from("模拟图片"),
    mimeType: "image/jpeg",
    demoCase,
  };
}

describe("mock provider", () => {
  it("无需密钥即可返回匹配、可见差异和虚构故事", async () => {
    const face = await new MockFaceMatchProvider().match(photo("success"));
    const differences = await new MockDifferenceProvider().analyze(
      photo("success"),
      face.candidates[0]!.personId,
    );
    const story = await new MockStoryProvider().generate("示例人物", differences);

    expect(face).toEqual({
      faceCount: 1,
      candidates: [{ personId: "demo-xiaoxia", score: 0.94 }],
    });
    expect(differences.map((item) => item.category)).toEqual([
      "hairstyle",
      "clothing",
      "expression",
      "accessory",
    ]);
    expect(story.label).toBe("AI 创作/虚构");
    expect(story.disclaimer).toContain("不代表人物的真实经历");
  });

  it.each([
    ["no-face", "NO_FACE"],
    ["multiple-faces", "MULTIPLE_FACES"],
    ["provider-error", "PROVIDER_UNAVAILABLE"],
  ] as const)("把 %s 场景映射为稳定领域错误", async (demoCase, code) => {
    await expect(new MockFaceMatchProvider().match(photo(demoCase))).rejects.toMatchObject<
      Partial<AppError>
    >({ code });
  });
});

