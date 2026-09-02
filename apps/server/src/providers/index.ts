import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { loadPeopleLibrary } from "../people.js";
import { AzureFaceClient, AzureFaceMatchProvider } from "./azure-face.js";
import {
  AzureFoundryClient,
  AzureFoundryDifferenceProvider,
  AzureFoundryStoryProvider,
} from "./azure-foundry.js";
import { createMockProviders } from "./mock.js";
import type { ProviderSet } from "./types.js";

export async function createProviders(config: AppConfig): Promise<ProviderSet> {
  if (config.providerMode === "mock") {
    return createMockProviders();
  }
  if (!config.azureFace || !config.azureFoundry) {
    throw new AppError(
      502,
      "PROVIDER_UNAVAILABLE",
      "分析服务配置不完整",
      "real 模式必须同时配置 Azure Face 和 Microsoft Foundry。",
      false,
    );
  }
  const library = loadPeopleLibrary();
  const faceClient = new AzureFaceClient(config.azureFace);
  await faceClient.selfCheck();
  const foundryClient = new AzureFoundryClient(config.azureFoundry);
  return {
    faceMatch: new AzureFaceMatchProvider(faceClient, library),
    difference: new AzureFoundryDifferenceProvider(foundryClient),
    story: new AzureFoundryStoryProvider(foundryClient),
  };
}
