# 数据模型

本 MVP 无持久化数据库；下列模型描述请求生命周期内的数据与受版本控制的人物元数据。已授权人物的人脸模板会按独立授权持久化在 Azure Face（southeastasia），通过删除模板/person 并重训撤回。

## 人物条目 `PersonEntry`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | 字符串 | 唯一、非空 | 内部示例标识 |
| `displayName` | 字符串 | 非空 | 达到阈值后显示的示例名称 |
| `photoId` | 字符串 | 必须引用 `LibraryPhoto.id` | 该人物所属照片 |
| `oldPhotoUrl` | 字符串 | `/api/people/:id/photo` | 短时 grant 保护的站内读取端点 |
| `authorization` | 枚举 | `placeholder` 或 `authorized` | 资源授权状态 |
| `sourceNote` | 字符串 | 非空 | 来源与用途记录 |
| `azurePersonId` | UUID 或 null | 不对外返回 | Azure LargePersonGroup person |

## 库照片 `LibraryPhoto`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | 字符串 | 唯一 | 照片内部标识 |
| `file` | 字符串 | 无路径分隔符 | 服务端私有文件 |
| `mimeType` | 枚举 | JPEG、PNG、WebP；占位可为 SVG | 文件类型 |
| `width` / `height` | 正整数或 null | 有 faceBox 时必填 | 入库脚本读取的像素尺寸 |
| `sourceNote` | 字符串 | 非空 | 不含个人信息的授权引用 |
| `members` | `PhotoMember[]` | 至少一项、personId 唯一 | 照片内获授权成员 |

## 照片成员 `PhotoMember`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `personId` | 字符串 | 引用 `PersonEntry.id`，双向一致 | 照片中的人物 |
| `faceBox` | 矩形或 null | 非负整数、正宽高、不得越界 | Azure Detect 返回的人脸框；旧格式为 null |
| `azurePersistedFaceId` | UUID 或 null | 不对外返回 | 撤回时删除的人脸模板 |

文件顶层为 `{ schemaVersion: 2, photos, people }`。读取器兼容旧人物数组，并按一人一照片升级。多人合影只在所有 `members` 对应人物均为 `authorized` 时可用于 real 模式；一人撤回会使整张照片下线。

## 匹配候选 `MatchCandidate`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `personId` | 字符串 | 必须存在于人物库 | provider 内部候选 |
| `score` | 数字 | 0～1 | 模拟或供应商归一化置信分数 |

## 匹配判定 `MatchDecision`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `matched` | 布尔 | 派生 | `score >= threshold` |
| `score` | 数字 | 0～1 | 最高候选分数 |
| `threshold` | 数字 | 0.50～0.99，默认 0.6 | 服务端阈值 |
| `confidence` | 枚举 | `high`、`medium`、`below_threshold` | 展示级别 |
| `person` | 对象或无 | 仅 `matched=true` 存在 | 防止低分身份泄露 |

状态转换：无人脸/多人脸直接成为领域错误；有候选且低于阈值成为 `MATCH_BELOW_THRESHOLD`，不生成差异或故事；达到阈值才进入后续处理。

## 可见差异 `VisibleDifference`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `category` | 枚举 | `hairstyle`、`clothing`、`expression`、`accessory` | 服务端允许列表 |
| `description` | 字符串 | 中文、客观、不含敏感推断 | 可见变化描述 |

## 虚构故事 `FictionStory`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `label` | 固定字符串 | `AI 创作/虚构` | 显著标识 |
| `title` | 字符串 | 中文 | 故事标题 |
| `content` | 字符串 | 中文、不得冒充事实 | 生成正文 |
| `disclaimer` | 固定含义字符串 | 非空 | 明确不是人物真实经历 |

## 体验请求与生命周期

`ExperienceRequest` 包含单张图片 Buffer、MIME、`consent=true` 和仅 mock 使用的 `demoCase`。Buffer 从 multipart 解析开始存在，经 provider 顺序使用；响应构造后在 `finally` 中清零并解除引用。不得进入持久化对象、缓存、错误详情或日志。

## 错误 `ApiError`

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | 稳定字符串 | 客户端状态映射依据 |
| `message` | 中文字符串 | 简洁标题 |
| `explanation` | 中文字符串 | 原因和下一步 |
| `retryable` | 布尔 | 是否适合用户重试 |
| `requestId` | 字符串 | 不含用户内容的排障标识 |
| `details` | 可选对象 | 仅安全数值，如分数和阈值 |
