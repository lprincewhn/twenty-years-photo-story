# 二十年前与现在 · 照片故事

SVHW-16 的可运行移动端 H5 MVP：用户明确授权后拍摄或选择当前照片，系统从示例人物库执行 mock 匹配，展示允许范围内的可见差异，并生成一则显著标识的虚构故事。

> **重要声明**
>
> - 仓库中的人物资料只有项目自制几何 SVG，占位图不构成真实人脸或真实身份资料；不得导入未获授权的真实人物照片。
> - 现场照片默认只在浏览器与单次服务端请求内存中处理，响应完成后释放；不落盘、不进入人物库、不用于训练。
> - 匹配为无密钥 mock 的流程演示，不是身份认证。低于阈值不会给出人物结论。
> - 故事均显著标记“**AI 创作/虚构**”，不代表也不冒充人物的真实经历。

## 主要能力

- 隐私说明与未预选的显式授权
- `getUserMedia` 前置相机与移动端相册 `capture` 回退
- 预览、重拍、确认后才上传和重新体验
- 可替换的人脸匹配、可见差异分析、故事生成三个 provider 接口
- Azure Speech 情感语音合成，结果生成后自动朗读并保留播放控件
- 默认阈值 0.6，并展示分数、阈值与置信级别
- 只允许发型、服饰、表情、配饰四类客观可见差异
- 成功、相机拒绝、无效图片、无人脸、多人脸、未匹配、网络和 provider 失败中文状态
- 移动端优先的键盘焦点、状态播报、触控尺寸、对比度与减少动画支持

## 技术架构

```text
移动端 React/Vite H5
  ├─ 相机或文件选择（确认前只在本地）
  └─ POST /api/experience（multipart）
       └─ Express 内存上传编排
          ├─ FaceMatchProvider
          ├─ DifferenceProvider（服务端类别过滤）
          └─ StoryProvider（固定 AI 标签与免责声明）
```

项目使用 npm workspaces：

- `apps/web`：React 19、Vite、原生 CSS
- `apps/server`：Express 5、Multer 内存上传、可注入 provider
- `specs/001-photo-story-mvp`：Spec Kit 规范、计划、任务、研究、数据模型、契约和快速开始
- `docs`：接口、部署、人物库、维护说明与 GPT 故事提示词

## 本地运行

要求 Node.js 22+、npm 10+。

```bash
npm install
cp .env.example .env
npm run dev
```

浏览器打开 `http://localhost:5173`。Vite 将 `/api` 代理到 `http://localhost:3000`。默认 `PROVIDER_MODE=mock`，不需要密钥。移动设备直接访问非 localhost 地址时，相机 API 需要 HTTPS；不能开启相机时仍可使用相册选择。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | API 监听端口 |
| `PROVIDER_MODE` | `mock` | `mock` 可直接演示；`real` 使用 Azure Face 与 Foundry GPT-5.6 |
| `MATCH_THRESHOLD` | `0.6` | 服务端匹配阈值，允许 0.50～0.99 |
| `ALLOWED_ORIGIN` | `http://localhost:5173` | 允许的前端来源 |
| `AZURE_SPEECH_ENDPOINT` | 未设置 | Azure Speech 自定义终结点；与 Resource ID 同时配置 |
| `AZURE_SPEECH_RESOURCE_ID` | 未设置 | Speech 资源的完整 Azure Resource ID |
| `AZURE_SPEECH_VOICE` | `zh-CN-XiaoxiaoNeural` | 中文神经语音 |
| `AZURE_SPEECH_STYLE` | `affectionate` | Azure 情感朗读样式 |

Azure Face、Microsoft Foundry 与 Speech 都只使用 `DefaultAzureCredential`/Managed Identity，不支持 API key；相关配置不能带 `VITE_` 前缀或写入前端。Speech 可独立启用，调用身份必须在目标资源上拥有 `Cognitive Services Speech User` 或 `Cognitive Services Speech Contributor` 角色。`.env.example` 列出了 Face v1.2、GPT-5.6 Sol、Speech、60 秒 faceId TTL 和阈值配置。

## 人物库准备

人物元数据位于 `apps/server/src/people.json`，图片位于服务端私有目录 `apps/server/src/assets/people/`，仅在成功匹配后通过短时授权端点读取。两者都不入版本库，只存在于部署机上；全新 clone 会自动回落到提交在仓库里的演示种子 `apps/server/src/seed/`（自制占位 SVG，非真实人物），因此无需真实资料即可构建、测试和以 mock 模式运行。导入真实材料前必须取得可审计的用途授权、记录来源和删除期限，并由人工检查资料与授权一一对应。完整步骤见 `docs/people-library.md`。

## 测试与构建

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

测试覆盖 mock 三类 provider、授权/MIME 校验、阈值边界、无人脸/多人脸/低分/provider 异常、请求后缓冲清零，以及前端授权、预览、成功、错误和重置流程。

## 部署

构建后：

- `apps/web/dist` 是静态站点，可由 CDN 或静态服务器托管。
- `apps/server/dist` 是 Node.js API，运行 `npm start -w @photo-story/server`。
- 反向代理应以同一 HTTPS 域名把 `/api` 转发到服务端，并限制请求体不高于 6 MiB。

生产部署、安全头、CORS、密钥与健康检查详见 `docs/deployment.md`；接口契约见 `docs/api.md` 和 `specs/001-photo-story-mvp/contracts/openapi.yaml`；provider 替换和清理策略见 `docs/maintenance.md`。

## 隐私与内容边界

服务不创建上传目录、数据库记录、分析缓存或照片日志。Multer 使用内存存储，编排逻辑在 `finally` 中尽力清零 Buffer。浏览器对象 URL 在重拍、重新体验或组件卸载时撤销。JavaScript/操作系统仍可能短期管理内存副本，因此生产主机必须按敏感工作负载加固，禁止交换/崩溃转储泄露并配置最少日志。

严禁分析或推断健康、种族、民族、宗教、政治、性取向、残障、社会经济状况等敏感属性。真实 provider 的输出仍会通过允许类别过滤；上线前还需完成供应商数据处理与删除协议评审。
