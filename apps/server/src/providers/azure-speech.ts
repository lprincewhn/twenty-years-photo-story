import type { SpeechConfig } from "../config.js";
import type { NarrationProvider } from "./types.js";

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const SYNTHESIS_TIMEOUT_MS = 15_000;

type AzureSpeechConfig = Extract<SpeechConfig, { mode: "azure" }>;
type Fetch = typeof fetch;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export class AzureSpeechProvider implements NarrationProvider {
  constructor(
    private readonly config: AzureSpeechConfig,
    private readonly fetchImplementation: Fetch = fetch,
  ) {}

  async synthesize(text: string) {
    const response = await this.fetchImplementation(
      `https://${this.config.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "content-type": "application/ssml+xml",
          "ocp-apim-subscription-key": this.config.key,
          "user-agent": "twenty-years-photo-story",
          "x-microsoft-outputformat": "audio-24khz-48kbitrate-mono-mp3",
        },
        body: [
          '<speak version="1.0" xml:lang="zh-CN" xmlns:mstts="https://www.w3.org/2001/mstts">',
          `<voice name="${escapeXml(this.config.voice)}">`,
          `<mstts:express-as style="${escapeXml(this.config.style)}" styledegree="1.2">`,
          escapeXml(text),
          "</mstts:express-as></voice></speak>",
        ].join(""),
        signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`Azure Speech 返回 HTTP ${response.status}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) {
      throw new Error("Azure Speech 返回了无效大小的音频");
    }
    return {
      mimeType: "audio/mpeg" as const,
      audioBase64: audio.toString("base64"),
      provider: "azure-speech" as const,
    };
  }
}
