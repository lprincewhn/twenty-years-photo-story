# 部署指南

## 构建

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

构建产物为 `apps/web/dist` 与 `apps/server/dist`，不得提交到 Git。

## 推荐拓扑

1. CDN/静态服务器托管 `apps/web/dist`。
2. Node.js 22 容器或进程运行 `npm start -w @photo-story/server`。
3. HTTPS 反向代理将同域 `/api/*` 转发到服务端。
4. `GET /api/health` 用作存活检查。

同域部署可减少跨域配置。若必须跨域，将 `ALLOWED_ORIGIN` 设置为唯一受信前端 HTTPS 来源，不使用通配符。

## 服务端环境

```text
NODE_ENV=production
PORT=3000
PROVIDER_MODE=mock
MATCH_THRESHOLD=0.82
ALLOWED_ORIGIN=https://photo.example.com
```

演示环境可使用 mock。生产真实能力上线前必须实现并评审三个 provider 适配器，再把 `PROVIDER_MODE` 改为 `real`。密钥通过云秘密管理注入，仅服务端进程可读；不得写入镜像、构建参数、静态资源或日志。

## 反向代理要求

- 强制 TLS 1.2+ 和 HTTPS 重定向；相机 API 在非安全上下文不可用。
- `/api/experience` 请求体上限设置为 6 MiB，超时应略大于 provider 总超时。
- 保留 `X-Request-ID` 或由应用生成；访问日志不记录请求体、multipart 字段或查询内容。
- 当前应用按单层反向代理配置 `trust proxy = 1`；若部署拓扑增加代理层级，必须同步调整并验证真实客户端 IP。
- 增加 HSTS、CSP、`frame-ancestors`、`Permissions-Policy: camera=(self)` 等安全头。
- 应用已有每分钟 30 次的进程内限制；多副本生产环境应在网关增加统一匿名速率限制。

## 隐私加固

- 不挂载上传卷，不创建照片缓存目录。
- 禁用包含进程内存的自动崩溃转储；评估交换空间和 APM 请求体采集。
- APM、WAF、反向代理均禁用请求/响应体采样。
- 真实供应商必须承诺不训练、最短保留与可验证删除，并限定处理地域。
- 只保留匿名运行指标；任何新增持久化必须重新取得用户授权并更新文档。

## 发布验证

```bash
curl -fsS https://photo.example.com/api/health
curl -I https://photo.example.com/
```

随后在真实移动设备检查显式授权、相机权限拒绝回退、上传成功、低分不下结论、AI 标识、屏幕阅读器状态播报和重新体验清理。若 provider 失败，界面必须返回可解释错误，不能静默伪造成功。

## 回滚

静态站与 API 使用可追踪版本镜像。回滚时同时回退前端与 API 契约兼容版本；本 MVP 无数据库迁移。发生疑似照片泄露时应立即停止入口、关闭可能采集请求体的日志/APM、轮换 provider 密钥并按事件响应流程通知负责人。
