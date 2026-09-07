import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { ApiClientError, type ExperienceResult } from "../src/api";

const successResult: ExperienceResult = {
  requestId: "request-1",
  retention: "现场照片仅在本次请求内存中处理，响应完成后即释放，不落盘。",
  match: {
    matched: true,
    score: 0.94,
    threshold: 0.82,
    confidence: "high",
    person: {
      id: "demo-xiaoxia",
      oldPhotoUrl: "/api/people/demo-xiaoxia/photo",
      sourceNote: "项目自制几何插画，不构成真实人物资料。",
      faceBox: { left: 0.2, top: 0.15, width: 0.3, height: 0.4 },
    },
  },
  differences: [
    { category: "hairstyle", description: "发型从短发变为长发。" },
    { category: "accessory", description: "新照中多了一副眼镜。" },
    { category: "gaze", description: "视线从直视镜头变为微微转向一侧。" },
  ],
  story: {
    label: "AI 创作/虚构",
    title: "一张虚构明信片",
    content: "这是一则跨越二十年的温暖虚构故事。",
    disclaimer: "本故事由 AI 虚构，不代表人物的真实经历。",
  },
  narration: {
    mimeType: "audio/mpeg",
    audioBase64: "bW9jay1tcDM=",
    provider: "azure-speech",
  },
};

async function reachPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox"));
  await user.type(screen.getByLabelText("启动验证码"), "123456");
  await user.click(screen.getByRole("button", { name: "验证并开始拍照" }));
  expect(document.body).not.toHaveTextContent(/演示|示例|模拟|demo|mock/i);
  const photo = new File(["图片"], "today.jpg", { type: "image/jpeg" });
  await user.upload(screen.getByLabelText("从相册选择照片"), photo);
  expect(screen.getByAltText("待上传的当前照片预览")).toBeInTheDocument();
}

describe("移动端核心体验", () => {
  it("未明确授权时不进入拍摄并给出可聚焦提示", async () => {
    const user = userEvent.setup();
    render(<App authorize={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "验证并开始拍照" }));
    render(<App />);
    expect(document.body).not.toHaveTextContent(/演示|示例|模拟|demo|mock/i);
    expect(screen.getByRole("alert")).toHaveTextContent("请先主动勾选授权");
    expect(screen.queryByRole("heading", { name: "拍一张今天的你" })).not.toBeInTheDocument();
  });

  it("验证码通过服务端校验后才进入拍摄", async () => {
    const user = userEvent.setup();
    const authorize = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError({
          code: "AUTH_CODE_INVALID",
          message: "验证码不正确",
          explanation: "请检查服务启动日志中的 6 位验证码后重试。",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(undefined);
    render(<App authorize={authorize} />);

    await user.click(screen.getByRole("checkbox"));
    await user.type(screen.getByLabelText("启动验证码"), "654321");
    await user.click(screen.getByRole("button", { name: "验证并开始拍照" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请检查服务启动日志");
    expect(screen.queryByRole("heading", { name: "拍一张今天的你" })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("启动验证码"));
    await user.type(screen.getByLabelText("启动验证码"), "123456");
    await user.click(screen.getByRole("button", { name: "验证并开始拍照" }));
    expect(await screen.findByRole("heading", { name: "拍一张今天的你" })).toBeInTheDocument();
    expect(authorize).toHaveBeenNthCalledWith(1, "654321");
    expect(authorize).toHaveBeenNthCalledWith(2, "123456");
  });

  it("从相册选择照片时不请求打开摄像头", async () => {
    const user = userEvent.setup();
    render(<App authorize={vi.fn().mockResolvedValue(undefined)} />);

    await user.click(screen.getByRole("checkbox"));
    await user.type(screen.getByLabelText("启动验证码"), "123456");
    await user.click(screen.getByRole("button", { name: "验证并开始拍照" }));

    const galleryInput = screen.getByLabelText("从相册选择照片");
    expect(galleryInput).toHaveAttribute("type", "file");
    expect(galleryInput).toHaveAttribute(
      "accept",
      "image/jpeg,image/png,image/webp",
    );
    expect(galleryInput).not.toHaveAttribute("capture");
  });

  it("完成选择、预览、确认、可信结果和重新体验", async () => {
    const user = userEvent.setup();
    const analyze = vi.fn().mockResolvedValue(successResult);
    render(<App analyze={analyze} authorize={vi.fn().mockResolvedValue(undefined)} />);

    await reachPreview(user);
    await user.click(screen.getByRole("button", { name: "确认并生成故事" }));

    expect(await screen.findByRole("heading", { name: "找到一张旧照" })).toBeInTheDocument();
    expect(screen.getAllByText(/AI 创作\/虚构/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("匹配分数 94%")).toBeInTheDocument();
    expect(screen.getByText("结论阈值 82%")).toBeInTheDocument();
    expect(screen.getByText("眼神")).toBeInTheDocument();
    expect(screen.getByText("视线从直视镜头变为微微转向一侧。")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/演示|示例|模拟|demo|mock/i);
    expect(screen.getByLabelText("故事情感朗读")).toHaveAttribute("src", "blob:本地预览");
    expect(screen.getByLabelText("故事情感朗读")).toHaveAttribute("autoplay");
    expect(URL.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audio/mpeg" }),
    );
    expect(screen.getByLabelText("匹配人物位置")).toHaveStyle({
      left: "20%",
      top: "15%",
      width: "30%",
      height: "40%",
    });
    expect(screen.getByLabelText("匹配人物位置")).toBeEmptyDOMElement();
    expect(screen.getByText("这是一则跨越二十年的温暖虚构故事。")).toBeInTheDocument();
    expect(analyze).toHaveBeenCalledWith(expect.any(File), true, "success");

    await user.click(screen.getByRole("button", { name: "重新体验" }));
    expect(screen.getByRole("heading", { name: "开始前，请了解你的照片如何被使用" })).toBeInTheDocument();
    await waitFor(() =>
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:本地预览"),
    );
  });

  it("显示无人脸的中文原因并允许重新拍摄", async () => {
    const user = userEvent.setup();
    const analyze = vi.fn().mockRejectedValue(
      new ApiClientError({
        code: "NO_FACE",
        message: "没有检测到清晰人脸",
        explanation: "请换一张光线充足、正面且脸部无遮挡的单人照片。",
        retryable: true,
        requestId: "request-2",
      }),
    );
    render(<App analyze={analyze} authorize={vi.fn().mockResolvedValue(undefined)} />);

    await reachPreview(user);
    await user.click(screen.getByRole("button", { name: "确认并生成故事" }));

    expect(await screen.findByRole("heading", { name: "没有检测到清晰人脸" })).toBeInTheDocument();
    expect(screen.getByText(/光线充足/)).toBeInTheDocument();
    expect(screen.getByText("请求标识：request-2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新拍摄" }));
    expect(screen.getByRole("heading", { name: "拍一张今天的你" })).toBeInTheDocument();
  });

  it("在上传前拒绝无效图片", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const analyze = vi.fn();
    render(<App analyze={analyze} authorize={vi.fn().mockResolvedValue(undefined)} />);
    await user.click(screen.getByRole("checkbox"));
    await user.type(screen.getByLabelText("启动验证码"), "123456");
    await user.click(screen.getByRole("button", { name: "验证并开始拍照" }));
    await user.upload(
      screen.getByLabelText("从相册选择照片"),
      new File(["文本"], "note.txt", { type: "text/plain" }),
    );
    expect(screen.getByRole("heading", { name: "图片格式无效" })).toBeInTheDocument();
    expect(analyze).not.toHaveBeenCalled();
  });
});
