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
});

export interface AppConfig {
  host: string;
  port: number;
  providerMode: "mock" | "real";
  matchThreshold: number;
  allowedOrigin: string;
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    providerMode: parsed.PROVIDER_MODE,
    matchThreshold: parsed.MATCH_THRESHOLD,
    allowedOrigin: parsed.ALLOWED_ORIGIN,
  };
}
