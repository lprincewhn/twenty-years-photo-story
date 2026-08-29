# 快速开始

## 前置条件

- Node.js 22 或更高版本
- npm 10 或更高版本

## 本地运行

```bash
npm install
cp .env.example .env
npm run dev
```

打开终端显示的 Vite 地址（通常为 `http://localhost:5173`）。开发服务器把 `/api` 代理到 `http://localhost:3000`。默认 `PROVIDER_MODE=mock`，无需任何密钥。

移动设备测试相机时，除本机 `localhost` 外必须使用 HTTPS。若相机不可用，可以直接使用“从相册选择”完成体验。

## 演示检查

1. 不勾选授权直接开始，应停留在授权区并读出提示。
2. 授权后选择一张 JPEG/PNG/WebP，检查预览、重拍和确认。
3. 在“演示状态”选择成功、无人脸、多人脸、未匹配或服务暂不可用。
4. 成功页应同时显示旧照、新照、分数、阈值、允许类别差异及“AI 创作/虚构”。
5. 点击“重新体验”，确认回到初始页且旧预览不再使用。

## 质量门

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

全部命令必须成功。更完整的接口和部署说明见 `docs/api.md` 与 `docs/deployment.md`。

