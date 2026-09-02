# 人物库导入与授权说明

## 默认演示资料

仓库只提交演示种子：`apps/server/src/seed/people.json` 里只有 `demo-xiaoxia`，对应 `apps/server/src/seed/assets/people/demo-xiaoxia-old.svg`。该 SVG 由项目代码中的几何图形组成，标注“示例插画 · 非真实人物”，不构成真实人脸或身份材料。

真实人物库位于 `apps/server/src/people.json` 与服务端私有目录 `apps/server/src/assets/people/`，两者都不入版本库（见 `.gitignore`），只存在于部署机上。运行时在两者缺失时自动回落到种子，因此全新 clone 可以直接构建、测试和以 mock 模式启动。

## 禁止事项

- 不得从搜索引擎、社交网络、新闻、员工目录或公开相册抓取人物照片。
- 不得以“公开可见”代替授权。
- 不得导入授权用途、期限或主体不明确的照片。
- 不得把现场照片自动加入人物库。
- 不得添加健康、种族、宗教、政治等敏感属性字段。

## 导入已授权资料

真实资料只能由有权限的维护人员在独立隐私评审后导入：

1. 取得照片中人物对“照片故事匹配演示”这一具体用途的书面授权。
2. 记录授权人、材料来源、授权日期、用途、允许环境、到期日与撤回渠道；授权记录存放在受控系统，不能提交个人信息到本公开代码库。
3. 取得照片中**每一位人物**的同用途授权；一人未授权或撤回即整张合影停止用于 real 模式。另检查位置水印、证件、联系方式等额外个人信息。
4. 生成最小化 WebP 版本，删除 EXIF/GPS，采用不可猜测文件名，并放入服务端私有 `assets/people` 目录；不得放入前端静态目录。
5. 授权书明确说明人脸特征会持久化到 Azure Face（southeastasia）、用途、最短保留期限、撤回渠道，以及撤回后 30 天内删除并重训生效。
6. 由第二位审核者核对图片与授权记录；脚本通过 Managed Identity 在 Azure LargePersonGroup 中建立独立 person 与 persisted face。
7. 使用非生产副本运行阈值校准、误匹配测试与删除演练。

完成授权与人工检查后，先用 Azure Detect 获取人脸序号，再用可重复的 `--member` 将合影成员与 `faceIndex` 对应。脚本只接受 `qualityForRecognition` 为 `high` 或 `medium`（`low` 与缺失一律拒绝），自动使用 Detect 返回的矩形，执行几何防跨脸校验、Create Person、Add Face、Train 和入库后 Detect + Identify 自检：

```bash
npm run people -w @photo-story/server -- add \
  --photo ./approved-photo.webp \
  --source-note "全员已完成特定用途授权；记录在受控系统。" \
  --member person-a:"批准的展示名甲":0 \
  --member person-b:"批准的展示名乙":1
```

支持 JPEG、PNG 和 WebP，单张不超过 6 MiB。成员序号从 0 开始且不得重复。real 模式强制全员 `authorized`。单人物 mock/占位资料仍可使用 `--id`、`--display-name` 和 `--authorization placeholder` 的兼容形式。

查询全部人物或单个人物：

```bash
npm run people -w @photo-story/server -- list
npm run people -w @photo-story/server -- get person-id
```

v2 元数据将照片提升为一等实体；Azure UUID 仅供运维，不进入 API 响应或日志：

```json
{
  "schemaVersion": 2,
  "photos": [{
    "id": "photo-id",
    "file": "不可猜测资源名.webp",
    "mimeType": "image/webp",
    "width": 800,
    "height": 534,
    "sourceNote": "授权记录在受控系统",
    "members": [{
      "personId": "person-a",
      "faceBox": { "left": 20, "top": 30, "width": 100, "height": 120 },
      "azurePersistedFaceId": "Azure UUID"
    }]
  }],
  "people": [{
    "id": "person-a",
    "displayName": "批准的展示名",
    "photoId": "photo-id",
    "oldPhotoUrl": "/api/people/person-a/photo",
    "authorization": "authorized",
    "sourceNote": "授权记录在受控系统",
    "azurePersonId": "Azure UUID"
  }]
}
```

旧版顶层人物数组会在读取时兼容升级为“一人一照片”；下一次管理脚本写入会保存为 v2。

## 删除与撤回

收到撤回后立即执行删除并记录完成时间。脚本会删除 Azure persistedFace 与 person，触发 Train 并等待成功；Azure 的 DELETE 本身不足以让 Identify 停止命中，**只有重训成功才算完成**。训练失败时命令非零退出并要求运行 `sync`，不得向授权主体宣称已删除。受控端点不允许 CDN 缓存；任一合影成员撤回时，real 模式全员授权门禁会停止整张原图投放。

共享照片在仍有其他成员时保留，最后一名成员删除后才清理本地文件：

```bash
npm run people -w @photo-story/server -- delete person-id
```

灾恢、模型升级或发现本地/Azure 漂移时执行 `npm run people -w @photo-story/server -- sync`，它会重建 person/face、训练并逐脸自检。脚本不删除受控授权记录或备份，仍需按保留策略处理这些系统。
