import { createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import sharp from "sharp";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import * as people from "../src/people.js";
import { createMockProviders } from "../src/providers/mock.js";
import type { ReferencePhotoInput } from "../src/providers/types.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile: vi.fn(),
}));

const config: AppConfig = {
  host: "127.0.0.1",
  port: 3000,
  providerMode: "real",
  matchThreshold: 0.82,
  allowedOrigin: "http://localhost:5173",
  peopleAssetSecret: "test-secret-that-is-at-least-32-characters",
  grantTtlSeconds: 300,
  speech: { mode: "mock" },
};
const accessCode = "123456";
const accessCookie = `ps_access=${createHmac("sha256", config.peopleAssetSecret)
  .update(accessCode).digest("base64url")}`;

function library(authorized: boolean) {
  return people.parsePeopleLibrary({
    schemaVersion: 2,
    photos: [{
      id: "matched-photo",
      file: "matched.png",
      mimeType: "image/png",
      width: 200,
      height: 150,
      sourceNote: "Synthetic test image",
      members: [{
        personId: "matched",
        faceBox: { left: 50, top: 40, width: 20, height: 20 },
      }],
    }],
    people: [{
      id: "matched",
      displayName: "Test person",
      photoId: "matched-photo",
      oldPhotoUrl: "/api/people/matched/photo",
      authorization: authorized ? "authorized" : "placeholder",
      sourceNote: "Synthetic test image",
    }],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.readFile).mockReset();
});

describe("Matched photo scene story", () => {
  it.each(["success", "difference-error", "story-error", "unauthorized"] as const)(
    "uses the full authorized old photo and clears buffers: %s",
    async (outcome) => {
      const original = await sharp({
        create: { width: 200, height: 150, channels: 3, background: "#5488bb" },
      }).png().toBuffer();
      const expectedOriginal = Buffer.from(original);
      const readFile = vi.mocked(fs.readFile).mockResolvedValue(original);
      vi.spyOn(people, "loadPeopleLibrary").mockReturnValue(library(outcome !== "unauthorized"));
      const providers = createMockProviders();
      let uploaded: Buffer | undefined;
      let crop: Buffer | undefined;
      let requestSignal: AbortSignal | undefined;
      let storyPhoto: ReferencePhotoInput | undefined;
      providers.faceMatch.match = vi.fn<typeof providers.faceMatch.match>(async (photo) => {
        uploaded = photo.bytes;
        requestSignal = photo.signal;
        return { faceCount: 1, candidates: [{ personId: "matched", score: 0.95 }] };
      });
      providers.difference.analyze = vi.fn<typeof providers.difference.analyze>(async (_photo, reference) => {
        expect(reference).toBeDefined();
        crop = reference!.bytes;
        expect(reference!.mimeType).toBe("image/jpeg");
        expect((await sharp(crop).metadata()).width).toBe(40);
        if (outcome === "difference-error") throw new Error("Difference unavailable");
        return [{ category: "gaze", description: "注视方向不同。" }];
      });
      const generate = providers.story.generate.bind(providers.story);
      providers.story.generate = vi.fn<typeof providers.story.generate>(async (differences, signal, reference) => {
        storyPhoto = reference;
        expect(reference?.bytes).toEqual(expectedOriginal);
        expect(reference?.mimeType).toBe("image/png");
        expect(signal).toBe(requestSignal);
        expect(differences).toEqual([{ category: "gaze", description: "注视方向不同。" }]);
        expect(crop?.every((byte) => byte === 0)).toBe(true);
        if (outcome === "story-error") throw new Error("Story unavailable");
        return generate(differences, signal);
      });
      const app = createApp({ config, providers, accessCode });
      const response = await request(app)
        .post("/api/experience")
        .set("cookie", accessCookie)
        .field("consent", "true")
        .attach("photo", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), {
          filename: "current.jpg",
          contentType: "image/jpeg",
        })
        .expect(outcome === "success" ? 200 : 502);

      expect(uploaded?.every((byte) => byte === 0)).toBe(true);
      if (outcome === "unauthorized") {
        expect(readFile).not.toHaveBeenCalled();
        expect(providers.difference.analyze).not.toHaveBeenCalled();
        expect(providers.story.generate).not.toHaveBeenCalled();
      } else {
        expect(readFile).toHaveBeenCalledWith(expect.stringMatching(/matched\.png$/u));
        expect(original.every((byte) => byte === 0)).toBe(true);
        expect(crop?.every((byte) => byte === 0)).toBe(true);
        if (outcome === "difference-error") {
          expect(providers.story.generate).not.toHaveBeenCalled();
        } else {
          expect(storyPhoto?.bytes).toBe(original);
          expect(providers.story.generate).toHaveBeenCalledOnce();
        }
      }
      if (outcome !== "success") {
        expect(response.body.error.code).toBe("PROVIDER_UNAVAILABLE");
        expect(response.body).not.toHaveProperty("story");
      }
    },
  );
});
