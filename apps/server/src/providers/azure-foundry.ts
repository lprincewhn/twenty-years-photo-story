import { randomInt, randomUUID } from "node:crypto";
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
  })).max(5),
});
const storySchema = z.object({
  title: z.string().min(1).max(80),
  content: z.string().min(1).max(500),
});
const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
});

type JsonSchema = Record<string, unknown>;

const storyPerspectives = [
  "现在的你与过去的你对话",
  "旧照片向你发问",
  "未来的你写给此刻的你",
  "一件可见配饰陪伴你",
] as const;
const storyStructures = [
  "倒叙后回到当下",
  "两个时刻交替推进",
  "从一个动作展开",
  "以三段微场景串联",
] as const;
const storySettings = [
  "清晨车站",
  "雨后书店",
  "傍晚厨房",
  "夏夜阳台",
  "冬日公园",
  "安静照相馆",
  "午夜便利店",
  "海边渡轮",
  "山间露营地",
  "城市天台球场",
  "老街面馆",
  "美术馆展厅",
  "音乐节后台",
  "长途列车餐车",
  "太空观景舱",
] as const;
const storyRhythms = [
  "短句轻快",
  "舒缓长句",
  "对白驱动",
  "电影分镜感",
  "含蓄散文感",
] as const;
const storyEndings = [
  "停在一个动作",
  "留下一句对白",
  "回扣开篇物件",
  "以环境声音收束",
  "开放式留白",
] as const;
const storyDirectionCount =
  storyPerspectives.length *
  storyStructures.length *
  storySettings.length *
  storyRhythms.length *
  storyEndings.length;
const recentStoryDirectionLimit = 5;

interface StoryCreativeDirection {
  perspective: string;
  structure: string;
  setting: string;
  rhythm: string;
  ending: string;
}

export interface AzureFoundryStoryDependencies {
  randomIndex?: (maxExclusive: number) => number;
  variationId?: () => string;
}

function decodeStoryDirection(index: number): StoryCreativeDirection {
  let remaining = index;
  const ending = storyEndings[remaining % storyEndings.length]!;
  remaining = Math.floor(remaining / storyEndings.length);
  const rhythm = storyRhythms[remaining % storyRhythms.length]!;
  remaining = Math.floor(remaining / storyRhythms.length);
  const setting = storySettings[remaining % storySettings.length]!;
  remaining = Math.floor(remaining / storySettings.length);
  const structure = storyStructures[remaining % storyStructures.length]!;
  remaining = Math.floor(remaining / storyStructures.length);
  const perspective = storyPerspectives[remaining % storyPerspectives.length]!;
  return { perspective, structure, setting, rhythm, ending };
}

export interface AzureFoundryClientDependencies {
  credential?: TokenCredential;
  fetch?: typeof globalThis.fetch;
  log?: (entry: AzureFoundryInteractionLog) => void;
}

export interface AzureFoundryInteractionLog {
  event: "foundry.request" | "foundry.response";
  interactionId: string;
  schemaName: string;
  deployment: string;
  messageRoles?: string[];
  imageMimeTypes?: string[];
  promptMessages?: Array<{ role: string; content: unknown }>;
  outcome?: "success" | "error";
  httpStatus?: number;
  durationMs?: number;
  responseBytes?: number;
  errorCode?: string;
}

function summarizeMessages(messages: unknown[], schemaName: string): {
  messageRoles: string[];
  imageMimeTypes: string[];
  promptMessages: Array<{ role: string; content: unknown }>;
} {
  const messageRoles: string[] = [];
  const imageMimeTypes: string[] = [];
  const promptMessages: Array<{ role: string; content: unknown }> = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (typeof record.role !== "string") continue;
    messageRoles.push(record.role);
    if (typeof record.content === "string") {
      let content: unknown = record.content;
      if (schemaName === "fiction_story" && record.role === "user") {
        try {
          const payload = JSON.parse(record.content) as Record<string, unknown>;
          const differenceCount = Array.isArray(payload.differences)
            ? payload.differences.length
            : 0;
          content = {
            ...payload,
            differences: `[已脱敏：${differenceCount} 条可见差异]`,
          };
        } catch {
          content = "[无法安全解析的用户提示词已脱敏]";
        }
      }
      promptMessages.push({ role: record.role, content });
      continue;
    }
    if (!Array.isArray(record.content)) continue;
    const content = record.content.map((item) => {
      if (!item || typeof item !== "object") return item;
      const itemRecord = item as Record<string, unknown>;
      const imageUrl = itemRecord.image_url;
      if (!imageUrl || typeof imageUrl !== "object") return item;
      const imageUrlRecord = imageUrl as Record<string, unknown>;
      const url = imageUrlRecord.url;
      if (typeof url !== "string") return item;
      const match = /^data:([^;,]+);base64,/u.exec(url);
      if (!match?.[1]) return item;
      imageMimeTypes.push(match[1]);
      return {
        ...itemRecord,
        image_url: {
          ...imageUrlRecord,
          url: `[图片已脱敏：${match[1]}]`,
        },
      };
    });
    promptMessages.push({ role: record.role, content });
  }
  return { messageRoles, imageMimeTypes, promptMessages };
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
  private readonly log: (entry: AzureFoundryInteractionLog) => void;

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
    this.log = dependencies.log ?? ((entry) => console.info(`[foundry] ${JSON.stringify(entry)}`));
  }

  async complete(
    messages: unknown[],
    schemaName: string,
    schema: JsonSchema,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = await this.credential.getToken(cognitiveServicesScope);
    if (!token) throw providerError(true);
    const interactionId = randomUUID();
    const startedAt = Date.now();
    const messageSummary = summarizeMessages(messages, schemaName);
    this.log({
      event: "foundry.request",
      interactionId,
      schemaName,
      deployment: this.config.deployment,
      ...messageSummary,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const abortFromCaller = () => controller.abort();
    let httpStatus: number | undefined;
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
      httpStatus = response.status;
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
      const responseBytes = Buffer.byteLength(responseText);
      if (responseBytes > maxResponseBytes) {
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
        const result = JSON.parse(completion.data.choices[0]!.message.content) as unknown;
        this.log({
          event: "foundry.response",
          interactionId,
          schemaName,
          deployment: this.config.deployment,
          outcome: "success",
          httpStatus,
          durationMs: Date.now() - startedAt,
          responseBytes,
        });
        return result;
      } catch {
        throw providerError(true);
      }
    } catch (error) {
      this.log({
        event: "foundry.response",
        interactionId,
        schemaName,
        deployment: this.config.deployment,
        outcome: "error",
        ...(httpStatus === undefined ? {} : { httpStatus }),
        durationMs: Date.now() - startedAt,
        errorCode: error instanceof AppError ? error.code : "PROVIDER_UNAVAILABLE",
      });
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
      maxItems: 5,
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
    content: { type: "string", maxLength: 500 },
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
          "只比较两张照片中直接可见且客观的发型、服饰、表情、配饰、眼神差异。" +
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
  private readonly randomIndex: (maxExclusive: number) => number;
  private readonly variationId: () => string;
  private readonly recentDirections: number[] = [];

  constructor(
    private readonly client: AzureFoundryClient,
    dependencies: AzureFoundryStoryDependencies = {},
  ) {
    this.randomIndex = dependencies.randomIndex ?? randomInt;
    this.variationId = dependencies.variationId ?? randomUUID;
  }

  private nextCreativeDirection(): StoryCreativeDirection {
    const startIndex = this.randomIndex(storyDirectionCount);
    let directionIndex = startIndex;
    while (this.recentDirections.includes(directionIndex)) {
      directionIndex = (directionIndex + 1) % storyDirectionCount;
    }
    this.recentDirections.push(directionIndex);
    if (this.recentDirections.length > recentStoryDirectionLimit) {
      this.recentDirections.shift();
    }
    return decodeStoryDirection(directionIndex);
  }

  async generate(
    differences: VisibleDifference[],
    signal?: AbortSignal,
  ): Promise<FictionStory> {
    const creativeDirection = this.nextCreativeDirection();
    const body = await this.client.complete([
      {
        role: "system",
        content:
          "根据给定的可见差异创作搞笑、抖梗的的欢乐中文短故事。" +
          "必须始终用第二人称“你”讲述，正文至少出现一次“你”；" +
          "故事必须明确连接二十年前与现在，正文必须包含“二十年”；" +
          "正文最多500字；" +
          "不得使用展示名，也不得以“他”“她”或“人物”指代故事主人公。" +
          "适当补充导致二十年差异的原因和经历。" +
          "使用用户消息中的本次创意坐标，使标题、开篇句式、叙事结构和结尾意象与坐标一致；" +
          "不得提及创意坐标或创作编号，不要把差异逐条复述成报告。" +
          "避免“翻开旧相册”“时光荏苒”“岁月留下痕迹”“仿佛回到从前”" +
          "“未寄出的明信片”“珍惜每一次笑容”等高频套话。",
      },
      {
        role: "user",
        content: JSON.stringify({
          differences,
          creativeDirection,
          variationId: this.variationId(),
        }),
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
