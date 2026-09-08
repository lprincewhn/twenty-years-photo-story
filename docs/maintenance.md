# 维护与真实 provider 接入

## provider 接口

接口位于 `apps/server/src/providers/types.ts`：

- `FaceMatchProvider.match(photo)`：返回人脸数量和候选 `personId`/分数，不直接决定身份结论。
- `DifferenceProvider.analyze(photo, referencePhoto)`：比较当前照片与人物库旧照，只返回发型、服饰、表情、配饰、眼神枚举及客观描述。
- `StoryProvider.generate(differences, signal, referencePhoto)`：真实模式根据匹配旧照识别场景并结合差异生成故事，返回固定 AI 标签、标题、正文和免责声明；mock 不需要旧照。
- `NarrationProvider.synthesize(text)`：把故事标题和正文合成为浏览器可播放音频。

`apps/server/src/providers/index.ts` 是唯一选择入口。默认 `mock` 无密钥可运行。`real` 使用 Azure Face adapter 与共用 GPT-5.6 Sol deployment 的两个 Foundry adapter；任一真实 provider 失败都不会回落到 mock。配置 Azure Speech 自定义终结点和完整 Resource ID 后，朗读 provider 可独立切换为 Azure 情感语音，并通过 `DefaultAzureCredential` 使用 Entra ID。

## Azure Face adapter

- API 固定为 `face/v1.2`，LargePersonGroup 固定使用 `recognition_04`，Detect 固定使用 `detection_03`。
- 认证仅使用 `DefaultAzureCredential`。生产和入库统一给 Managed Identity **Cognitive Services Face Contributor**；本地 `az login` 身份也需同一数据面角色。不支持 API key。
- 启动依次读取 group 与 training 状态，校验模型和 `succeeded`。RBAC 传播期的 401/`PermissionDenied` 重试 5 次、间隔 6 秒；其他配置或 Limited Access 错误立即失败。
- Detect 与 Identify 分别有 8 秒默认超时。Detect 显式使用 `faceIdTimeToLive=60`；不记录 faceId、Azure personId、候选或图片内容。
- Identify 每次最多 10 个 faceId，Azure `confidenceThreshold` 默认 0.5，仅作粗筛；业务结论只由 `app.ts` 的阈值作出。
- 应用层验证全部候选分数后，从严格高于 `MATCH_THRESHOLD` 的候选中均匀随机选择；没有候选超过阈值时不返回人物结论。
- `InvalidImage` 映射为 `INVALID_IMAGE`，限流/配额映射为 `RATE_LIMITED`；未训练、网络、超时映射为可重试的 `PROVIDER_UNAVAILABLE`；权限、参数、容器漂移及 `innererror.code=UnsupportedFeature` 映射为不可重试的 `PROVIDER_UNAVAILABLE`。
- Azure 返回无法映射到 `people.json` 的 personId 属于库漂移，必须报错，不能丢弃候选。

## Microsoft Foundry adapter

- 差异与故事接口共用一个 GPT-5.6 Sol deployment，但保留两个独立 provider 类和 JSON Schema；故事正文最多 500 字。
- 使用 `DefaultAzureCredential` 和 `https://cognitiveservices.azure.com/.default`，生产身份需有 `Cognitive Services OpenAI User`；不接受 API key。
- 差异分析只向模型发送人物库旧照和本次上传照片，提示词禁止推断年龄、种族、健康、宗教、身份和真实经历。响应还会经过严格 schema 与四类别白名单两层校验。
- 故事接收已过滤差异与匹配人物的完整已授权旧照，不向模型发送当前照片或人物展示名。核心场景由模型识别旧照背景，不再属于随机创意坐标；背景无法辨认时不得猜测具体场景。正文必须使用第二人称并明确体现二十年跨度。应用层无条件覆盖 `label` 与 `disclaimer`，不信任模型自行声明。
- 默认总超时 60 秒，客户端取消会向下游传播；429 映射为 `RATE_LIMITED`，网络、超时、无效 JSON 和服务错误映射为 `PROVIDER_UNAVAILABLE`。
- 每次 Foundry 调用输出结构化的 `foundry.request` / `foundry.response` 生命周期日志，包含随机交互标识、schema、deployment、脱敏后的提示词、消息角色、图片 MIME、HTTP 状态、耗时、响应字节数和错误码。
- Foundry 提示词日志保留静态指令和非敏感创意坐标；图片替换为 MIME 脱敏标记，故事输入中的可见差异仅保留条数，不记录模型响应正文。请求结束后，上传照片与从私有人物库读取的旧照 Buffer 都会清零。经校验和规范化后的故事由下述应用级日志单独记录。

## 故事与匹配照片优化日志

按 SVHWB-65 的优化需求，mock / real 模式在故事生成后、朗读合成前输出一条 `[experience]` 前缀的单行 JSON，事件名为 `experience.story_generated`。可按 API 返回的 `requestId` 查找同次体验：

- `story.title` / `story.content`：与 API 响应及朗读使用的文本完全一致。
- `match.personId` / `photoId` / `photoPath`：已选人物和旧照的本地库标识、相对 assets 文件名，不是 Azure 人脸标识或服务器绝对路径。
- `match.score` / `threshold` / `summary`：已选人物分数、阈值及与结果页相同的六项照片统计；已选照片不一定是最高分照片。
- `normalization.titleChanged` / `contentChanged`：是否移除了末尾未配对的大括号，用于定位模型文本格式问题；不记录清理前的原始响应。

该事件表示故事已生成，不代表整个请求成功；即使随后朗读失败也保留它。未匹配、未授权或故事生成失败不会输出此事件。JSON 编码会转义文本换行，避免一条故事被拆成多条日志。

这是对原先“不记录故事内容及旧照文件名”的明确例外，授权页已说明优化用途。日志可能含照片的文字描述，必须按受限内容管理：仅授权维护人员可访问，不接入公开日志面板或第三方分析，不用于训练；部署时配置最短必要的保留期（建议不超过 7 天）和自动过期，撤回时按 `requestId` 定位并删除对应日志。应用只写标准输出，不自行保存或删除日志文件，实际留存与访问控制由部署环境负责。仍禁止记录现场图片、上传文件名、base64、照片摘要、人脸特征/坐标、Azure personId/faceId、候选明细、人物展示名、原始差异输入、Cookie 或令牌。

## 阈值维护

0.6 是基于小规模实测选定的默认值，不是通用生物识别保证。真实上线前应使用已授权、包含“二十年前后”变化且不包含敏感标签的评估集，分别记录误匹配和漏匹配。阈值变更必须有评估报告、审批、回滚值与测试，界面始终显示当前阈值。`AZURE_FACE_IDENTIFY_THRESHOLD` 必须严格低于它，分数低于业务阈值时响应不得含人物名称、ID、旧照或故事。

## 人物库运维

多人物照片通过可重复 `--member <personId>:<displayName>:<faceIndex>` 登记。脚本先 Detect，只接受 `qualityForRecognition` 为 `high` 或 `medium` 的索引，并检查边界、单中心点、覆盖率和跨脸重叠；不允许手输未经 Detect 的坐标。Create Person、Add Face、Train 完成后，脚本重新 Detect 并按每批最多 10 张脸 Identify，只有所有 Top-1 都与登记成员一致才写本地元数据；失败会清理本轮新建 person 并重训。

`sync` 以本地 v2 `people.json` 和私有照片为准重建 Azure person/face、训练并自检，用于灾恢和漂移修复。模型升级不能就地混用：先评审并重建容器，再全量 sync。

撤回执行 `people delete`：先删 persistedFace、再删 person、随后 Train 并等待成功；未重训时 Identify 仍可能命中旧模板，因此训练失败必须按失败处理并立即运行 `sync`。共享合影仅在最后一名成员删除后才移除文件；任一成员不再是 `authorized` 时，real 模式整张照片停止匹配和投放。Azure 模板保留期限及撤回后 30 天删除承诺由受控授权系统跟踪。

## 数据生命周期

当前数据流：

1. 浏览器得到明确授权后取得 `File`；预览使用对象 URL。
2. 用户确认后通过 HTTPS 上传单张图。
3. Multer 在内存创建上传 Buffer；匹配成功且确认旧照全员授权后读取人物库旧照，人物裁剪图与上传照片发送给 Foundry 做可见差异分析，完整旧照在故事请求中用于识别背景场景。
4. 差异调用完成后立即清零人物裁剪 Buffer；完整旧照在故事调用期间保持可用，响应构造或出错后与上传 Buffer 一并清零，再由运行时回收。旧照和多模态文本中的差异均不会写入日志。
5. 浏览器重拍、重置或卸载时撤销对象 URL。

现场上传不配置磁盘、数据库、队列、结果缓存或图片内容日志；故事文本及旧照匹配信息仅按上述优化日志规则记录。Azure Detect 的临时 faceId TTL 为 60 秒。人物库的 persisted face 属于另行明确授权的持久数据，存于 Azure southeastasia，并由上述删除 + 重训流程管理。若将来需要异步处理现场照片，必须先完成隐私影响评估、明确最短保留期限、加密、自动删除和用户撤回接口，并重新取得授权。

## 自动清理与观测

- 应用层：每次请求立即清零上传 Buffer，不等待定时任务。
- 基础设施：临时容器/进程不挂载持久卷；崩溃转储和 APM 请求体采集关闭。
- 指标与模型交互日志只包含计数、延迟、HTTP 状态、错误码、provider/schema/deployment、消息角色、图片 MIME、响应字节数和随机交互标识。
- 除 `experience.story_generated` 的明确字段白名单外，日志不得包含文件名、MIME 之外的元数据、照片字节/摘要、人脸特征、候选列表、人物名、差异正文或故事输入；不得通过序列化整个请求/provider 输出扩展白名单。

## 例行检查

每次依赖或 provider 变更运行：

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

每季度复核人物授权是否到期、Azure 模板与本地库是否一致、托管身份角色、供应商删除条款、阈值评估和错误文案。依赖安全升级不得跳过 provider 与核心前端流程测试。
