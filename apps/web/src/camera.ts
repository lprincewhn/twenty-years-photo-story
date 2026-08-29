export function stopMediaStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export async function captureFrame(video: HTMLVideoElement): Promise<File> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    throw new Error("相机画面尚未准备好");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("浏览器无法读取相机画面");
  }
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => {
        if (value) resolve(value);
        else reject(new Error("无法生成照片"));
      },
      "image/jpeg",
      0.9,
    );
  });
  return new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });
}

