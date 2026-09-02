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
HOST=127.0.0.1
PORT=3000
PROVIDER_MODE=mock
MATCH_THRESHOLD=0.82
ALLOWED_ORIGIN=https://photo.example.com
PEOPLE_ASSET_SECRET=使用秘密管理生成并注入的至少32字符随机值
GRANT_TTL_SECONDS=300
AZURE_SPEECH_KEY=通过秘密管理注入
AZURE_SPEECH_REGION=chinaeast2
AZURE_SPEECH_VOICE=zh-CN-XiaoxiaoNeural
AZURE_SPEECH_STYLE=affectionate
```

演示环境可使用 mock。Azure Speech 可独立接入：`AZURE_SPEECH_KEY` 与 `AZURE_SPEECH_REGION` 必须同时设置，否则启动配置校验失败；未设置时使用 mock 占位音频。生产真实分析能力上线前必须实现并评审三个分析 provider 适配器，再把 `PROVIDER_MODE` 改为 `real`。密钥通过云秘密管理注入，仅服务端进程可读；不得写入镜像、构建参数、静态资源或日志。

## 反向代理要求

- 强制 TLS 1.2+ 和 HTTPS 重定向；相机 API 在非安全上下文不可用。
- `/api/experience` 请求体上限设置为 6 MiB，超时应略大于 provider 总超时。
- 不得暴露或代理旧的 `/people/` 静态路径；`/api/people/*/photo` 必须转发到 Node 服务，禁止在反向代理或 CDN 缓存。
- 保留 `X-Request-ID` 或由应用生成；访问日志不记录请求体、multipart 字段或查询内容。
- 当前应用按单层反向代理配置 `trust proxy = 1`；若部署拓扑增加代理层级，必须同步调整并验证真实客户端 IP。
- 增加 HSTS、CSP、`frame-ancestors`、`Permissions-Policy: camera=(self)` 等安全头。
- 应用已有每分钟 30 次的进程内限制；多副本生产环境应在网关增加统一匿名速率限制。
- 多副本必须共享同一个 `PEOPLE_ASSET_SECRET`，否则在一个副本签发的照片 grant 无法由另一个副本验证。未配置时生成的临时密钥仅适用于单实例演示。

## 隐私加固

- 不挂载上传卷，不创建照片缓存目录。
- 禁用包含进程内存的自动崩溃转储；评估交换空间和 APM 请求体采集。
- APM、WAF、反向代理均禁用请求/响应体采样。
- 真实供应商必须承诺不训练、最短保留与可验证删除，并限定处理地域。
- 只保留匿名运行指标；任何新增持久化必须重新取得用户授权并更新文档。

## photo.svhw.tech 自动部署

服务器的一次性 systemd、Nginx 和 Let's Encrypt 配置不由发布脚本修改。
完成服务器初始化后，仓库内的 `scripts/deploy.sh` 只负责构建两个 workspace、
把前端静态文件原子发布到 `/var/www/photo-story/current`、重启
`photo-story.service`，以及检查本机后端和公网 HTTPS 端点。

```bash
npm run deploy
```

后端固定由服务器上的 systemd 配置监听 `127.0.0.1:3001`，Nginx 托管前端
并将 `https://photo.svhw.tech/api/*` 代理到该端口。服务端 provider 配置位于
`/etc/photo-story.env`；发布脚本不会创建或修改该文件。

## 发布验证

```bash
curl -fsS https://photo.example.com/api/health
curl -I https://photo.example.com/
```

随后在真实移动设备检查显式授权、相机权限拒绝回退、上传成功、低分不下结论、AI 标识、屏幕阅读器状态播报和重新体验清理。若 provider 失败，界面必须返回可解释错误，不能静默伪造成功。

## 回滚

静态站与 API 使用可追踪版本镜像。回滚时同时回退前端与 API 契约兼容版本；本 MVP 无数据库迁移。发生疑似照片泄露时应立即停止入口、关闭可能采集请求体的日志/APM、轮换 provider 密钥并按事件响应流程通知负责人。
