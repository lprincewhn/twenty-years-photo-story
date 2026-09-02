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
        : completion({ title: "相册的一页", content: "你翻开相册，读到一段温暖的虚构故事。" });
    });
    const client = new AzureFoundryClient(config, {
      credential,
      fetch: fetch as typeof globalThis.fetch,
    });
    const differences = await new AzureFoundryDifferenceProvider(client).analyze(
      { bytes: Buffer.from("new"), mimeType: "image/jpeg", demoCase: "success" },
      { bytes: Buffer.from("old"), mimeType: "image/webp" },
    );
    const story = await new AzureFoundryStoryProvider(client).generate("家人", differences);

    expect(differences).toEqual([{
      category: "hairstyle",
      description: "发型由短发变为长发。",
    }]);
    expect(story).toMatchObject({
      label: "AI 创作/虚构",
      title: "相册的一页",
    });
    expect(story.content).toContain("你");
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.model === "gpt-5.6-terra")).toBe(true);
    expect(bodies.every((body) =>
      (body.response_format as { type: string }).type === "json_schema")).toBe(true);
    expect(JSON.stringify(bodies[0])).toContain("data:image/webp;base64,");
    expect(JSON.stringify(bodies[0])).toContain("data:image/jpeg;base64,");
    expect(JSON.stringify(bodies[1])).not.toContain("家人");
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
    await expect(new AzureFoundryStoryProvider(client).generate("人物", []))
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

  it("拒绝没有使用第二人称或混用第三人称的故事", async () => {
    const responses = [
      { title: "相册", content: "她翻开了一本旧相册。" },
      { title: "相册", content: "你看见他翻开了一本旧相册。" },
    ];
    for (const response of responses) {
      const client = new AzureFoundryClient(config, {
        credential,
        fetch: vi.fn(async () => completion(response)) as typeof globalThis.fetch,
      });
      await expect(new AzureFoundryStoryProvider(client).generate("家人", []))
        .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
    }
  });
});
