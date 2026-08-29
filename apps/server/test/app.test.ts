import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { createMockProviders } from "../src/providers/mock.js";
import type { ProviderSet } from "../src/providers/types.js";

const config: AppConfig = {
  port: 3000,
  providerMode: "mock",
  matchThreshold: 0.82,
  allowedOrigin: "http://localhost:5173",
};
const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function app(providers: ProviderSet = createMockProviders(), overrides: Partial<AppConfig> = {}) {
  return createApp({ config: { ...config, ...overrides }, providers });
}

function validRequest(target = app()) {
  return request(target)
    .post("/api/experience")
    .field("consent", "true")
    .field("demoCase", "success")
    .attach("photo", validJpeg, {
      filename: "photo.jpg",
      contentType: "image/jpeg",
    });
}

describe("照片故事 API", () => {
  it("健康检查不暴露人物资料或密钥", async () => {
    const response = await request(app()).get("/api/health").expect(200);
    expect(response.body).toEqual({ status: "ok", providerMode: "mock" });
  });

  it("拒绝没有显式授权的上传", async () => {
    const response = await request(app())
      .post("/api/experience")
      .attach("photo", validJpeg, {
        filename: "photo.jpg",
        contentType: "image/jpeg",
      })
      .expect(400);
    expect(response.body.error.code).toBe("CONSENT_REQUIRED");
  });

  it("拒绝不支持的图片格式", async () => {
    const response = await request(app())
      .post("/api/experience")
      .field("consent", "true")
      .attach("photo", Buffer.from("文本"), {
        filename: "photo.txt",
        contentType: "text/plain",
      })
      .expect(400);
    expect(response.body.error.code).toBe("INVALID_IMAGE");
  });

  it("拒绝 MIME 伪装成图片的无效内容", async () => {
    const response = await request(app())
      .post("/api/experience")
      .field("consent", "true")
      .attach("photo", Buffer.from("并不是真正的图片"), {
        filename: "fake.jpg",
        contentType: "image/jpeg",
      })
      .expect(400);
    expect(response.body.error.code).toBe("INVALID_IMAGE");
  });

  it("拒绝超过 6 MiB 的图片", async () => {
    const oversizedJpeg = Buffer.alloc(6 * 1024 * 1024 + 1);
    validJpeg.copy(oversizedJpeg);
    const response = await request(app())
      .post("/api/experience")
      .field("consent", "true")
      .attach("photo", oversizedJpeg, {
        filename: "too-large.jpg",
        contentType: "image/jpeg",
      })
      .expect(413);
    expect(response.body.error.code).toBe("PHOTO_TOO_LARGE");
  });

  it("返回匹配依据、可见差异、AI 标记和不留存说明", async () => {
    const response = await validRequest().expect(200);
    expect(response.body.match).toMatchObject({
      matched: true,
      score: 0.94,
      threshold: 0.82,
      confidence: "high",
    });
    expect(response.body.differences).toHaveLength(4);
    expect(response.body.story.label).toBe("AI 创作/虚构");
    expect(response.body.retention).toContain("不落盘");
  });

  it("分数等于阈值时可以匹配", async () => {
    const providers = createMockProviders();
    providers.faceMatch = {
      match: async () => ({
        faceCount: 1,
        candidates: [{ personId: "demo-xiaoxia", score: 0.82 }],
      }),
    };
    const response = await validRequest(app(providers)).expect(200);
    expect(response.body.match.score).toBe(0.82);
    expect(response.body.match.confidence).toBe("medium");
  });

  it("低于阈值不返回候选人物结论", async () => {
    const response = await request(app())
      .post("/api/experience")
      .field("consent", "true")
      .field("demoCase", "unmatched")
      .attach("photo", validJpeg, {
        filename: "photo.jpg",
        contentType: "image/jpeg",
      })
      .expect(422);
    expect(response.body.error).toMatchObject({
      code: "MATCH_BELOW_THRESHOLD",
      details: { score: 0.61, threshold: 0.82 },
    });
    expect(JSON.stringify(response.body)).not.toContain("demo-xiaoxia");
  });

  it.each([
    ["no-face", "NO_FACE"],
    ["multiple-faces", "MULTIPLE_FACES"],
    ["provider-error", "PROVIDER_UNAVAILABLE"],
  ])("返回 %s 的中文可解释错误", async (demoCase, code) => {
    const response = await request(app())
      .post("/api/experience")
      .field("consent", "true")
      .field("demoCase", demoCase)
      .attach("photo", validJpeg, {
        filename: "photo.jpg",
        contentType: "image/jpeg",
      })
      .expect(code === "PROVIDER_UNAVAILABLE" ? 502 : 422);
    expect(response.body.error.code).toBe(code);
    expect(response.body.error.explanation).toBeTruthy();
    expect(response.body.error.requestId).toBeTruthy();
  });

  it("无论成功与否都清零传给 provider 的图片缓冲区", async () => {
    let captured: Buffer | undefined;
    const providers = createMockProviders();
    providers.faceMatch = {
      match: async (photo) => {
        captured = photo.bytes;
        return {
          faceCount: 1,
          candidates: [{ personId: "demo-xiaoxia", score: 0.94 }],
        };
      },
    };
    await validRequest(app(providers)).expect(200);
    expect(captured).toBeDefined();
    expect(captured?.every((byte) => byte === 0)).toBe(true);
  });
});
