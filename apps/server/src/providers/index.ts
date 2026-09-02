import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { loadPeopleLibrary } from "../people.js";
import { AzureFaceClient, AzureFaceMatchProvider } from "./azure-face.js";
import { createMockProviders } from "./mock.js";
import type { ProviderSet } from "./types.js";

function unavailableProvider(): never {
  throw new AppError(
    502,
    "PROVIDER_UNAVAILABLE",
    "分析服务暂时不可用",
    "真实差异分析和故事 provider 尚未配置；系统不会静默使用演示结果。",
    false,
  );
}

export async function createProviders(config: AppConfig): Promise<ProviderSet> {
  if (config.providerMode === "mock") {
    return createMockProviders();
  }
  if (!config.azureFace) throw new Error("real 模式缺少 Azure Face 配置");
  const library = loadPeopleLibrary();
  const client = new AzureFaceClient(config.azureFace);
  await client.selfCheck();
  return {
    faceMatch: new AzureFaceMatchProvider(client, library),
    difference: { analyze: async () => unavailableProvider() },
    story: { generate: async () => unavailableProvider() },
  };
}
