# 实施计划：“二十年前与现在”照片故事 MVP

**分支**：`feature/SVHW-16-photo-story-mvp` | **日期**：2026-08-29 | **规范**：`spec.md`

## 摘要

使用 npm workspaces 管理 React/Vite 前端与 Express 服务端。浏览器负责明确授权、拍摄/文件回退和本地预览；服务端用 Multer 内存存储接收单张图片，经三个可替换 provider 完成匹配、差异和故事生成。默认 mock 不需要密钥。API 只返回结果，不返回或保存现场照片，并在 `finally` 中清零上传缓冲区。

## 技术上下文

- **语言/运行时**：TypeScript 5、Node.js 22
- **前端**：React 19、Vite 7、原生 CSS、浏览器 MediaDevices API
- **服务端**：Express 5、Multer 内存存储、Zod 配置校验
- **测试**：Vitest、Testing Library、Supertest
- **质量**：ESLint、TypeScript project references、Vite/tsc 构建
- **存储**：无；人物库是受版本控制的 JSON 元数据和自制 SVG
- **接口**：`POST /api/experience` multipart；`GET /api/health`

## 章程检查

| 原则 | 设计响应 | 状态 |
|---|---|---|
| 中文文档 | 所有项目文档、测试说明、部署与 API 说明均中文 | 通过 |
| 隐私与最小化 | 内存上传、不落盘、不打照片日志、请求结束清零缓冲 | 通过 |
| 显式授权 | 前端未预选复选框；API 二次校验 `consent=true` | 通过 |
| 安全推断 | 差异类别允许列表；低分不返回人物 | 通过 |
| 可信 AI | 结构化固定标签和免责声明，UI 显著展示 | 通过 |
| 测试先行 | provider、API、流程状态均有自动化测试 | 通过 |
| 移动端可访问 | 语义结构、状态播报、焦点、触控尺寸、回退输入 | 通过 |

## 项目结构

```text
apps/
├── server/
│   ├── src/
│   │   ├── app.ts
│   │   ├── assets/people/
│   │   ├── config.ts
│   │   ├── errors.ts
│   │   ├── people.json
│   │   ├── providers/
│   │   └── server.ts
│   └── test/
└── web/
    ├── src/
    │   ├── api.ts
    │   ├── App.tsx
    │   ├── camera.ts
    │   └── styles.css
    └── test/
docs/
├── api.md
├── deployment.md
├── maintenance.md
└── people-library.md
specs/001-photo-story-mvp/
├── checklists/requirements.md
├── contracts/openapi.yaml
├── data-model.md
├── plan.md
├── quickstart.md
├── research.md
├── spec.md
└── tasks.md
```

## 关键设计

1. **单端点编排**：MVP 中三个 provider 顺序调用，减少浏览器状态和临时数据存活时间。
2. **依赖注入**：`createApp` 接受 provider 集合，测试可注入边界和异常行为，未来真实适配器无需改路由。
3. **双重阈值保护**：provider 返回候选分数，编排层按服务端阈值决定是否返回人物，真实 provider 不能绕过。
4. **差异过滤**：编排层只保留 `hairstyle`、`clothing`、`expression`、`accessory`，即使 provider 越界也不会下发。
5. **错误归一化**：领域错误映射为稳定 HTTP 状态和中文解释；未知 provider 错误统一为可重试 502。
6. **演示场景**：开发界面可向 mock 发送明确 `demoCase`；真实 provider 模式忽略该字段。
7. **部署模式**：开发时 Vite 代理 `/api`；生产可分别部署静态站与 Node 服务，或由反向代理统一域名。

## 实施阶段

1. 固化章程、规范、研究、数据模型、接口契约和验收清单。
2. 建立 workspaces、质量配置和失败测试。
3. 实现 provider、编排 API、内存释放与示例人物库。
4. 实现移动端状态机、相机回退、预览和结果/错误页面。
5. 完成中文 README、API、部署、人物库及维护文档。
6. 执行完整质量门，修复后形成实现提交和 PR。

## 风险与控制

- **mock 被误解为真实识别**：界面与 README 明确“流程模拟”，结果标记示例。
- **浏览器相机兼容性**：文件输入始终可用，相机错误不阻断流程。
- **图片内存压力**：6 MiB 限制、单文件、请求结束清零、生产反向代理限流。
- **真实 provider 输出敏感内容**：适配器校验加允许列表过滤；契约测试覆盖越界输出。
- **对象 URL 泄漏**：重拍、重新体验和组件卸载时统一 revoke。
