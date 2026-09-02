import { randomInt } from "node:crypto";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { createProviders } from "./providers/index.js";

const config = readConfig();
const providers = await createProviders(config);
const accessCode = String(randomInt(100_000, 1_000_000));
const app = createApp({ config, providers, accessCode });

app.listen(config.port, config.host, () => {
  console.log(`照片故事服务已启动：http://${config.host}:${config.port}`);
  console.log(`Provider 模式：${config.providerMode}；现场照片默认不留存。`);
  console.log(`本次启动验证码：${accessCode}`);
});
