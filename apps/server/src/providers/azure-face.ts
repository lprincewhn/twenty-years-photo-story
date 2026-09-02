import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { z } from "zod";
import type { AzureFaceConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { FaceBox, PeopleLibrary } from "../people.js";
import type { FaceMatchProvider, FaceMatchOutput, PhotoInput } from "./types.js";

const cognitiveServicesScope = "https://cognitiveservices.azure.com/.default";

const azureErrorSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
    innererror: z.object({ code: z.string().optional() }).optional(),
  }).optional(),
});
const faceSchema = z.object({
  faceId: z.string().uuid().optional(),
  faceRectangle: z.object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  faceAttributes: z.object({
    qualityForRecognition: z.enum(["low", "medium", "high"]).optional(),
  }).optional(),
});
const identifySchema = z.array(z.object({
  faceId: z.string().uuid(),
  candidates: z.array(z.object({
    personId: z.string().uuid(),
    confidence: z.number().min(0).max(1),
  })),
}));

class AzureServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly innerCode: string | undefined,
  ) {
    super(`Azure Face 请求失败 (${status}, ${innerCode ?? code ?? "unknown"})`);
  }
}

export interface DetectedFace {
  faceId?: string;
  faceRectangle: FaceBox;
  qualityForRecognition?: "low" | "medium" | "high";
}

export interface AzureIdentifyResult {
  faceId: string;
  candidates: Array<{ personId: string; confidence: number }>;
}

export interface AzureFaceClientDependencies {
  credential?: TokenCredential;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function providerUnavailable(retryable: boolean): AppError {
  return new AppError(
    502,
    "PROVIDER_UNAVAILABLE",
    "分析服务暂时不可用",
    "照片没有被保存。请稍后重试；若持续发生，请使用请求标识联系维护人员。",
    retryable,
  );
}

function mapAzureError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof AzureServiceError) {
    if (error.status === 429 || error.code === "QuotaExceeded") {
      return new AppError(429, "RATE_LIMITED", "分析服务请求过多", "照片没有被保存，请稍后重试。", true);
    }
    if (error.code === "InvalidImage" || error.code === "InvalidImageSize") {
      return new AppError(400, "INVALID_IMAGE", "图片格式无效", "请使用清晰的 JPEG、PNG 或 WebP 图片重试。", true);
    }
    if (
      error.code === "LargePersonGroupNotTrained" ||
      error.code === "LargePersonGroupTrainingNotFinished"
    ) {
      return providerUnavailable(true);
    }
    if (
      error.innerCode === "UnsupportedFeature" ||
      error.status === 401 ||
      error.code === "PermissionDenied" ||
      error.code === "BadArgument" ||
      error.code === "LargePersonGroupNotFound" ||
      error.code === "PersonNotFound"
    ) {
      return providerUnavailable(false);
    }
    return providerUnavailable(error.status >= 500 || error.status === 408);
  }
  return providerUnavailable(true);
}

export class AzureFaceClient {
  private readonly credential: TokenCredential;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    readonly config: AzureFaceConfig,
    dependencies: AzureFaceClientDependencies = {},
  ) {
    this.credential = dependencies.credential ?? new DefaultAzureCredential(
      config.managedIdentityClientId
        ? { managedIdentityClientId: config.managedIdentityClientId }
        : undefined,
    );
    this.fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private url(path: string, query: Record<string, string | number | boolean | undefined> = {}): string {
    const url = new URL(`${this.config.endpoint}/face/${this.config.apiVersion}/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request(
    path: string,
    init: RequestInit = {},
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<unknown> {
    const token = await this.credential.getToken(cognitiveServicesScope);
    if (!token) throw providerUnavailable(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const inputSignal = init.signal;
    const abortFromCaller = () => controller.abort();
    if (inputSignal?.aborted) controller.abort();
    inputSignal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      const response = await this.fetchImplementation(this.url(path, query), {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token.token}`,
          ...init.headers,
        },
      });
      const text = await response.text();
      let body: unknown;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw providerUnavailable(true);
        }
      }
      if (!response.ok) {
        const parsed = azureErrorSchema.safeParse(body);
        throw new AzureServiceError(
          response.status,
          parsed.success ? parsed.data.error?.code : undefined,
          parsed.success ? parsed.data.error?.innererror?.code : undefined,
        );
      }
      return body;
    } catch (error) {
      if (error instanceof AzureServiceError || error instanceof AppError) throw error;
      throw providerUnavailable(true);
    } finally {
      clearTimeout(timeout);
      inputSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async detect(bytes: Buffer, returnFaceId: boolean, signal?: AbortSignal): Promise<DetectedFace[]> {
    try {
      const body = await this.request("detect", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(bytes),
        signal,
      }, {
        detectionModel: this.config.detectionModel,
        recognitionModel: this.config.recognitionModel,
        returnFaceId,
        returnFaceLandmarks: false,
        returnFaceAttributes: "qualityForRecognition",
        ...(returnFaceId ? { faceIdTimeToLive: this.config.faceIdTtlSeconds } : {}),
      });
      return z.array(faceSchema).parse(body).map((face) => ({
        ...(face.faceId ? { faceId: face.faceId } : {}),
        faceRectangle: face.faceRectangle,
        ...(face.faceAttributes?.qualityForRecognition
          ? { qualityForRecognition: face.faceAttributes.qualityForRecognition }
          : {}),
      }));
    } catch (error) {
      if (error instanceof z.ZodError) throw providerUnavailable(true);
      throw mapAzureError(error);
    }
  }

  async identify(
    faceIds: string[],
    maxCandidates = this.config.maxCandidates,
    signal?: AbortSignal,
  ): Promise<AzureIdentifyResult[]> {
    if (faceIds.length < 1 || faceIds.length > 10) throw new Error("Identify 每批必须包含 1–10 个 faceId");
    try {
      const body = await this.request("identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          faceIds,
          largePersonGroupId: this.config.groupId,
          maxNumOfCandidatesReturned: maxCandidates,
          confidenceThreshold: this.config.identifyThreshold,
        }),
        signal,
      });
      return identifySchema.parse(body);
    } catch (error) {
      if (error instanceof z.ZodError) throw providerUnavailable(true);
      throw mapAzureError(error);
    }
  }

  async selfCheck(attempts = 5, retryDelayMs = 6_000): Promise<void> {
    let group: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        // Azure omits recognitionModel unless it is explicitly requested, and the
        // check below compares it against the configured model.
        group = await this.request(
          `largepersongroups/${encodeURIComponent(this.config.groupId)}`,
          {},
          { returnRecognitionModel: true },
        );
        break;
      } catch (error) {
        if (
          error instanceof AzureServiceError &&
          (error.status === 401 || (error.status === 403 && error.code === "PermissionDenied")) &&
          attempt < attempts
        ) {
          await this.sleep(retryDelayMs);
          continue;
        }
        throw mapAzureError(error);
      }
    }
    const parsedGroup = z.object({ recognitionModel: z.string() }).safeParse(group);
    if (!parsedGroup.success || parsedGroup.data.recognitionModel !== this.config.recognitionModel) {
      throw providerUnavailable(false);
    }
    try {
      const training = z.object({ status: z.enum(["notstarted", "running", "succeeded", "failed"]) })
        .parse(await this.request(`largepersongroups/${encodeURIComponent(this.config.groupId)}/training`));
      if (training.status !== "succeeded") throw providerUnavailable(true);
    } catch (error) {
      if (error instanceof z.ZodError) throw providerUnavailable(true);
      throw mapAzureError(error);
    }
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.request(`largepersongroups/${encodeURIComponent(this.config.groupId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: this.config.groupId,
          recognitionModel: this.config.recognitionModel,
        }),
      });
    } catch (error) {
      throw mapAzureError(error);
    }
  }

  async createPerson(name: string): Promise<string> {
    try {
      const body = await this.request(`largepersongroups/${encodeURIComponent(this.config.groupId)}/persons`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return z.object({ personId: z.string().uuid() }).parse(body).personId;
    } catch (error) {
      if (error instanceof z.ZodError) throw providerUnavailable(true);
      throw mapAzureError(error);
    }
  }

  async addFace(personId: string, bytes: Buffer, faceBox: FaceBox): Promise<string> {
    try {
      const body = await this.request(
        `largepersongroups/${encodeURIComponent(this.config.groupId)}/persons/${encodeURIComponent(personId)}/persistedfaces`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array(bytes),
        },
        {
          targetFace: `${faceBox.left},${faceBox.top},${faceBox.width},${faceBox.height}`,
          detectionModel: this.config.detectionModel,
        },
      );
      return z.object({ persistedFaceId: z.string().uuid() }).parse(body).persistedFaceId;
    } catch (error) {
      if (error instanceof z.ZodError) throw providerUnavailable(true);
      throw mapAzureError(error);
    }
  }

  async deleteFace(personId: string, persistedFaceId: string): Promise<void> {
    try {
      await this.request(
        `largepersongroups/${encodeURIComponent(this.config.groupId)}/persons/${encodeURIComponent(personId)}/persistedfaces/${encodeURIComponent(persistedFaceId)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (
        error instanceof AzureServiceError &&
        (error.status === 404 ||
          error.code === "PersonNotFound" ||
          error.code === "PersistedFaceNotFound")
      ) {
        return;
      }
      throw mapAzureError(error);
    }
  }

  async deletePerson(personId: string): Promise<void> {
    try {
      await this.request(
        `largepersongroups/${encodeURIComponent(this.config.groupId)}/persons/${encodeURIComponent(personId)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (
        error instanceof AzureServiceError &&
        (error.status === 404 || error.code === "PersonNotFound")
      ) {
        return;
      }
      throw mapAzureError(error);
    }
  }

  async train(): Promise<void> {
    try {
      await this.request(`largepersongroups/${encodeURIComponent(this.config.groupId)}/train`, { method: "POST" });
    } catch (error) {
      throw mapAzureError(error);
    }
  }

  async waitForTraining(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const body = z.object({ status: z.enum(["notstarted", "running", "succeeded", "failed"]) })
          .parse(await this.request(`largepersongroups/${encodeURIComponent(this.config.groupId)}/training`));
        if (body.status === "succeeded") return;
        if (body.status === "failed") throw providerUnavailable(false);
      } catch (error) {
        if (error instanceof z.ZodError) throw providerUnavailable(true);
        throw mapAzureError(error);
      }
      await this.sleep(300);
    }
    throw providerUnavailable(true);
  }
}

export class AzureFaceMatchProvider implements FaceMatchProvider {
  private readonly businessIdByAzureId: Map<string, string>;

  constructor(
    private readonly client: AzureFaceClient,
    library: PeopleLibrary,
  ) {
    this.businessIdByAzureId = new Map(
      library.people.flatMap((person) =>
        person.azurePersonId ? [[person.azurePersonId, person.id] as const] : [],
      ),
    );
  }

  async match(photo: PhotoInput): Promise<FaceMatchOutput> {
    const faces = await this.client.detect(photo.bytes, true, photo.signal);
    if (faces.length !== 1) return { faceCount: faces.length, candidates: [] };
    const faceId = faces[0]?.faceId;
    if (!faceId) throw providerUnavailable(true);
    const result = (await this.client.identify([faceId], this.client.config.maxCandidates, photo.signal))[0];
    if (!result) throw providerUnavailable(true);
    const candidates = result.candidates.map((candidate) => {
      const personId = this.businessIdByAzureId.get(candidate.personId);
      if (!personId) throw providerUnavailable(false);
      return { personId, score: candidate.confidence };
    });
    return { faceCount: 1, candidates };
  }
}
