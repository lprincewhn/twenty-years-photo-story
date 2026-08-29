export type ErrorCode =
  | "CONSENT_REQUIRED"
  | "PHOTO_REQUIRED"
  | "INVALID_IMAGE"
  | "PHOTO_TOO_LARGE"
  | "NO_FACE"
  | "MULTIPLE_FACES"
  | "MATCH_BELOW_THRESHOLD"
  | "PROVIDER_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly explanation: string,
    public readonly retryable: boolean,
    public readonly details?: Record<string, number>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function faceCountError(faceCount: number): AppError {
  if (faceCount === 0) {
    return new AppError(
      422,
      "NO_FACE",
      "没有检测到清晰人脸",
      "请换一张光线充足、正面且脸部无遮挡的单人照片。",
      true,
    );
  }
  return new AppError(
    422,
    "MULTIPLE_FACES",
    "检测到多张人脸",
    "为避免把人物认错，请选择只包含一人的照片后重试。",
    true,
  );
}

