# 维护与真实 provider 接入

## provider 接口

接口位于 `apps/server/src/providers/types.ts`：

- `FaceMatchProvider.match(photo)`：返回人脸数量和候选 `personId`/分数，不直接决定身份结论。
- `DifferenceProvider.analyze(photo, personId)`：只返回发型、服饰、表情、配饰枚举及客观描述。
- `StoryProvider.generate(displayName, differences)`：返回固定 AI 标签、标题、正文和免责声明。
- `NarrationProvider.synthesize(text)`：把故事标题和正文合成为浏览器可播放音频。

`apps/server/src/providers/index.ts` 是唯一选择入口。默认 `mock` 无密钥可运行；配置 Azure Speech 密钥和区域后，朗读 provider 独立切换为 Azure 情感语音。`real` 在没有明确分析适配器时会拒绝启动，避免误把 mock 当成真实分析。

## 新增真实适配器

1. 在 `providers/real/` 分别实现三个接口，不改变路由。
2. 只从服务端环境读取 URL、密钥和模型名；禁止导出到 `VITE_*`。
3. 每个外部请求设置连接/总超时、最大响应大小和取消信号。
4. 将供应商分数归一化到 0～1，但由 `app.ts` 使用 `MATCH_THRESHOLD` 再次判断。
5. 供应商无人脸/多人脸映射为对应领域状态；超时和无效响应映射为 `PROVIDER_UNAVAILABLE`，应用限流映射为 `RATE_LIMITED`。
6. 差异输出先在适配器校验，编排层仍执行四类别允许列表过滤。提示词和后处理共同禁止敏感推断。
7. 故事适配器强制覆盖 `label` 与 `disclaimer`，不信任供应商自由文本中的标签。
8. 为适配器添加契约测试：成功、超时、无效 JSON、错误分数、敏感类别、供应商限流和取消。
9. 在 `createProviders` 中仅当全部服务配置有效时返回真实 provider；不允许部分静默回退 mock。

## 阈值维护

0.82 是 MVP 演示默认值，不是通用生物识别保证。真实上线前应使用已授权、符合目标场景且不包含敏感标签的评估集，分别记录误匹配和漏匹配。阈值变更必须有评估报告、审批、回滚值与测试，界面始终显示当前阈值。分数低于阈值时响应不得含人物名称、ID、旧照或故事。

## 数据生命周期

当前数据流：

1. 浏览器得到明确授权后取得 `File`；预览使用对象 URL。
2. 用户确认后通过 HTTPS 上传单张图。
3. Multer 在内存创建 Buffer，三个 provider 在同一请求生命周期使用。
4. 响应构造或出错后，`finally` 调用 `fill(0)`，再由运行时回收。
5. 浏览器重拍、重置或卸载时撤销对象 URL。

应用不配置磁盘上传、数据库、队列、结果缓存或内容日志。若将来需要异步处理，必须先完成隐私影响评估、明确最短保留期限、加密、自动删除和用户撤回接口，并重新取得授权。

## 自动清理与观测

- 应用层：每次请求立即清零上传 Buffer，不等待定时任务。
- 基础设施：临时容器/进程不挂载持久卷；崩溃转储和 APM 请求体采集关闭。
- 指标只包含计数、延迟、错误码、provider 名称和随机请求标识。
- 日志不得包含文件名、MIME 之外的元数据、照片字节/摘要、人脸特征、候选列表、人物名、差异正文或故事输入。

## 例行检查

每次依赖或 provider 变更运行：

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

每季度复核人物授权是否到期、供应商删除条款、密钥轮换、阈值评估和错误文案。依赖安全升级不得跳过 provider 与核心前端流程测试。
