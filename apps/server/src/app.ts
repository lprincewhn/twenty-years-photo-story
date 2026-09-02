import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import type { AppConfig } from "./config.js";
import { AppError, faceCountError } from "./errors.js";
import {
  hasValidImageSignature,
  MAX_PHOTO_BYTES,
  supportedPhotoMimeTypes,
} from "./photo-validation.js";
import { isPhotoFullyAuthorized, loadPeopleLibrary, resolvePeople } from "./people.js";
import {
  allowedDifferenceCategories,
  type DemoCase,
  type PhotoInput,
  type ProviderSet,
} from "./providers/types.js";

const peopleAssetsDirectory = fileURLToPath(new URL("./assets/people", import.meta.url));
const validRequestId = /^[A-Za-z0-9_-]{1,64}$/;
const photoContentTypes: Readonly<Record<string, string>> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
const demoCases = new Set<DemoCase>([
  "success",
  "no-face",
  "multiple-faces",
  "unmatched",
  "provider-error",
]);

export interface AppDependencies {
  config: AppConfig;
  providers: ProviderSet;
}

interface PhotoGrant {
  personId: string;
  exp: number;
  requestId: string;
}

function signGrant(payload: PhotoGrant, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function readCookie(request: Request, name: string): string | undefined {
  for (const cookie of request.headers.cookie?.split(";") ?? []) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex !== -1 && cookie.slice(0, separatorIndex).trim() === name) {
      return cookie.slice(separatorIndex + 1).trim();
    }
  }
  return undefined;
}

function verifyGrant(token: string | undefined, personId: string, secret: string): boolean {
  if (!token) {
    return false;
  }
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    return false;
  }

  const expectedSignature = createHmac("sha256", secret).update(encodedPayload).digest();
  let actualSignature: Buffer;
  try {
    actualSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return false;
  }
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown;
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("personId" in payload) ||
      !("exp" in payload) ||
      !("requestId" in payload)
    ) {
      return false;
    }
    const grant = payload as Record<string, unknown>;
    return (
      grant.personId === personId &&
      typeof grant.exp === "number" &&
      Number.isInteger(grant.exp) &&
      grant.exp > Math.floor(Date.now() / 1000) &&
      typeof grant.requestId === "string" &&
      validRequestId.test(grant.requestId)
    );
  } catch {
    return false;
  }
}

function zeroingMemoryStorage(): multer.StorageEngine {
  const storage = multer.memoryStorage();
  return {
    _handleFile: storage._handleFile.bind(storage),
    _removeFile(request, file, callback) {
      file.buffer?.fill(0);
      storage._removeFile(request, file, callback);
    },
  };
}

function requestContext(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const incomingRequestId = request.header("x-request-id");
  response.locals.requestId =
    incomingRequestId && validRequestId.test(incomingRequestId)
      ? incomingRequestId
      : randomUUID();
  response.setHeader("x-request-id", response.locals.requestId as string);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  next();
}

function sendError(response: Response, error: AppError): void {
  response.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      explanation: error.explanation,
      retryable: error.retryable,
      requestId: response.locals.requestId as string,
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

function normalizeFaceBox(
  faceBox: { left: number; top: number; width: number; height: number } | null,
  photoWidth: number | null,
  photoHeight: number | null,
) {
  if (!faceBox || !photoWidth || !photoHeight) return null;
  return {
    left: faceBox.left / photoWidth,
    top: faceBox.top / photoHeight,
    width: faceBox.width / photoWidth,
    height: faceBox.height / photoHeight,
  };
}

export function createApp({ config, providers }: AppDependencies) {
  const app = express();
  const peopleLibrary = loadPeopleLibrary();
  const people = resolvePeople(peopleLibrary);
  const upload = multer({
    storage: zeroingMemoryStorage(),
    limits: {
      files: 1,
      fileSize: MAX_PHOTO_BYTES,
      fields: 4,
    },
  });

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(requestContext);
  app.use((request, response, next) => {
    if (request.header("origin") === config.allowedOrigin) {
      response.setHeader("access-control-allow-origin", config.allowedOrigin);
      response.setHeader("vary", "Origin");
    }
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", providerMode: config.providerMode });
  });

  const experienceLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, response) => {
      sendError(
        response,
        new AppError(
          429,
          "RATE_LIMITED",
          "操作太频繁",
          "照片没有被保存。请稍候一分钟再试。",
          true,
        ),
      );
    },
  });

  const photoLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, response) => {
      sendError(
        response,
        new AppError(
          429,
          "RATE_LIMITED",
          "操作太频繁",
          "请稍候一分钟再查看人物照片。",
          true,
        ),
      );
    },
  });

  app.get("/api/people/:personId/photo", photoLimiter, async (request, response) => {
    const person = people.find((entry) => entry.id === request.params.personId);
    if (!person) {
      throw new AppError(
        404,
        "PERSON_PHOTO_NOT_FOUND",
        "人物照片不存在",
        "该人物照片不存在或已撤回。",
        false,
      );
    }
    if (
      config.providerMode === "real" &&
      !isPhotoFullyAuthorized(peopleLibrary, person.photoId)
    ) {
      throw new AppError(
        404,
        "PERSON_PHOTO_NOT_FOUND",
        "人物照片不存在",
        "该合影尚未取得全员授权或已有人撤回授权。",
        false,
      );
    }
    if (!verifyGrant(readCookie(request, "ps_grant"), person.id, config.peopleAssetSecret)) {
      throw new AppError(
        403,
        "PHOTO_GRANT_REQUIRED",
        "无权查看人物照片",
        "请先完成本次照片匹配，再查看对应人物照片。",
        false,
      );
    }

    const assetPath = resolve(peopleAssetsDirectory, person.oldPhotoFile);
    if (!assetPath.startsWith(`${resolve(peopleAssetsDirectory)}${sep}`)) {
      throw new AppError(
        404,
        "PERSON_PHOTO_NOT_FOUND",
        "人物照片不存在",
        "该人物照片不存在或已撤回。",
        false,
      );
    }
    const contentType = photoContentTypes[extname(assetPath).toLowerCase()];
    if (!contentType) {
      throw new Error("人物照片格式不在允许列表中");
    }

    const photo = await readFile(assetPath);
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("content-disposition", "inline");
    response.setHeader("content-type", contentType);
    if (contentType === "image/svg+xml") {
      response.setHeader("content-security-policy", "default-src 'none'");
    }
    response.send(photo);
  });

  app.post(
    "/api/experience",
    experienceLimiter,
    upload.single("photo"),
    async (request, response) => {
      const bytes = request.file?.buffer;
      try {
        if (request.body?.consent !== "true") {
          throw new AppError(
            400,
            "CONSENT_REQUIRED",
            "需要明确授权",
            "请先阅读照片用途和保留说明，并主动勾选授权后再上传。",
            false,
          );
        }
        if (!request.file || !bytes) {
          throw new AppError(
            400,
            "PHOTO_REQUIRED",
            "请选择一张照片",
            "请拍摄或从相册选择一张 JPEG、PNG 或 WebP 图片。",
            true,
          );
        }
        if (
          !supportedPhotoMimeTypes.has(request.file.mimetype) ||
          !hasValidImageSignature(bytes, request.file.mimetype)
        ) {
          throw new AppError(
            400,
            "INVALID_IMAGE",
            "图片格式无效",
            "只支持 JPEG、PNG 或 WebP 图片，请重新选择。",
            true,
          );
        }

        const requestedDemoCase =
          config.providerMode === "mock"
            ? (request.body?.demoCase as string | undefined)
            : undefined;
        const demoCase: DemoCase =
          requestedDemoCase && demoCases.has(requestedDemoCase as DemoCase)
            ? (requestedDemoCase as DemoCase)
            : "success";
        const photo: PhotoInput = {
          bytes,
          mimeType: request.file.mimetype,
          demoCase,
          signal: AbortSignal.timeout(30_000),
        };

        try {
          const faceOutput = await providers.faceMatch.match(photo);
          if (faceOutput.faceCount !== 1) {
            throw faceCountError(faceOutput.faceCount);
          }

          const candidate = [...faceOutput.candidates].sort((a, b) => b.score - a.score)[0];
          const score = candidate?.score ?? 0;
          if (!Number.isFinite(score) || score < 0 || score > 1) {
            throw new Error("provider 返回了无效分数");
          }
          if (!candidate || score < config.matchThreshold) {
            throw new AppError(
              422,
              "MATCH_BELOW_THRESHOLD",
              "未找到足够可信的匹配",
              "本次分数低于阈值，因此不会给出人物结论。可以换一张更清晰的正面照片重试。",
              true,
              { score, threshold: config.matchThreshold },
            );
          }

          const person = people.find((entry) => entry.id === candidate.personId);
          if (
            !person ||
            (config.providerMode === "real" &&
              !isPhotoFullyAuthorized(peopleLibrary, person.photoId))
          ) {
            throw new Error("provider 候选不在授权人物库");
          }
          let rawDifferences;
          if (config.providerMode === "real") {
            if (person.photoMimeType === "image/svg+xml") {
              throw new Error("real provider 不支持 SVG 人物照片");
            }
            const referencePath = resolve(peopleAssetsDirectory, person.oldPhotoFile);
            if (!referencePath.startsWith(`${resolve(peopleAssetsDirectory)}${sep}`)) {
              throw new Error("人物照片路径无效");
            }
            const referenceBytes = await readFile(referencePath);
            try {
              rawDifferences = await providers.difference.analyze(photo, {
                bytes: referenceBytes,
                mimeType: person.photoMimeType,
              });
            } finally {
              referenceBytes.fill(0);
            }
          } else {
            rawDifferences = await providers.difference.analyze(photo);
          }
          const differences = rawDifferences.filter((item) =>
            allowedDifferenceCategories.includes(item.category),
          );
          const safeDifferences =
            differences.length > 0
              ? differences
              : [{ category: "expression" as const, description: "两张照片都记录了自然的神态。" }];
          const generatedStory = await providers.story.generate(
            safeDifferences,
            photo.signal,
          );
          const story = {
            ...generatedStory,
            label: "AI 创作/虚构" as const,
            disclaimer: "本故事由 AI 根据可见元素虚构，不代表人物的真实经历。",
          };

          const requestId = response.locals.requestId as string;
          const grant = signGrant(
            {
              personId: person.id,
              exp: Math.floor(Date.now() / 1000) + config.grantTtlSeconds,
              requestId,
            },
            config.peopleAssetSecret,
          );
          response.cookie("ps_grant", grant, {
            httpOnly: true,
            secure: true,
            sameSite: "strict",
            maxAge: config.grantTtlSeconds * 1000,
            path: "/api/people",
          });
          response.json({
            requestId,
            retention: "现场照片仅在本次请求内存中处理，响应完成后即释放，不落盘、不用于训练。",
            match: {
              matched: true,
              score,
              threshold: config.matchThreshold,
              confidence: score >= 0.92 ? "high" : "medium",
              person: {
                id: person.id,
                oldPhotoUrl: person.oldPhotoUrl,
                sourceNote: person.sourceNote,
                faceBox: normalizeFaceBox(
                  person.faceBox,
                  person.photoWidth,
                  person.photoHeight,
                ),
              },
            },
            differences: safeDifferences,
            story,
          });
        } catch (error) {
          if (error instanceof AppError) {
            throw error;
          }
          throw new AppError(
            502,
            "PROVIDER_UNAVAILABLE",
            "分析服务暂时不可用",
            "照片没有被保存。请稍后重试；若持续发生，请使用请求标识联系维护人员。",
            true,
          );
        }
      } finally {
        bytes?.fill(0);
      }
    },
  );

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    void _next;
    request.file?.buffer?.fill(0);
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        sendError(
          response,
          new AppError(
            413,
            "PHOTO_TOO_LARGE",
            "图片太大",
            "单张图片最大为 6 MiB，请压缩或重新选择。",
            true,
          ),
        );
        return;
      }
      if (
        error.code === "LIMIT_UNEXPECTED_FILE" ||
        error.code === "LIMIT_FILE_COUNT"
      ) {
        sendError(
          response,
          new AppError(
            400,
            "INVALID_IMAGE",
            "图片字段无效",
            "请只通过 photo 字段上传一张 JPEG、PNG 或 WebP 图片。",
            true,
          ),
        );
        return;
      }
      sendError(
        response,
        new AppError(
          400,
          "INVALID_REQUEST",
          "请求字段无效",
          "上传请求包含过多或无效字段，请刷新页面后重试。",
          true,
        ),
      );
      return;
    }
    if (error instanceof AppError) {
      sendError(response, error);
      return;
    }
    sendError(
      response,
      new AppError(
        500,
        "INTERNAL_ERROR",
        "服务处理失败",
        "照片没有被保存。请稍后重试，并在需要时提供请求标识。",
        true,
      ),
    );
  };
  app.use(errorHandler);

  return app;
}
