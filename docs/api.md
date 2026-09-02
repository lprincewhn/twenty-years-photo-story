# 接口说明

接口基址为 `/api`。详细机器可读契约位于 `specs/001-photo-story-mvp/contracts/openapi.yaml`。

## 健康检查

`GET /api/health`

成功响应：

```json
{
  "status": "ok",
  "providerMode": "mock"
}
```

健康检查不返回密钥、人物库详情或内部错误。

## 创建照片故事体验

`POST /api/experience`，内容类型 `multipart/form-data`。

| 字段 | 必需 | 说明 |
|---|---|---|
| `photo` | 是 | JPEG、PNG 或 WebP 单张图片，最大 6 MiB |
| `consent` | 是 | 必须为字符串 `true`，表示本次明确授权 |
| `demoCase` | 否 | mock 演示：`success`、`no-face`、`multiple-faces`、`unmatched`、`provider-error` |

示例：

```bash
curl -X POST http://localhost:3000/api/experience \
  -F consent=true \
  -F demoCase=success \
  -F photo=@./已获授权的测试图片.jpg
```

成功响应包含请求标识、保留说明、匹配分数与阈值、人物示例、允许类别差异、带固定标签的虚构故事，以及 `narration` 中的音频 MIME、Base64 音频和 provider 标识。配置 Azure Speech 时音频为 MP3 情感朗读；未配置密钥的 mock 模式返回短 WAV 占位音频。现场照片本身不会出现在响应中。匹配成功时，服务端还会签发 5 分钟有效、绑定匹配人物的 `HttpOnly; Secure; SameSite=Strict` 授权 Cookie；前端无需读取该 Cookie。

## 读取匹配人物照片

`GET /api/people/:personId/photo`

仅完成成功匹配后可读取该次匹配人物的照片。请求必须携带服务端签发的短时 `ps_grant` Cookie；缺少、篡改、过期或绑定到其他人物的 grant 均返回 `403`。响应使用 `Cache-Control: private, no-store`，SVG 还带有 `Content-Security-Policy: default-src 'none'`，不得由 CDN 缓存。

## 错误格式

```json
{
  "error": {
    "code": "MATCH_BELOW_THRESHOLD",
    "message": "未找到足够可信的匹配",
    "explanation": "本次分数低于阈值，因此不会给出人物结论。",
    "retryable": true,
    "requestId": "仅用于排障的随机标识",
    "details": {
      "score": 0.61,
      "threshold": 0.82
    }
  }
}
```

| HTTP | 错误码 | 含义 |
|---|---|---|
| 400 | `CONSENT_REQUIRED` | 没有本次显式授权 |
| 400 | `PHOTO_REQUIRED` | 未提交照片 |
| 400 | `INVALID_IMAGE` | MIME 不受支持 |
| 400 | `INVALID_REQUEST` | multipart 字段过多或无效 |
| 413 | `PHOTO_TOO_LARGE` | 超过 6 MiB |
| 422 | `NO_FACE` | 没有清晰单人脸 |
| 422 | `MULTIPLE_FACES` | 检测到多张人脸 |
| 422 | `MATCH_BELOW_THRESHOLD` | 分数低于阈值，不返回人物结论 |
| 403 | `PHOTO_GRANT_REQUIRED` | 缺少、无效、过期或人物不匹配的照片授权 |
| 404 | `PERSON_PHOTO_NOT_FOUND` | 人物或已登记照片不存在 |
| 429 | `RATE_LIMITED` | 请求过于频繁 |
| 502 | `PROVIDER_UNAVAILABLE` | provider 失败或返回不可信结果 |
| 500 | `INTERNAL_ERROR` | 未预期服务错误 |

客户端应根据 `retryable` 决定是否展示“再次提交”，但始终允许重新拍摄。排障只记录 `requestId`、错误码、状态码和耗时，不得记录图片、特征、人物候选或生成输入。

## 保留和安全

请求由带清零语义的 Multer 内存存储解析，单次最多一张图。服务在响应构造后的 `finally` 和 Multer 错误清理路径中清零可控 Buffer，不写磁盘、数据库或缓存。生产环境必须使用 HTTPS、限制来源、设置反向代理请求体上限和速率限制。
