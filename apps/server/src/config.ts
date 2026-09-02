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
  MATCH_THRESHOLD: z.coerce.number().min(0.5).max(0.99).default(0.82),
  ALLOWED_ORIGIN: z.string().url().default("http://localhost:5173"),
  PEOPLE_ASSET_SECRET: z.string().min(32).optional(),
  GRANT_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),
  AZURE_SPEECH_ENDPOINT: z.string().url().optional(),
  AZURE_SPEECH_RESOURCE_ID: z.string().startsWith("/subscriptions/").optional(),
  AZURE_SPEECH_VOICE: z.string().min(1).default("zh-CN-XiaoxiaoNeural"),
  AZURE_SPEECH_STYLE: z.string().min(1).default("affectionate"),
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

export interface AppConfig {
  host: string;
  port: number;
  providerMode: "mock" | "real";
  matchThreshold: number;
  allowedOrigin: string;
  peopleAssetSecret: string;
  grantTtlSeconds: number;
  speech: SpeechConfig;
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
  };
}
