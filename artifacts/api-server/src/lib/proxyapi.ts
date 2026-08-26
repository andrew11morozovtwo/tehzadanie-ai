const DEFAULT_PROXYAPI_BASE_URL = "https://api.proxyapi.ru/openai/v1";

export type ProxyApiConfig = {
  baseUrl: string;
  apiKey: string;
};

export function getProxyApiConfig(): ProxyApiConfig | null {
  const apiKey = process.env.PROXYAPI_KEY;
  if (!apiKey) return null;

  return {
    baseUrl: (process.env.PROXYAPI_BASE_URL ?? DEFAULT_PROXYAPI_BASE_URL).replace(/\/+$/, ""),
    apiKey,
  };
}