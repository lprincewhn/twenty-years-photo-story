# 维护与真实 provider 接入

## provider 接口

接口位于 `apps/server/src/providers/types.ts`：

- `FaceMatchProvider.match(photo)`：返回人脸数量和候选 `personId`/分数，不直接决定身份结论。
- `DifferenceProvider.analyze(photo, personId)`：只返回发型、服饰、表情、配饰枚举及客观描述。
- `StoryProvider.generate(displayName, differences)`：返回固定 AI 标签、标题、正文和免责声明。

`apps/server/src/providers/index.ts` 是唯一选择入口。默认 `mock` 无密钥可运行。`real` 使用 Azure Face adapter；差异与故事尚无真实 adapter，会明确失败，避免误把 mock 结果当成真实分析。

## Azure Face adapter

- API 固定为 `face/v1.2`，LargePersonGroup 固定使用 `recognition_04`，Detect 固定使用 `detection_03`。
- 认证仅使用 `DefaultAzureCredential`。生产和入库统一给 Managed Identity **Cognitive Services Face Contributor**；本地 `az login` 身份也需同一数据面角色。不支持 API key。
- 启动依次读取 group 与 training 状态，校验模型和 `succeeded`。RBAC 传播期的 401/`PermissionDenied` 重试 5 次、间隔 6 秒；其他配置或 Limited Access 错误立即失败。
- Detect 与 Identify 分别有 8 秒默认超时。Detect 显式使用 `faceIdTimeToLive=60`；不记录 faceId、Azure personId、候选或图片内容。
- Identify 每次最多 10 个 faceId，Azure `confidenceThreshold` 默认 0.5，仅作粗筛；业务结论只由 `app.ts` 的阈值作出。
- `InvalidImage` 映射为 `INVALID_IMAGE`，限流/配额映射为 `RATE_LIMITED`；未训练、网络、超时映射为可重试的 `PROVIDER_UNAVAILABLE`；权限、参数、容器漂移及 `innererror.code=UnsupportedFeature` 映射为不可重试的 `PROVIDER_UNAVAILABLE`。
- Azure 返回无法映射到 `people.json` 的 personId 属于库漂移，必须报错，不能丢弃候选。

## 后续真实适配器清单

1. 在 provider 边界分别实现差异与故事接口，不改变路由。
2. 只从服务端环境读取 URL、凭据和模型名；禁止导出到 `VITE_*`。
3. 每个外部请求设置连接/总超时、最大响应大小和取消信号。
4. 将供应商分数归一化到 0～1，但由 `app.ts` 使用 `MATCH_THRESHOLD` 再次判断。
5. 供应商无人脸/多人脸映射为对应领域状态；超时和无效响应映射为 `PROVIDER_UNAVAILABLE`，应用限流映射为 `RATE_LIMITED`。
6. 差异输出先在适配器校验，编排层仍执行四类别允许列表过滤。提示词和后处理共同禁止敏感推断。
7. 故事适配器强制覆盖 `label` 与 `disclaimer`，不信任供应商自由文本中的标签。
8. 为适配器添加契约测试：成功、超时、无效 JSON、错误分数、敏感类别、供应商限流和取消。
9. 在 `createProviders` 中仅返回明确配置的真实 provider；不允许任何部分静默回退 mock。

## 阈值维护

0.6 是基于小规模实测选定的默认值，不是通用生物识别保证。真实上线前应使用已授权、包含“二十年前后”变化且不包含敏感标签的评估集，分别记录误匹配和漏匹配。阈值变更必须有评估报告、审批、回滚值与测试，界面始终显示当前阈值。`AZURE_FACE_IDENTIFY_THRESHOLD` 必须严格低于它，分数低于业务阈值时响应不得含人物名称、ID、旧照或故事。

## 人物库运维

多人物照片通过可重复 `--member <personId>:<displayName>:<faceIndex>` 登记。脚本先 Detect，只接受 `qualityForRecognition=high` 的索引，并检查边界、单中心点、覆盖率和跨脸重叠；不允许手输未经 Detect 的坐标。Create Person、Add Face、Train 完成后，脚本重新 Detect 并按每批最多 10 张脸 Identify，只有所有 Top-1 都与登记成员一致才写本地元数据；失败会清理本轮新建 person 并重训。

`sync` 以本地 v2 `people.json` 和私有照片为准重建 Azure person/face、训练并自检，用于灾恢和漂移修复。模型升级不能就地混用：先评审并重建容器，再全量 sync。

撤回执行 `people delete`：先删 persistedFace、再删 person、随后 Train 并等待成功；未重训时 Identify 仍可能命中旧模板，因此训练失败必须按失败处理并立即运行 `sync`。共享合影仅在最后一名成员删除后才移除文件；任一成员不再是 `authorized` 时，real 模式整张照片停止匹配和投放。Azure 模板保留期限及撤回后 30 天删除承诺由受控授权系统跟踪。

## 数据生命周期

当前数据流：

1. 浏览器得到明确授权后取得 `File`；预览使用对象 URL。
2. 用户确认后通过 HTTPS 上传单张图。
3. Multer 在内存创建 Buffer，三个 provider 在同一请求生命周期使用。
4. 响应构造或出错后，`finally` 调用 `fill(0)`，再由运行时回收。
5. 浏览器重拍、重置或卸载时撤销对象 URL。

现场上传不配置磁盘、数据库、队列、结果缓存或内容日志。Azure Detect 的临时 faceId TTL 为 60 秒。人物库的 persisted face 属于另行明确授权的持久数据，存于 Azure southeastasia，并由上述删除 + 重训流程管理。若将来需要异步处理现场照片，必须先完成隐私影响评估、明确最短保留期限、加密、自动删除和用户撤回接口，并重新取得授权。

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

每季度复核人物授权是否到期、Azure 模板与本地库是否一致、托管身份角色、供应商删除条款、阈值评估和错误文案。依赖安全升级不得跳过 provider 与核心前端流程测试。
