import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";

const secret = "a-secret-value-that-is-longer-than-32-characters";

describe("Azure Face 配置", () => {
  it("默认业务阈值为 0.6", () => {
    expect(readConfig({ PEOPLE_ASSET_SECRET: secret }).matchThreshold).toBe(0.6);
  });

  it("real 模式要求 Face 与 Foundry 配置，并强制 Identify 阈值更低", () => {
    expect(() => readConfig({
      PROVIDER_MODE: "real",
      PEOPLE_ASSET_SECRET: secret,
    })).toThrow();
    expect(() => readConfig({
      PROVIDER_MODE: "real",
      PEOPLE_ASSET_SECRET: secret,
      AZURE_FACE_ENDPOINT: "https://face.example",
      AZURE_FACE_GROUP_ID: "people",
      AZURE_FOUNDRY_ENDPOINT: "https://foundry.example",
      MATCH_THRESHOLD: "0.6",
      AZURE_FACE_IDENTIFY_THRESHOLD: "0.6",
    })).toThrow("AZURE_FACE_IDENTIFY_THRESHOLD");
  });

  it("构造固定 v1.2、detection_03、recognition_04 和 60 秒 TTL", () => {
    expect(readConfig({
      PROVIDER_MODE: "real",
      PEOPLE_ASSET_SECRET: secret,
      AZURE_FACE_ENDPOINT: "https://face.example/",
      AZURE_FACE_GROUP_ID: "people",
      AZURE_FOUNDRY_ENDPOINT: "https://svhw2-southeastaisa.cognitiveservices.azure.com/",
    }).azureFace).toMatchObject({
      endpoint: "https://face.example",
      apiVersion: "v1.2",
      detectionModel: "detection_03",
      recognitionModel: "recognition_04",
      faceIdTtlSeconds: 60,
      identifyThreshold: 0.5,
    });
    expect(readConfig({
      PROVIDER_MODE: "real",
      PEOPLE_ASSET_SECRET: secret,
      AZURE_FACE_ENDPOINT: "https://face.example/",
      AZURE_FACE_GROUP_ID: "people",
      AZURE_FOUNDRY_ENDPOINT: "https://svhw2-southeastaisa.cognitiveservices.azure.com/",
    }).azureFoundry).toEqual({
      endpoint: "https://svhw2-southeastaisa.cognitiveservices.azure.com",
      deployment: "gpt-5.6-sol",
      timeoutMs: 60_000,
    });
  });
});
