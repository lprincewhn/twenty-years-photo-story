import { describe, expect, it, vi } from "vitest";
import type { AzureFoundryConfig } from "../src/config.js";
import {
  AzureFoundryClient,
  AzureFoundryDifferenceProvider,
  AzureFoundryStoryProvider,
} from "../src/providers/azure-foundry.js";

const config: AzureFoundryConfig = {
  endpoint: "https://foundry.example",
  deployment: "gpt-5.6-sol",
  timeoutMs: 1_000,
};
const credential = {
  getToken: vi.fn(async () => ({ token: "token", expiresOnTimestamp: Date.now() + 60_000 })),
};
const referencePhoto = { bytes: Buffer.from("old"), mimeType: "image/webp" as const };

interface StoryInput {
  differences: unknown[];
  creativeDirection: Record<string, string>;
  variationId: string;
}

function readStoryInput(body: Record<string, unknown>): StoryInput {
  const messages = body.messages as Array<{ content: Array<{ text: string }> }>;
  return JSON.parse(messages[1]!.content[0]!.text) as StoryInput;
}

function completion(content: unknown, status = 200): Response {
  return new Response(JSON.stringify(
    status === 200
      ? { choices: [{ message: { content: JSON.stringify(content) } }] }
      : content,
  ), { status, headers: { "content-type": "application/json" } });
}

describe("Azure Foundry provider", () => {
  it("用同一 GPT-5.6 Sol deployment 分析两张照片并生成故事", async () => {
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
      referencePhoto,
    );
    const signal = new AbortController().signal;
    const story = await new AzureFoundryStoryProvider(client).generate(
      differences, signal, referencePhoto,
    );

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
    expect(bodies.every((body) => body.model === "gpt-5.6-sol")).toBe(true);
    expect(bodies.every((body) =>
      (body.response_format as { type: string }).type === "json_schema")).toBe(true);
    expect(JSON.stringify(bodies[0])).toContain("data:image/webp;base64,");
    expect(JSON.stringify(bodies[0])).toContain("data:image/jpeg;base64,");
    const storyMessages = bodies[1]!.messages as [
      { role: string; content: string },
      { role: string; content: unknown[] },
    ];
    expect(storyMessages[0].content).toContain("使用用户消息中的本次创意坐标");
    expect(storyMessages[0].content).toContain("搞笑、抖梗的的欢乐");
    expect(storyMessages[0].content).toContain("故事主人公二十年前是大学生，而现在是怀念青春的中年人。");
    expect(storyMessages[0].content).toContain("适当补充导致二十年差异的原因和经历");
    expect(storyMessages[0].content).toContain("正文最多500字");
    expect(storyMessages[0].content).toContain("未寄出的明信片");
    expect(storyMessages[0].content).toContain("先识别旧照中直接可见的环境、物件与场景");
    expect(storyMessages[0].content).toContain("不得猜测具体场景");
    expect(storyMessages[1].content).toEqual([
      { type: "text", text: expect.any(String) },
      {
        type: "image_url",
        image_url: { url: "data:image/webp;base64,b2xk", detail: "high" },
      },
    ]);
    expect(JSON.stringify(bodies[1])).not.toContain(Buffer.from("new").toString("base64"));
    const storyInput = readStoryInput(bodies[1]!);
    expect(storyInput.differences).toEqual(differences);
    expect(Object.keys(storyInput.creativeDirection)).toEqual([
      "perspective",
      "structure",
      "rhythm",
      "ending",
    ]);
    expect(storyInput.variationId).toBeTruthy();
    expect(interactionLogs).toHaveLength(4);
    expect(interactionLogs).toMatchObject([
      {
        event: "foundry.request",
        schemaName: "visible_differences",
        deployment: "gpt-5.6-sol",
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
        imageMimeTypes: ["image/webp"],
        promptMessages: [
          { role: "system" },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: {
                  differences: "[已脱敏：1 条可见差异]",
                  creativeDirection: storyInput.creativeDirection,
                  variationId: storyInput.variationId,
                },
              },
              { type: "image_url", image_url: { url: "[图片已脱敏：image/webp]" } },
            ],
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
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        inputs.push({ ...readStoryInput(request) });
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

    await provider.generate([], undefined, referencePhoto);
    await provider.generate([], undefined, referencePhoto);

    expect(inputs[0]!.creativeDirection).not.toEqual(inputs[1]!.creativeDirection);
    expect(inputs.map((input) => input.variationId)).toEqual([
      "variation-1",
      "variation-2",
    ]);
  });

  it("接受眼神类别并允许最多 5 条差异", async () => {
    const differences = [
      { category: "hairstyle", description: "发型不同。" },
      { category: "clothing", description: "服饰不同。" },
      { category: "expression", description: "表情不同。" },
      { category: "accessory", description: "配饰不同。" },
      { category: "gaze", description: "注视方向不同。" },
    ];
    const client = new AzureFoundryClient(config, {
      credential,
      fetch: vi.fn(async () => completion({ differences })) as typeof globalThis.fetch,
    });
    await expect(new AzureFoundryDifferenceProvider(client).analyze(
      { bytes: Buffer.from("new"), mimeType: "image/jpeg", demoCase: "success" },
      referencePhoto,
    )).resolves.toEqual(differences);
  });

  it("缺少匹配旧照时明确报错，不随机编造场景", async () => {
    const fetch = vi.fn();
    const client = new AzureFoundryClient(config, { credential, fetch });
    await expect(new AzureFoundryStoryProvider(client).generate([]))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
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
    await expect(new AzureFoundryStoryProvider(client).generate([], undefined, referencePhoto))
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
      await expect(new AzureFoundryStoryProvider(client).generate([], undefined, referencePhoto))
        .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
    }
  });

  it("拒绝超过 500 字的故事正文", async () => {
    const client = new AzureFoundryClient(config, {
      credential,
      fetch: vi.fn(async () => completion({
        title: "过长故事",
        content: `你在二十年后${"笑".repeat(500)}`,
      })) as typeof globalThis.fetch,
    });
    await expect(new AzureFoundryStoryProvider(client).generate([], undefined, referencePhoto))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
  });
});
