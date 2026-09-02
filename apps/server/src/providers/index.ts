import type { AppConfig } from "../config.js";
import { AzureSpeechProvider } from "./azure-speech.js";
import { createMockProviders } from "./mock.js";
import type { ProviderSet } from "./types.js";

export function createProviders(config: AppConfig): ProviderSet {
  if (config.providerMode === "mock") {
    const providers = createMockProviders();
    if (config.speech.mode === "azure") {
      providers.narration = new AzureSpeechProvider(config.speech);
    }
    return providers;
  }
  throw new Error(
    "PROVIDER_MODE=real 尚未绑定供应商适配器，请按 docs/maintenance.md 实现三个接口后再启动。",
  );
}
