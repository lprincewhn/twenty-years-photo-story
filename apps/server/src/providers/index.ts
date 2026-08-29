import type { AppConfig } from "../config.js";
import { createMockProviders } from "./mock.js";
import type { ProviderSet } from "./types.js";

export function createProviders(config: AppConfig): ProviderSet {
  if (config.providerMode === "mock") {
    return createMockProviders();
  }
  throw new Error(
    "PROVIDER_MODE=real 尚未绑定供应商适配器，请按 docs/maintenance.md 实现三个接口后再启动。",
  );
}

