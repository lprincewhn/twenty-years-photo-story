import { createHmac } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { parsePeople } from "../src/people.js";
import { createMockProviders } from "../src/providers/mock.js";
import type { ProviderSet } from "../src/providers/types.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 3000,
  providerMode: "mock",
  matchThreshold: 0.82,
  allowedOrigin: "http://localhost:5173",
  peopleAssetSecret: "test-secret-that-is-at-least-32-characters",
  grantTtlSeconds: 300,
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

  it.each(["application/json", "application/x-www-form-urlencoded"])(
    "将非 multipart 的 %s 请求解释为缺少授权",
    async (contentType) => {
      const response = await request(app())
        .post("/api/experience")
        .set("content-type", contentType)
        .send(contentType === "application/json" ? {} : "")
        .expect(400);
      expect(response.body.error.code).toBe("CONSENT_REQUIRED");
    },
  );

  it("将错误文件字段解释为无效图片", async () => {
    const response = await request(app())
      .post("/api/experience")
      .field("consent", "true")
      .attach("image", validJpeg, {
        filename: "photo.jpg",
        contentType: "image/jpeg",
      })
      .expect(400);
    expect(response.body.error.code).toBe("INVALID_IMAGE");
  });

  it("拒绝多张图片和过多文本字段", async () => {
    const multipleFiles = await validRequest()
      .attach("photo", validJpeg, {
        filename: "second.jpg",
        contentType: "image/jpeg",
      })
      .expect(400);
    expect(multipleFiles.body.error.code).toBe("INVALID_IMAGE");

    const tooManyFields = request(app()).post("/api/experience");
    for (let index = 0; index < 5; index += 1) {
      tooManyFields.field(`extra-${index}`, "value");
    }
    const response = await tooManyFields
      .attach("photo", validJpeg, {
        filename: "photo.jpg",
        contentType: "image/jpeg",
      })
      .expect(400);
    expect(response.body.error.code).toBe("INVALID_REQUEST");
  });

  it("仅接受长度和字符受限的客户端请求标识", async () => {
    const accepted = await request(app())
      .get("/api/health")
      .set("x-request-id", "client_request-123")
      .expect(200);
    expect(accepted.headers["x-request-id"]).toBe("client_request-123");

    const rejected = await request(app())
      .get("/api/health")
      .set("x-request-id", `${"x".repeat(65)}<script>`)
      .expect(200);
    expect(rejected.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("按反向代理传递的客户端 IP 独立限流", async () => {
    const target = app();
    for (let index = 0; index < 30; index += 1) {
      await request(target)
        .post("/api/experience")
        .set("x-forwarded-for", "198.51.100.10")
        .expect(400);
    }
    const limited = await request(target)
      .post("/api/experience")
      .set("x-forwarded-for", "198.51.100.10")
      .expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");

    await request(target)
      .post("/api/experience")
      .set("x-forwarded-for", "198.51.100.11")
      .expect(400);
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
    expect(response.body.match.person.oldPhotoUrl).toBe(
      "/api/people/demo-xiaoxia/photo",
    );
    expect(response.body.match.person).not.toHaveProperty("displayName");
    expect(response.body.match.person.faceBox).toEqual({
      left: 155 / 600,
      top: 100 / 760,
      width: 290 / 600,
      height: 360 / 760,
    });
    expect(response.body.story.content).toContain("你");
    expect(response.headers["set-cookie"]?.[0]).toContain("ps_grant=");
    expect(response.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]?.[0]).toContain("Secure");
    expect(response.headers["set-cookie"]?.[0]).toContain("SameSite=Strict");
  });

  it("只向完成匹配且 grant 人物一致的请求返回私有照片", async () => {
    const target = app();
    await request(target).get("/api/people/demo-xiaoxia/photo").expect(403);

    const experience = await validRequest(target).expect(200);
    const cookie = experience.headers["set-cookie"]?.[0]?.split(";")[0];
    expect(cookie).toBeTruthy();
    const photo = await request(target)
      .get("/api/people/demo-xiaoxia/photo")
      .set("cookie", cookie!)
      .expect(200);
    expect(photo.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(photo.headers["cache-control"]).toBe("private, no-store");
    expect(photo.headers["content-disposition"]).toBe("inline");
    expect(photo.headers["content-security-policy"]).toBe("default-src 'none'");

    const wrongPersonPayload = Buffer.from(
      JSON.stringify({
        personId: "another-person",
        exp: Math.floor(Date.now() / 1000) + 300,
        requestId: "wrong-person-grant",
      }),
    ).toString("base64url");
    const wrongPersonSignature = createHmac("sha256", config.peopleAssetSecret)
      .update(wrongPersonPayload)
      .digest("base64url");
    await request(target)
      .get("/api/people/demo-xiaoxia/photo")
      .set("cookie", `ps_grant=${wrongPersonPayload}.${wrongPersonSignature}`)
      .expect(403);

    await request(target)
      .get("/api/people/another-person/photo")
      .set("cookie", cookie!)
      .expect(404);
  });

  it("拒绝过期、篡改和路径穿越形式的照片请求", async () => {
    const target = app(undefined, { grantTtlSeconds: 1 });
    const now = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const experience = await validRequest(target).expect(200);
    const cookie = experience.headers["set-cookie"]?.[0]?.split(";")[0];
    expect(cookie).toBeTruthy();

    dateSpy.mockReturnValue(now + 2_000);
    await request(target)
      .get("/api/people/demo-xiaoxia/photo")
      .set("cookie", cookie!)
      .expect(403);
    dateSpy.mockRestore();

    await request(target)
      .get("/api/people/demo-xiaoxia/photo")
      .set("cookie", `${cookie}tampered`)
      .expect(403);
    await request(target)
      .get("/api/people/%2E%2E%2Fpeople.json/photo")
      .set("cookie", cookie!)
      .expect(404);
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

  it("real 模式忽略客户端演示状态", async () => {
    let capturedDemoCase: string | undefined;
    const providers = createMockProviders();
    providers.faceMatch = {
      match: async (photo) => {
        capturedDemoCase = photo.demoCase;
        return { faceCount: 0, candidates: [] };
      },
    };
    await request(app(providers, { providerMode: "real" }))
      .post("/api/experience")
      .field("consent", "true")
      .field("demoCase", "provider-error")
      .attach("photo", validJpeg, {
        filename: "photo.jpg",
        contentType: "image/jpeg",
      })
      .expect(422);
    expect(capturedDemoCase).toBe("success");
  });

  it("启动时校验人物库结构和授权状态", () => {
    expect(() =>
      parsePeople([
        {
          id: "person",
          displayName: "人物",
          oldPhotoUrl: "/api/people/person/photo",
          oldPhotoFile: "person.jpg",
          authorization: "unknown",
          sourceNote: "说明",
        },
      ]),
    ).toThrow();
  });
});
