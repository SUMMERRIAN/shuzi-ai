const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";
const TOKEN_KEY = "shuzi_ai_token";

export function getAuthToken() {
  return window.localStorage.getItem(TOKEN_KEY) || "";
}

export function setAuthToken(token) {
  if (token) {
    window.localStorage.setItem(TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(TOKEN_KEY);
  }
}

export async function apiRequest(path, options = {}) {
  const token = getAuthToken();
  const isFormData = options.body instanceof FormData;
  const headers = isFormData
    ? { ...(options.headers || {}) }
    : {
        "Content-Type": "application/json",
        ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
    });
  } catch (cause) {
    const error = new Error("无法连接到AI后端服务，请刷新页面或稍后再试。");
    error.cause = cause;
    throw error;
  }
  const rawText = await response.text();
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { detail: rawText };
  }
  if (!response.ok) {
    const detail = `${data.message || ""} ${data.detail || ""} ${data.provider || ""} ${data.model || ""}`;
    const providerLabel = data.provider === "gemini" ? "Gemini" : data.provider === "openai" ? "OpenAI" : "AI";
    const modelLabel = data.model ? `（模型：${data.model}）` : "";
    let message = data.message || data.error || `请求失败（HTTP ${response.status}）`;
    if (response.status === 429) {
      message = "AI当前请求过多，请稍等10-30秒后再试。";
    } else if (response.status === 403 && /verified|verify|organization/i.test(detail)) {
      message = "当前OpenAI组织还没有完成模型权限验证，请完成验证或切换到可用模型。";
    } else if (/country|region|territory/i.test(detail)) {
      message = "当前服务器地区暂时不能使用OpenAI服务，请更换支持地区的服务器。";
    } else if (/API key|not configured|GEMINI_NOT_CONFIGURED|OPENAI_NOT_CONFIGURED/i.test(detail)) {
      message = `${providerLabel} API Key 未配置或不可用${modelLabel}。`;
    } else if (/model|not found|not supported|permission|access/i.test(detail)) {
      message = `${providerLabel}模型不可用${modelLabel}：${data.message || data.detail || data.error || "请检查模型名称和账号权限。"}`;
    } else if (data.provider || data.model) {
      message = `${providerLabel}请求失败${modelLabel}：${message}`;
    }
    const error = new Error(message);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

export function mapAccountToMember(account) {
  if (!account?.user) {
    return {
      isLoggedIn: false,
      isPaid: false,
      identifier: "",
      provider: "用户名",
      plan: "",
      ltBalance: 0,
      storageTotalMb: 50,
    };
  }
  return {
    isLoggedIn: true,
    isPaid: Boolean(account.membership?.isPaid),
    identifier: account.user.identifier,
    provider: account.user.provider || "用户名",
    plan: account.membership?.planName || "免费用户",
    membershipStatus: account.membership?.status || "free",
    membershipStartedAt: account.membership?.startedAt || null,
    membershipExpiresAt: account.membership?.expiresAt || null,
    daysRemaining: account.membership?.daysRemaining ?? null,
    isExpiringSoon: Boolean(account.membership?.isExpiringSoon),
    ltBalance: account.wallet?.balance || 0,
    storageTotalMb: account.storage?.totalMb || 50,
    storageUsedBytes: account.storage?.usedBytes || 0,
  };
}
