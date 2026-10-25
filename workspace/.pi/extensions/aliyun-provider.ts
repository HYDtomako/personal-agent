/**
 * 阿里云百炼（MaaS）provider：注册第三方模型（GLM 等），OpenAI 兼容接口。
 *
 * 实例地址与 API key 都经环境变量注入（桥接 spawn pi 时从 config.json 读取传入），
 * 不硬编码、不落盘到沙箱——方便开源分享，也避免实例信息进入仓库。
 *   ALIYUN_MAA_BASE_URL  你的百炼实例地址（形如 https://<实例id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1）
 *   ALIYUN_MAA_API_KEY   对应的 API key
 */

interface ExtensionAPI {
  registerProvider(name: string, config: Record<string, unknown>): void;
}

export default function aliyunProviderExtension(pi: ExtensionAPI) {
  const baseUrl = (process.env.ALIYUN_MAA_BASE_URL ?? "").trim();
  const apiKey = (process.env.ALIYUN_MAA_API_KEY ?? "").trim();
  if (!baseUrl || !apiKey) return; // 未配置就跳过注册（不影响其它模型）

  const models: Array<{ id: string; name: string }> = [
    { id: "glm-5.3", name: "GLM-5.3" },
  ];

  pi.registerProvider("aliyun-maas", {
    name: "Aliyun MaaS",
    baseUrl,
    apiKey: "$ALIYUN_MAA_API_KEY",
    api: "openai-completions",
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
    })),
  });
}
