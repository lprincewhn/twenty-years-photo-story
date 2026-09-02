import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config as loadEnvironment } from "dotenv";
import { z } from "zod";

loadEnvironment({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  quiet: true,
});

const environmentSchema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  PROVIDER_MODE: z.enum(["mock", "real"]).default("mock"),
  MATCH_THRESHOLD: z.coerce.number().min(0.5).max(0.99).default(0.6),
  ALLOWED_ORIGIN: z.string().url().default("http://localhost:5173"),
  PEOPLE_ASSET_SECRET: z.string().min(32).optional(),
  GRANT_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),
  AZURE_SPEECH_ENDPOINT: z.string().url().optional(),
  AZURE_SPEECH_RESOURCE_ID: z.string().startsWith("/subscriptions/").optional(),
  AZURE_SPEECH_VOICE: z.string().min(1).default("zh-CN-XiaoxiaoNeural"),
  AZURE_SPEECH_STYLE: z.string().min(1).default("affectionate"),
  AZURE_FACE_ENDPOINT: z.string().url().optional(),
  AZURE_FACE_API_VERSION: z.literal("v1.2").default("v1.2"),
  AZURE_FACE_GROUP_ID: z.string().regex(/^[a-z0-9_-]+$/).max(64).optional(),
  AZURE_FACE_DETECTION_MODEL: z.literal("detection_03").default("detection_03"),
  AZURE_FACE_RECOGNITION_MODEL: z.literal("recognition_04").default("recognition_04"),
  AZURE_FACE_ID_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(60),
  AZURE_FACE_IDENTIFY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  AZURE_FACE_MAX_CANDIDATES: z.coerce.number().int().min(1).max(100).default(5),
  AZURE_FACE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(8_000),
  AZURE_FOUNDRY_ENDPOINT: z.string().url().optional(),
  AZURE_FOUNDRY_DEPLOYMENT: z.string().min(1).max(128).default("gpt-5.6-terra"),
  AZURE_FOUNDRY_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(60_000),
  AZURE_CLIENT_ID: z.string().uuid().optional(),
}).superRefine((environment, context) => {
  if (
    Boolean(environment.AZURE_SPEECH_ENDPOINT) !==
    Boolean(environment.AZURE_SPEECH_RESOURCE_ID)
  ) {
    context.addIssue({
      code: "custom",
      message: "AZURE_SPEECH_ENDPOINT 和 AZURE_SPEECH_RESOURCE_ID 必须同时配置",
      path: ["AZURE_SPEECH_ENDPOINT"],
    });
  }
  if (environment.PROVIDER_MODE === "real") {
    if (!environment.AZURE_FACE_ENDPOINT) {
      context.addIssue({ code: "custom", path: ["AZURE_FACE_ENDPOINT"], message: "real 模式必须配置 AZURE_FACE_ENDPOINT" });
    }
    if (!environment.AZURE_FACE_GROUP_ID) {
      context.addIssue({ code: "custom", path: ["AZURE_FACE_GROUP_ID"], message: "real 模式必须配置 AZURE_FACE_GROUP_ID" });
    }
    if (!environment.AZURE_FOUNDRY_ENDPOINT) {
      context.addIssue({ code: "custom", path: ["AZURE_FOUNDRY_ENDPOINT"], message: "real 模式必须配置 AZURE_FOUNDRY_ENDPOINT" });
    }
    if (environment.AZURE_FACE_IDENTIFY_THRESHOLD >= environment.MATCH_THRESHOLD) {
      context.addIssue({
        code: "custom",
        path: ["AZURE_FACE_IDENTIFY_THRESHOLD"],
        message: "AZURE_FACE_IDENTIFY_THRESHOLD 必须小于 MATCH_THRESHOLD",
      });
    }
  }
});

export type SpeechConfig =
  | { mode: "mock" }
  | {
      mode: "azure";
      endpoint: string;
      resourceId: string;
      voice: string;
      style: string;
    };

export interface AzureFaceConfig {
  endpoint: string;
  apiVersion: "v1.2";
  groupId: string;
  detectionModel: "detection_03";
  recognitionModel: "recognition_04";
  faceIdTtlSeconds: number;
  identifyThreshold: number;
  maxCandidates: number;
  timeoutMs: number;
  managedIdentityClientId?: string;
}

export interface AzureFoundryConfig {
  endpoint: string;
  deployment: string;
  timeoutMs: number;
  managedIdentityClientId?: string;
}

export interface AppConfig {
  host: string;
  port: number;
  providerMode: "mock" | "real";
  matchThreshold: number;
  allowedOrigin: string;
  peopleAssetSecret: string;
  grantTtlSeconds: number;
  speech: SpeechConfig;
  azureFace?: AzureFaceConfig;
  azureFoundry?: AzureFoundryConfig;
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const peopleAssetSecret = parsed.PEOPLE_ASSET_SECRET ?? randomBytes(32).toString("base64url");
  if (!parsed.PEOPLE_ASSET_SECRET) {
    console.warn(
      "警告：PEOPLE_ASSET_SECRET 未设置，已生成临时密钥；服务重启后授权失效，多副本部署必须配置共享密钥。",
    );
  }
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    providerMode: parsed.PROVIDER_MODE,
    matchThreshold: parsed.MATCH_THRESHOLD,
    allowedOrigin: parsed.ALLOWED_ORIGIN,
    peopleAssetSecret,
    grantTtlSeconds: parsed.GRANT_TTL_SECONDS,
    speech:
      parsed.AZURE_SPEECH_ENDPOINT && parsed.AZURE_SPEECH_RESOURCE_ID
        ? {
            mode: "azure",
            endpoint: parsed.AZURE_SPEECH_ENDPOINT,
            resourceId: parsed.AZURE_SPEECH_RESOURCE_ID,
            voice: parsed.AZURE_SPEECH_VOICE,
            style: parsed.AZURE_SPEECH_STYLE,
          }
        : { mode: "mock" },
    ...(parsed.PROVIDER_MODE === "real"
      ? {
          azureFace: {
            endpoint: parsed.AZURE_FACE_ENDPOINT!.replace(/\/+$/, ""),
            apiVersion: parsed.AZURE_FACE_API_VERSION,
            groupId: parsed.AZURE_FACE_GROUP_ID!,
            detectionModel: parsed.AZURE_FACE_DETECTION_MODEL,
            recognitionModel: parsed.AZURE_FACE_RECOGNITION_MODEL,
            faceIdTtlSeconds: parsed.AZURE_FACE_ID_TTL_SECONDS,
            identifyThreshold: parsed.AZURE_FACE_IDENTIFY_THRESHOLD,
            maxCandidates: parsed.AZURE_FACE_MAX_CANDIDATES,
            timeoutMs: parsed.AZURE_FACE_TIMEOUT_MS,
            ...(parsed.AZURE_CLIENT_ID ? { managedIdentityClientId: parsed.AZURE_CLIENT_ID } : {}),
          },
          azureFoundry: {
            endpoint: parsed.AZURE_FOUNDRY_ENDPOINT!.replace(/\/+$/, ""),
            deployment: parsed.AZURE_FOUNDRY_DEPLOYMENT,
            timeoutMs: parsed.AZURE_FOUNDRY_TIMEOUT_MS,
            ...(parsed.AZURE_CLIENT_ID ? { managedIdentityClientId: parsed.AZURE_CLIENT_ID } : {}),
          },
        }
      : {}),
  };
}
