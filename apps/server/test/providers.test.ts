import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import {
  MockDifferenceProvider,
  MockFaceMatchProvider,
  MockNarrationProvider,
  MockStoryProvider,
} from "../src/providers/mock.js";
import { AzureSpeechProvider } from "../src/providers/azure-speech.js";
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
    const differences = await new MockDifferenceProvider().analyze(photo("success"));
    const story = await new MockStoryProvider().generate(differences);
    const narration = await new MockNarrationProvider().synthesize(story.content);

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
    expect(story.content).toContain("二十年");
    expect(story.disclaimer).toContain("不代表人物的真实经历");
    expect(narration).toMatchObject({ mimeType: "audio/wav", provider: "mock" });
    expect(Buffer.from(narration.audioBase64, "base64").subarray(0, 4).toString()).toBe("RIFF");
  });

  it("使用 Azure Speech 情感样式合成 MP3 并转义故事文本", async () => {
    let requestBody = "";
    let requestUrl = "";
    let requestHeaders: Headers;
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = String(init?.body);
      return new Response(Buffer.from("mock-mp3"), { status: 200 });
    };
    const credential = {
      getToken: async (scope: string) => {
        expect(scope).toBe("https://cognitiveservices.azure.com/.default");
        return { token: "entra-token" };
      },
    };
    const provider = new AzureSpeechProvider(
      {
        mode: "azure",
        endpoint: "https://svhw2-southeastaisa.cognitiveservices.azure.com/",
        resourceId:
          "/subscriptions/10564893-ecc3-4a6d-b505-53bcbe89dd8e/resourceGroups/jump-server_group/providers/Microsoft.CognitiveServices/accounts/svhw2-southeastaisa",
        voice: "zh-CN-XiaoxiaoNeural",
        style: "affectionate",
      },
      fetchMock,
      credential,
    );

    const narration = await provider.synthesize("温柔地说：你 & 我 <二十年>");

    expect(requestUrl).toBe(
      "https://svhw2-southeastaisa.cognitiveservices.azure.com/tts/cognitiveservices/v1",
    );
    expect(requestHeaders!.get("authorization")).toBe(
      "Bearer aad#/subscriptions/10564893-ecc3-4a6d-b505-53bcbe89dd8e/resourceGroups/jump-server_group/providers/Microsoft.CognitiveServices/accounts/svhw2-southeastaisa#entra-token",
    );
    expect(requestHeaders!.has("ocp-apim-subscription-key")).toBe(false);
    expect(requestBody).toContain('style="affectionate"');
    expect(requestBody).toContain("你 &amp; 我 &lt;二十年&gt;");
    expect(narration).toEqual({
      mimeType: "audio/mpeg",
      audioBase64: Buffer.from("mock-mp3").toString("base64"),
      provider: "azure-speech",
    });
  });

  it.each([
    ["no-face", "NO_FACE"],
    ["multiple-faces", "MULTIPLE_FACES"],
    ["provider-error", "PROVIDER_UNAVAILABLE"],
  ] as const)("把 %s 场景映射为稳定领域错误", async (demoCase, code) => {
    await expect(new MockFaceMatchProvider().match(photo(demoCase))).rejects.toMatchObject({
      code,
    } satisfies Partial<AppError>);
  });
});
