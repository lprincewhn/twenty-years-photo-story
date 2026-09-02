import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { z } from "zod";
import type { AzureFoundryConfig } from "../config.js";
import { AppError } from "../errors.js";
import {
  allowedDifferenceCategories,
  type DifferenceProvider,
  type FictionStory,
  type PhotoInput,
  type ReferencePhotoInput,
  type StoryProvider,
  type VisibleDifference,
} from "./types.js";

const cognitiveServicesScope = "https://cognitiveservices.azure.com/.default";
const maxResponseBytes = 1_048_576;
const differenceSchema = z.object({
  differences: z.array(z.object({
    category: z.enum(allowedDifferenceCategories),
    description: z.string().min(1).max(200),
  })).max(4),
});
const storySchema = z.object({
  title: z.string().min(1).max(80),
  content: z.string().min(1).max(1_000),
});
const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
});

type JsonSchema = Record<string, unknown>;

export interface AzureFoundryClientDependencies {
  credential?: TokenCredential;
  fetch?: typeof globalThis.fetch;
}

function providerError(retryable: boolean): AppError {
  return new AppError(
    502,
    "PROVIDER_UNAVAILABLE",
    "分析服务暂时不可用",
    "照片没有被保存。请稍后重试；若持续发生，请使用请求标识联系维护人员。",
    retryable,
  );
}

export class AzureFoundryClient {
  private readonly credential: TokenCredential;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(
    private readonly config: AzureFoundryConfig,
    dependencies: AzureFoundryClientDependencies = {},
  ) {
    this.credential = dependencies.credential ?? new DefaultAzureCredential(
      config.managedIdentityClientId
        ? { managedIdentityClientId: config.managedIdentityClientId }
        : undefined,
    );
    this.fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  }

  async complete(
    messages: unknown[],
    schemaName: string,
    schema: JsonSchema,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = await this.credential.getToken(cognitiveServicesScope);
    if (!token) throw providerError(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      const response = await this.fetchImplementation(
        `${this.config.endpoint}/openai/v1/chat/completions`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.deployment,
            messages,
            max_completion_tokens: 1_200,
            response_format: {
              type: "json_schema",
              json_schema: { name: schemaName, strict: true, schema },
            },
          }),
        },
      );
      if (!response.ok) {
        if (response.status === 429) {
          throw new AppError(
            429,
            "RATE_LIMITED",
            "分析服务请求过多",
            "照片没有被保存，请稍后重试。",
            true,
          );
        }
        throw providerError(response.status >= 500 || response.status === 408);
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
        throw providerError(false);
      }
      const responseText = await response.text();
      if (Buffer.byteLength(responseText) > maxResponseBytes) {
        throw providerError(false);
      }
      let responseBody: unknown;
      try {
        responseBody = JSON.parse(responseText) as unknown;
      } catch {
        throw providerError(true);
      }
      const completion = completionSchema.safeParse(responseBody);
      if (!completion.success) throw providerError(true);
      try {
        return JSON.parse(completion.data.choices[0]!.message.content) as unknown;
      } catch {
        throw providerError(true);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw providerError(true);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

const differenceJsonSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["differences"],
  properties: {
    differences: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "description"],
        properties: {
          category: { type: "string", enum: [...allowedDifferenceCategories] },
          description: { type: "string", maxLength: 200 },
        },
      },
    },
  },
};

const storyJsonSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "content"],
  properties: {
    title: { type: "string", maxLength: 80 },
    content: { type: "string", maxLength: 1_000 },
  },
};

export class AzureFoundryDifferenceProvider implements DifferenceProvider {
  constructor(private readonly client: AzureFoundryClient) {}

  async analyze(
    photo: PhotoInput,
    referencePhoto?: ReferencePhotoInput,
  ): Promise<VisibleDifference[]> {
    if (!referencePhoto) throw providerError(false);
    const body = await this.client.complete([
      {
        role: "system",
        content:
          "只比较两张照片中直接可见且客观的发型、服饰、表情、配饰差异。" +
          "不得推断年龄、种族、健康、宗教、情绪状态、身份或真实经历；看不清就省略。",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "第一张是人物库旧照，第二张是用户当前照片。请输出可见差异。" },
          {
            type: "image_url",
            image_url: {
              url: `data:${referencePhoto.mimeType};base64,${referencePhoto.bytes.toString("base64")}`,
              detail: "high",
            },
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${photo.mimeType};base64,${photo.bytes.toString("base64")}`,
              detail: "high",
            },
          },
        ],
      },
    ], "visible_differences", differenceJsonSchema, photo.signal);
    const parsed = differenceSchema.safeParse(body);
    if (!parsed.success) throw providerError(false);
    return parsed.data.differences;
  }
}

export class AzureFoundryStoryProvider implements StoryProvider {
  constructor(private readonly client: AzureFoundryClient) {}

  async generate(
    differences: VisibleDifference[],
    signal?: AbortSignal,
  ): Promise<FictionStory> {
    const body = await this.client.complete([
      {
        role: "system",
        content:
          "根据给定的可见差异创作温暖、克制的中文短故事。" +
          "必须始终用第二人称“你”讲述，正文至少出现一次“你”；" +
          "故事必须明确连接二十年前与现在，正文必须包含“二十年”；" +
          "不得使用展示名，也不得以“他”“她”或“人物”指代故事主人公。" +
          "必须明确是虚构，不得补充敏感属性、身份结论或真实经历。",
      },
      {
        role: "user",
        content: JSON.stringify({ differences }),
      },
    ], "fiction_story", storyJsonSchema, signal);
    const parsed = storySchema.safeParse(body);
    if (!parsed.success) throw providerError(false);
    if (
      !parsed.data.content.includes("你") ||
      !parsed.data.content.includes("二十年") ||
      /[他她]/u.test(parsed.data.content)
    ) {
      throw providerError(false);
    }
    return {
      label: "AI 创作/虚构",
      title: parsed.data.title,
      content: parsed.data.content,
      disclaimer: "本故事由 AI 根据可见元素虚构，不代表人物的真实经历。",
    };
  }
}
