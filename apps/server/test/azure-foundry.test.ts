import { describe, expect, it, vi } from "vitest";
import type { AzureFoundryConfig } from "../src/config.js";
import {
  AzureFoundryClient,
  AzureFoundryDifferenceProvider,
  AzureFoundryStoryProvider,
} from "../src/providers/azure-foundry.js";

const config: AzureFoundryConfig = {
  endpoint: "https://foundry.example",
  deployment: "gpt-5.6-terra",
  timeoutMs: 1_000,
};
const credential = {
  getToken: vi.fn(async () => ({ token: "token", expiresOnTimestamp: Date.now() + 60_000 })),
};

function completion(content: unknown, status = 200): Response {
  return new Response(JSON.stringify(
    status === 200
      ? { choices: [{ message: { content: JSON.stringify(content) } }] }
      : content,
  ), { status, headers: { "content-type": "application/json" } });
}

describe("Azure Foundry provider", () => {
  it("用同一 GPT-5.6 Terra deployment 分析两张照片并生成故事", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const interactionLogs: unknown[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return bodies.length === 1
        ? completion({
            differences: [{
              category: "hairstyle",
              description: "发型由短发变为长发。",
            }],
          })
        : completion({
            title: "相册的一页",
            content: "你翻开相册，看见二十年前与现在之间温暖的虚构故事。",
          });
    });
    const client = new AzureFoundryClient(config, {
      credential,
      fetch: fetch as typeof globalThis.fetch,
      log: (entry) => interactionLogs.push(entry),
    });
    const differences = await new AzureFoundryDifferenceProvider(client).analyze(
      { bytes: Buffer.from("new"), mimeType: "image/jpeg", demoCase: "success" },
      { bytes: Buffer.from("old"), mimeType: "image/webp" },
    );
    const story = await new AzureFoundryStoryProvider(client).generate(differences);

    expect(differences).toEqual([{
      category: "hairstyle",
      description: "发型由短发变为长发。",
    }]);
    expect(story).toMatchObject({
      label: "AI 创作/虚构",
      title: "相册的一页",
    });
    expect(story.content).toContain("你");
    expect(story.content).toContain("二十年");
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.model === "gpt-5.6-terra")).toBe(true);
    expect(bodies.every((body) =>
      (body.response_format as { type: string }).type === "json_schema")).toBe(true);
    expect(JSON.stringify(bodies[0])).toContain("data:image/webp;base64,");
    expect(JSON.stringify(bodies[0])).toContain("data:image/jpeg;base64,");
    const storyMessages = bodies[1]!.messages as Array<{ role: string; content: string }>;
    expect(storyMessages[0]!.content).toContain("使用用户消息中的本次创意坐标");
    expect(storyMessages[0]!.content).toContain("搞笑、抖梗的的欢乐");
    expect(storyMessages[0]!.content).toContain("适当补充导致二十年差异的原因和经历");
    expect(storyMessages[0]!.content).not.toContain("不得补充敏感属性");
    expect(storyMessages[0]!.content).toContain("未寄出的明信片");
    const storyInput = JSON.parse(storyMessages[1]!.content) as {
      creativeDirection: Record<string, string>;
      variationId: string;
    };
    expect(Object.keys(storyInput.creativeDirection)).toEqual([
      "perspective",
      "structure",
      "setting",
      "rhythm",
      "ending",
    ]);
    expect(storyInput.variationId).toBeTruthy();
    expect(interactionLogs).toHaveLength(4);
    expect(interactionLogs).toMatchObject([
      {
        event: "foundry.request",
        schemaName: "visible_differences",
        deployment: "gpt-5.6-terra",
        messageRoles: ["system", "user"],
        imageMimeTypes: ["image/webp", "image/jpeg"],
        promptMessages: [
          { role: "system" },
          {
            role: "user",
            content: [
              { type: "text", text: "第一张是人物库旧照，第二张是用户当前照片。请输出可见差异。" },
              { type: "image_url", image_url: { url: "[图片已脱敏：image/webp]" } },
              { type: "image_url", image_url: { url: "[图片已脱敏：image/jpeg]" } },
            ],
          },
        ],
      },
      {
        event: "foundry.response",
        schemaName: "visible_differences",
        outcome: "success",
        httpStatus: 200,
      },
      {
        event: "foundry.request",
        schemaName: "fiction_story",
        imageMimeTypes: [],
        promptMessages: [
          { role: "system" },
          {
            role: "user",
            content: {
              differences: "[已脱敏：1 条可见差异]",
              creativeDirection: storyInput.creativeDirection,
              variationId: storyInput.variationId,
            },
          },
        ],
      },
      {
        event: "foundry.response",
        schemaName: "fiction_story",
        outcome: "success",
        httpStatus: 200,
      },
    ]);
    const serializedLogs = JSON.stringify(interactionLogs);
    expect(serializedLogs).not.toContain("base64");
    expect(serializedLogs).not.toContain("发型由短发变为长发");
    expect(serializedLogs).not.toContain("相册的一页");
    expect(serializedLogs).toContain("搞笑、抖梗的的欢乐");
  });

  it("连续调用时即使随机值相同也排除最近使用的创意坐标", async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const client = new AzureFoundryClient(config, {
      credential,
      fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          messages: Array<{ content: string }>;
        };
        inputs.push(JSON.parse(request.messages[1]!.content) as Record<string, unknown>);
        return completion({
          title: "灯光下的重逢",
          content: "你听见一声轻响，二十年的光阴在这个虚构瞬间里轻轻交汇。",
        });
      }) as typeof globalThis.fetch,
    });
    let variationNumber = 0;
    const provider = new AzureFoundryStoryProvider(client, {
      randomIndex: () => 0,
      variationId: () => `variation-${variationNumber += 1}`,
    });

    await provider.generate([]);
    await provider.generate([]);

    expect(inputs[0]!.creativeDirection).not.toEqual(inputs[1]!.creativeDirection);
    expect(inputs.map((input) => input.variationId)).toEqual([
      "variation-1",
      "variation-2",
    ]);
  });

  it.each([
    [429, "RATE_LIMITED", true],
    [401, "PROVIDER_UNAVAILABLE", false],
    [500, "PROVIDER_UNAVAILABLE", true],
  ])("映射 HTTP %i 错误", async (status, code, retryable) => {
    const client = new AzureFoundryClient(config, {
      credential,
      fetch: vi.fn(async () => completion({}, status)) as typeof globalThis.fetch,
    });
    await expect(new AzureFoundryStoryProvider(client).generate([]))
      .rejects.toMatchObject({ code, retryable });
  });

  it("拒绝不符合白名单 schema 的差异结果", async () => {
    const client = new AzureFoundryClient(config, {
      credential,
      fetch: vi.fn(async () => completion({
        differences: [{ category: "age", description: "年龄变化" }],
      })) as typeof globalThis.fetch,
    });
    await expect(new AzureFoundryDifferenceProvider(client).analyze(
      { bytes: Buffer.from("new"), mimeType: "image/jpeg", demoCase: "success" },
      { bytes: Buffer.from("old"), mimeType: "image/jpeg" },
    )).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
  });

  it("拒绝未使用第二人称、缺少二十年跨度或混用第三人称的故事", async () => {
    const responses = [
      { title: "相册", content: "二十年后，她翻开了一本旧相册。" },
      { title: "相册", content: "你看见他在二十年后翻开旧相册。" },
      { title: "相册", content: "你翻开了一本旧相册。" },
    ];
    for (const response of responses) {
      const client = new AzureFoundryClient(config, {
        credential,
        fetch: vi.fn(async () => completion(response)) as typeof globalThis.fetch,
      });
      await expect(new AzureFoundryStoryProvider(client).generate([]))
        .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
    }
  });
});
