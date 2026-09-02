export type DemoCase =
  | "success"
  | "no-face"
  | "multiple-faces"
  | "unmatched"
  | "provider-error";

export interface VisibleDifference {
  category: "hairstyle" | "clothing" | "expression" | "accessory";
  description: string;
}

export interface ExperienceResult {
  requestId: string;
  retention: string;
  match: {
    matched: true;
    score: number;
    threshold: number;
    confidence: "high" | "medium";
    person: {
      id: string;
      oldPhotoUrl: string;
      sourceNote: string;
      faceBox: {
        left: number;
        top: number;
        width: number;
        height: number;
      } | null;
    };
  };
  differences: VisibleDifference[];
  story: {
    label: "AI 创作/虚构";
    title: string;
    content: string;
    disclaimer: string;
  };
  narration: {
    mimeType: "audio/mpeg" | "audio/wav";
    audioBase64: string;
    provider: "azure-speech" | "mock";
  };
}

export interface ApiErrorInfo {
  code: string;
  message: string;
  explanation: string;
  retryable: boolean;
  requestId?: string;
  details?: {
    score?: number;
    threshold?: number;
  };
}

export class ApiClientError extends Error {
  constructor(public readonly info: ApiErrorInfo) {
    super(info.message);
    this.name = "ApiClientError";
  }
}

export type AnalyzePhoto = (
  photo: File,
  consent: boolean,
  demoCase: DemoCase,
) => Promise<ExperienceResult>;

export const analyzePhoto: AnalyzePhoto = async (photo, consent, demoCase) => {
  const form = new FormData();
  form.append("photo", photo);
  form.append("consent", String(consent));
  form.append("demoCase", demoCase);

  let response: Response;
  try {
    response = await fetch("/api/experience", {
      method: "POST",
      body: form,
    });
  } catch {
    throw new ApiClientError({
      code: "NETWORK_ERROR",
      message: "网络连接失败",
      explanation: "照片尚未得到结果，也不会被服务保存。请检查网络后再次提交。",
      retryable: true,
    });
  }

  const payload = (await response.json()) as
    | ExperienceResult
    | { error?: ApiErrorInfo };
  if (!response.ok) {
    const error =
      "error" in payload && payload.error
        ? payload.error
        : {
            code: "UNKNOWN_ERROR",
            message: "暂时无法完成分析",
            explanation: "服务返回了无法识别的错误，请稍后重试。",
            retryable: true,
          };
    throw new ApiClientError(error);
  }
  return payload as ExperienceResult;
};
