# 实施任务：“二十年前与现在”照片故事 MVP

## 阶段一：规范与基础

- [x] T001 更新 `.specify/memory/constitution.md`，明确中文、隐私、授权、安全推断、AI、测试和可访问性原则
- [x] T002 编写 `spec.md` 用户故事、需求、边界与成功标准
- [x] T003 编写 `research.md`、`data-model.md`、`contracts/openapi.yaml`、`quickstart.md`
- [x] T004 建立 npm workspaces、TypeScript、ESLint、Vitest 与忽略规则

## 阶段二：测试先行的服务端

- [x] T005 [P] 为 mock 三类 provider 编写成功与领域失败测试
- [x] T006 [P] 为 API 授权、MIME、阈值等于/低于边界、无人脸、多人脸、上游异常和内存清零编写测试
- [x] T007 定义 `FaceMatchProvider`、`DifferenceProvider`、`StoryProvider` 和领域类型
- [x] T008 实现 mock provider、示例人物库和 provider 工厂
- [x] T009 实现 Express 编排、Multer 内存限制、差异允许列表、结构化错误和健康检查
- [x] T010 在 `finally` 中清零图片 Buffer，确保日志和响应不包含照片/特征

## 阶段三：测试先行的移动 H5

- [x] T011 [P] 为未授权阻断、文件预览、确认成功、错误显示和重新体验编写组件测试
- [x] T012 实现授权、相机、文件回退、预览、重拍、确认和上传状态
- [x] T013 实现成功结果：旧照/新照、置信度、阈值、可见差异和虚构故事
- [x] T014 实现相机拒绝、无效图片、无人脸、多人脸、未匹配、网络与 provider 错误中文状态
- [x] T015 完成语义结构、状态播报、焦点管理、触控尺寸、对比度和减少动画样式

## 阶段四：数据、文档与交付

- [x] T016 添加自制 SVG 占位人物资源与带授权状态的 JSON 元数据
- [x] T017 编写中文 README、人物库导入、API、部署和维护文档
- [x] T018 更新 `.env.example`，只提供无密钥示例和真实 provider 适配占位变量
- [x] T019 执行 lint、类型检查、测试和构建并修复全部问题
- [x] T020 检查无密钥、无未授权照片、无构建产物，形成可审阅提交与 PR

## 依赖与并行说明

- T001～T004 是后续实现基础。
- 服务端 T005/T006 可并行，完成后推进 T007～T010。
- 前端测试 T011 与服务端 provider 实现可并行；T012～T015 依赖稳定 API 契约。
- T016 可与界面实现并行；文档和最终质量门在行为稳定后完成。

## 验收命令

```bash
npm run lint
npm run typecheck
npm test
npm run build
git status --short
```

