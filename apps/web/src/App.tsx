import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  analyzePhoto,
  ApiClientError,
  type AnalyzePhoto,
  type ApiErrorInfo,
  type DemoCase,
  type ExperienceResult,
} from "./api";
import { captureFrame, stopMediaStream } from "./camera";

type Phase = "intro" | "capture" | "preview" | "uploading" | "result" | "error";

const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const validTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const categoryNames = {
  hairstyle: "发型",
  clothing: "服饰",
  expression: "表情",
  accessory: "配饰",
};

interface AppProps {
  analyze?: AnalyzePhoto;
}

function localError(
  code: string,
  message: string,
  explanation: string,
): ApiErrorInfo {
  return { code, message, explanation, retryable: true };
}

export function App({ analyze = analyzePhoto }: AppProps) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [consent, setConsent] = useState(false);
  const [consentError, setConsentError] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [result, setResult] = useState<ExperienceResult | null>(null);
  const [error, setError] = useState<ApiErrorInfo | null>(null);
  const [demoCase, setDemoCase] = useState<DemoCase>("success");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraMessage, setCameraMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const consentErrorRef = useRef<HTMLParagraphElement>(null);
  const privacyId = useId();

  useEffect(() => {
    if (!photo) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  useEffect(() => {
    if (phase !== "capture") {
      stopMediaStream(streamRef.current);
      streamRef.current = null;
      setCameraReady(false);
    }
  }, [phase]);

  useEffect(
    () => () => {
      stopMediaStream(streamRef.current);
    },
    [],
  );

  const begin = () => {
    if (!consent) {
      setConsentError("请先主动勾选授权，再开始拍照。");
      window.setTimeout(() => consentErrorRef.current?.focus(), 0);
      return;
    }
    setConsentError("");
    setPhase("capture");
  };

  const startCamera = async () => {
    setCameraMessage("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraMessage("当前浏览器不支持直接拍照，请使用下方相册选择。");
      return;
    }
    try {
      stopMediaStream(streamRef.current);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraReady(true);
    } catch {
      stopMediaStream(streamRef.current);
      streamRef.current = null;
      setCameraReady(false);
      setCameraMessage(
        "相机权限被拒绝或无法启动。照片尚未上传，你仍可从相册选择一张照片。",
      );
    }
  };

  const usePhoto = (selected: File) => {
    if (!validTypes.has(selected.type)) {
      setError(
        localError(
          "INVALID_IMAGE",
          "图片格式无效",
          "请选择 JPEG、PNG 或 WebP 图片。",
        ),
      );
      setPhase("error");
      return;
    }
    if (selected.size > MAX_PHOTO_BYTES) {
      setError(
        localError(
          "PHOTO_TOO_LARGE",
          "图片太大",
          "单张图片最大为 6 MiB，请压缩或重新选择。",
        ),
      );
      setPhase("error");
      return;
    }
    setPhoto(selected);
    setError(null);
    setPhase("preview");
  };

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (selected) usePhoto(selected);
    event.target.value = "";
  };

  const takePhoto = async () => {
    if (!videoRef.current) return;
    try {
      const captured = await captureFrame(videoRef.current);
      usePhoto(captured);
    } catch {
      setCameraMessage("相机画面尚未准备好，请稍候再拍，或从相册选择。");
    }
  };

  const submit = async () => {
    if (!photo) return;
    setPhase("uploading");
    setError(null);
    try {
      const nextResult = await analyze(photo, true, demoCase);
      setResult(nextResult);
      setPhase("result");
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught.info
          : localError(
              "NETWORK_ERROR",
              "网络连接失败",
              "照片没有被服务保存。请检查网络后再次提交。",
            ),
      );
      setPhase("error");
    }
  };

  const retake = () => {
    setPhoto(null);
    setResult(null);
    setError(null);
    setCameraMessage("");
    setPhase("capture");
  };

  const reset = () => {
    setPhoto(null);
    setResult(null);
    setError(null);
    setConsent(false);
    setConsentError("");
    setCameraMessage("");
    setDemoCase("success");
    setPhase("intro");
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <p className="eyebrow">一张照片 · 一次当下的想象</p>
        <h1>二十年前与现在</h1>
        <p>找回旧相册的色彩，也为今天写一则温柔的虚构故事。</p>
      </header>

      <main id="main" className="card" tabIndex={-1}>
        <nav aria-label="体验进度" className="progress">
          <span aria-current={phase === "intro" ? "step" : undefined}>1 授权</span>
          <span aria-current={["capture", "preview"].includes(phase) ? "step" : undefined}>
            2 拍照
          </span>
          <span aria-current={["uploading", "result", "error"].includes(phase) ? "step" : undefined}>
            3 故事
          </span>
        </nav>

        {phase === "intro" && (
          <section aria-labelledby="intro-title">
            <h2 id="intro-title">开始前，请了解你的照片如何被使用</h2>
            <ul className="promise-list" id={privacyId}>
              <li><strong>仅用于本次体验：</strong>现场照片在服务端内存中处理，响应后释放。</li>
              <li><strong>默认不留存：</strong>不落盘、不进入人物库、不用于训练。</li>
              <li><strong>谨慎表达：</strong>只描述发型、服饰、表情、配饰等可见特征。</li>
              <li><strong>不是身份认证：</strong>mock 匹配只模拟产品流程，低于阈值不下结论。</li>
              <li><strong>故事是虚构：</strong>生成内容会显著标记“AI 创作/虚构”。</li>
            </ul>
            <label className="consent">
              <input
                type="checkbox"
                checked={consent}
                aria-describedby={privacyId}
                onChange={(event) => {
                  setConsent(event.target.checked);
                  if (event.target.checked) setConsentError("");
                }}
              />
              <span>我已阅读并同意为本次体验拍摄或选择照片并上传分析。</span>
            </label>
            {consentError && (
              <p
                className="inline-error"
                role="alert"
                tabIndex={-1}
                ref={consentErrorRef}
              >
                {consentError}
              </p>
            )}
            <button className="primary" type="button" onClick={begin}>
              开始拍照
            </button>
          </section>
        )}

        {phase === "capture" && (
          <section aria-labelledby="capture-title">
            <h2 id="capture-title">拍一张今天的你</h2>
            <p className="hint">请保持单人、正面、光线充足。确认前不会上传。</p>
            <div className="camera-frame">
              <video ref={videoRef} muted playsInline aria-label="前置相机实时预览" />
              {!cameraReady && <span aria-hidden="true">相机画面将在这里出现</span>}
            </div>
            {cameraMessage && <p className="notice" role="status">{cameraMessage}</p>}
            <div className="button-stack">
              {!cameraReady ? (
                <button className="secondary" type="button" onClick={startCamera}>
                  开启前置相机
                </button>
              ) : (
                <button className="primary" type="button" onClick={takePhoto}>
                  拍下这张
                </button>
              )}
              <label className="file-button">
                从相册选择照片
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="user"
                  onChange={chooseFile}
                />
              </label>
            </div>
            {import.meta.env.DEV && (
              <details className="demo-options">
                <summary>演示其他识别状态</summary>
                <label>
                  演示状态
                  <select
                    value={demoCase}
                    onChange={(event) => setDemoCase(event.target.value as DemoCase)}
                  >
                    <option value="success">成功结果</option>
                    <option value="no-face">没有检测到人脸</option>
                    <option value="multiple-faces">检测到多张人脸</option>
                    <option value="unmatched">低于匹配阈值</option>
                    <option value="provider-error">分析服务暂不可用</option>
                  </select>
                </label>
                <p>此选项只控制无密钥 mock，用于验收中文失败状态。</p>
              </details>
            )}
          </section>
        )}

        {phase === "preview" && photo && (
          <section aria-labelledby="preview-title">
            <h2 id="preview-title">确认使用这张照片吗？</h2>
            {previewUrl ? (
              <img className="preview-photo" src={previewUrl} alt="待上传的当前照片预览" />
            ) : (
              <p role="status">正在准备本地预览…</p>
            )}
            <p className="hint">点击确认后才会上传；服务端默认不留存。</p>
            <div className="button-row">
              <button className="secondary" type="button" onClick={retake}>重拍</button>
              <button className="primary" type="button" onClick={submit}>确认并生成故事</button>
            </div>
          </section>
        )}

        {phase === "uploading" && (
          <section className="centered" aria-labelledby="upload-title" aria-live="polite">
            <div className="loader" aria-hidden="true" />
            <h2 id="upload-title">正在寻找时光线索…</h2>
            <p>正在进行示例匹配、可见差异分析和虚构故事创作。</p>
          </section>
        )}

        {phase === "result" && result && photo && (
          <section aria-labelledby="result-title">
            <p className="ai-badge">AI 创作/虚构 · 非真实经历</p>
            <h2 id="result-title">找到一张示例旧照</h2>
            <div className="photo-pair">
              <figure>
                <div className="matched-photo">
                  <img src={result.match.person.oldPhotoUrl} alt="匹配到的旧照" />
                  {result.match.person.faceBox && (
                    <span
                      className="face-highlight"
                      aria-label="匹配人物位置"
                      style={{
                        left: `${result.match.person.faceBox.left * 100}%`,
                        top: `${result.match.person.faceBox.top * 100}%`,
                        width: `${result.match.person.faceBox.width * 100}%`,
                        height: `${result.match.person.faceBox.height * 100}%`,
                      }}
                    >
                      <span>你</span>
                    </span>
                  )}
                </div>
                <figcaption>二十年前 · 已框选匹配人物</figcaption>
              </figure>
              <figure>
                {previewUrl ? <img src={previewUrl} alt="本次上传的当前照片" /> : null}
                <figcaption>现在 · 你的本次照片</figcaption>
              </figure>
            </div>
            <div className="confidence">
              <span>模拟匹配分数 {(result.match.score * 100).toFixed(0)}%</span>
              <span>结论阈值 {(result.match.threshold * 100).toFixed(0)}%</span>
            </div>
            <p className="source-note">{result.match.person.sourceNote}</p>
            <h3>只看得见的变化</h3>
            <ul className="difference-list">
              {result.differences.map((difference) => (
                <li key={`${difference.category}-${difference.description}`}>
                  <span>{categoryNames[difference.category]}</span>
                  {difference.description}
                </li>
              ))}
            </ul>
            <article className="story" aria-labelledby="story-title">
              <p className="story-label">{result.story.label}</p>
              <h3 id="story-title">{result.story.title}</h3>
              <p>{result.story.content}</p>
              <footer>{result.story.disclaimer}</footer>
            </article>
            <div className="narration">
              <strong>有感情地听故事</strong>
              <audio
                aria-label="故事情感朗读"
                autoPlay
                controls
                src={`data:${result.narration.mimeType};base64,${result.narration.audioBase64}`}
              >
                当前浏览器不支持音频播放。
              </audio>
            </div>
            <p className="retention">{result.retention}</p>
            <button className="primary" type="button" onClick={reset}>重新体验</button>
          </section>
        )}

        {phase === "error" && error && (
          <section className="error-panel" aria-labelledby="error-title" role="alert">
            <span className="error-icon" aria-hidden="true">!</span>
            <h2 id="error-title">{error.message}</h2>
            <p>{error.explanation}</p>
            {error.code === "MATCH_BELOW_THRESHOLD" && error.details && (
              <p>
                本次分数 {((error.details.score ?? 0) * 100).toFixed(0)}%，
                阈值 {((error.details.threshold ?? 0) * 100).toFixed(0)}%。
                低于阈值，因此不显示候选身份。
              </p>
            )}
            {error.requestId && <p className="request-id">请求标识：{error.requestId}</p>}
            <div className="button-row">
              {photo && error.retryable && (
                <button className="secondary" type="button" onClick={() => setPhase("preview")}>
                  再次提交
                </button>
              )}
              <button className="primary" type="button" onClick={retake}>重新拍摄</button>
            </div>
          </section>
        )}
      </main>

      <footer className="page-footer">
        <p>演示人物为自制插画，不含未授权真实人物照片。</p>
      </footer>
    </div>
  );
}
