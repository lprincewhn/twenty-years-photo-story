import { describe, expect, it, vi } from "vitest";
import type { AzureFaceConfig } from "../src/config.js";
import { AzureFaceClient, AzureFaceMatchProvider } from "../src/providers/azure-face.js";
import { parsePeopleLibrary } from "../src/people.js";

const config: AzureFaceConfig = {
  endpoint: "https://face.example",
  apiVersion: "v1.2",
  groupId: "people",
  detectionModel: "detection_03",
  recognitionModel: "recognition_04",
  faceIdTtlSeconds: 60,
  identifyThreshold: 0.5,
  maxCandidates: 5,
  timeoutMs: 50,
};
const credential = {
  getToken: vi.fn(async () => ({ token: "token", expiresOnTimestamp: Date.now() + 60_000 })),
};
const faceId = "11111111-1111-4111-8111-111111111111";
const azurePersonId = "22222222-2222-4222-8222-222222222222";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function people() {
  return parsePeopleLibrary([{
    id: "person",
    displayName: "人物",
    oldPhotoUrl: "/api/people/person/photo",
    oldPhotoFile: "person.jpg",
    authorization: "authorized",
    sourceNote: "授权",
  }]);
}

describe("Azure Face adapter", () => {
  it("使用 v1.2、Bearer token 和 60 秒 faceId TTL，并映射候选", async () => {
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void init;
      const url = String(input);
      requests.push(url);
      if (url.includes("/detect?")) {
        return json([{ faceId, faceRectangle: { left: 1, top: 2, width: 3, height: 4 } }]);
      }
      return json([{ faceId, candidates: [{ personId: azurePersonId, confidence: 0.91 }] }]);
    });
    const library = people();
    library.people[0]!.azurePersonId = azurePersonId;
    const client = new AzureFaceClient(config, { credential, fetch: fetch as typeof globalThis.fetch });
    const result = await new AzureFaceMatchProvider(client, library).match({
      bytes: Buffer.from("photo"), mimeType: "image/jpeg", demoCase: "success",
    });
    expect(result).toEqual({ faceCount: 1, candidates: [{ personId: "person", score: 0.91 }] });
    expect(requests[0]).toContain("/face/v1.2/detect");
    expect(requests[0]).toContain("faceIdTimeToLive=60");
    expect(requests[0]).toContain("returnFaceAttributes=qualityForRecognition");
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer token" });
  });

  it.each([
    [400, { error: { code: "InvalidImage" } }, "INVALID_IMAGE", true],
    [400, { error: { code: "LargePersonGroupNotTrained" } }, "PROVIDER_UNAVAILABLE", true],
    [409, { error: { code: "LargePersonGroupTrainingNotFinished" } }, "PROVIDER_UNAVAILABLE", true],
    [403, { error: { code: "InvalidRequest", innererror: { code: "UnsupportedFeature" } } }, "PROVIDER_UNAVAILABLE", false],
    [401, { error: { code: "PermissionDenied" } }, "PROVIDER_UNAVAILABLE", false],
    [400, { error: { code: "BadArgument" } }, "PROVIDER_UNAVAILABLE", false],
    [429, { error: { code: "TooManyRequests" } }, "RATE_LIMITED", true],
  ])("严格映射 Azure %s 错误", async (status, body, code, retryable) => {
    const client = new AzureFaceClient(config, {
      credential,
      fetch: vi.fn(async () => json(body, status)) as typeof globalThis.fetch,
    });
    await expect(client.detect(Buffer.from("photo"), true)).rejects.toMatchObject({ code, retryable });
  });

  it("拒绝未知 Azure personId，而不是静默丢弃", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("/detect?")
        ? json([{ faceId, faceRectangle: { left: 1, top: 2, width: 3, height: 4 } }])
        : json([{ faceId, candidates: [{ personId: azurePersonId, confidence: 0.9 }] }]));
    const provider = new AzureFaceMatchProvider(
      new AzureFaceClient(config, { credential, fetch: fetch as typeof globalThis.fetch }),
      people(),
    );
    await expect(provider.match({
      bytes: Buffer.from("photo"), mimeType: "image/jpeg", demoCase: "success",
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
  });

  it.each([0, 2])("Detect 返回 %i 张脸时不调用 Identify", async (count) => {
    const fetch = vi.fn(async () => json(Array.from({ length: count }, (_value, index) => ({
      faceId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      faceRectangle: { left: index * 20, top: 0, width: 10, height: 10 },
    }))));
    const provider = new AzureFaceMatchProvider(
      new AzureFaceClient(config, { credential, fetch: fetch as typeof globalThis.fetch }),
      people(),
    );
    await expect(provider.match({
      bytes: Buffer.from("photo"), mimeType: "image/jpeg", demoCase: "success",
    })).resolves.toEqual({ faceCount: count, candidates: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("启动自检在 RBAC 传播期重试 401，并校验模型与训练状态", async () => {
    let calls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/training")) return json({ status: "succeeded" });
      calls += 1;
      if (calls === 1) return json({ error: { code: "PermissionDenied" } }, 401);
      if (calls === 2) return json({ error: { code: "PermissionDenied" } }, 403);
      return json({ recognitionModel: "recognition_04" });
    });
    const client = new AzureFaceClient(config, {
      credential,
      fetch: fetch as typeof globalThis.fetch,
      sleep: vi.fn(async () => undefined),
    });
    await expect(client.selfCheck(5, 0)).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it.each([
    [{ recognitionModel: "recognition_03" }, { status: "succeeded" }],
    [{ recognitionModel: "recognition_04" }, { status: "running" }],
  ])("启动自检拒绝模型不一致或未完成训练", async (group, training) => {
    const client = new AzureFaceClient(config, {
      credential,
      fetch: vi.fn(async (input: string | URL | Request) =>
        json(String(input).endsWith("/training") ? training : group)) as typeof globalThis.fetch,
    });
    await expect(client.selfCheck(1, 0)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("超时和非法 JSON 都映射为可重试 provider 错误", async () => {
    const hangingFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }));
    const client = new AzureFaceClient(
      { ...config, timeoutMs: 5 },
      { credential, fetch: hangingFetch as typeof globalThis.fetch },
    );
    await expect(client.detect(Buffer.from("photo"), true)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE", retryable: true,
    });

    const invalid = new AzureFaceClient(config, {
      credential,
      fetch: vi.fn(async () => new Response("not json")) as typeof globalThis.fetch,
    });
    await expect(invalid.detect(Buffer.from("photo"), true)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE", retryable: true,
    });
  });

  it("把调用方取消信号传给 Detect", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new Error("aborted");
      return json([]);
    });
    const controller = new AbortController();
    controller.abort();
    const client = new AzureFaceClient(config, {
      credential,
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.detect(Buffer.from("photo"), true, controller.signal)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE", retryable: true,
    });
  });
});
