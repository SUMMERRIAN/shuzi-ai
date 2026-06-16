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

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buildAiJobError(job) {
  const jobError = job?.error || {};
  const detail = jobError.detail && jobError.detail !== jobError.message ? `；详情：${jobError.detail}` : "";
  const error = new Error(`${jobError.message || "AI任务处理失败"}${detail}`);
  error.payload = job;
  error.status = jobError.status || 500;
  return error;
}

async function waitForAiJob(jobId, options = {}) {
  const attempts = options.aiJobAttempts || 120;
  const intervalMs = options.aiJobIntervalMs || 5000;
  const transientStatuses = new Set([502, 503, 504, 524]);
  let transientErrors = 0;
  let lastTransientError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const job = await apiRequest(`/ai/jobs/${jobId}`, { skipAiJobPoll: true });
      transientErrors = 0;
      lastTransientError = null;
      if (job.status === "completed") return job.result || {};
      if (job.status === "failed") throw buildAiJobError(job);
      if (job.status === "cancelled") throw new Error("AI任务已取消。");
    } catch (error) {
      if (!transientStatuses.has(error.status)) throw error;
      transientErrors += 1;
      lastTransientError = error;
      if (transientErrors >= 6) {
        throw new Error(error.message || "AI任务轮询暂时不可用，请稍后刷新页面查看结果。");
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(lastTransientError?.message || "AI任务仍在后台处理中，请稍后刷新页面查看结果。");
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
    const rawDetail =
      typeof data.detail === "string"
        ? data.detail
        : data.detail?.message || data.detail?.error?.message || "";
    const detail = `${data.message || ""} ${rawDetail} ${data.provider || ""} ${data.model || ""}`;
    const providerLabel = data.provider === "gemini" ? "Gemini" : data.provider === "openai" ? "OpenAI" : "AI";
    const modelLabel = data.model ? `（模型：${data.model}）` : "";
    let message = data.message || data.error || `请求失败（HTTP ${response.status}）`;
    if (response.status === 429) {
      message = "AI当前请求过多，请稍等10-30秒后再试。";
    } else if ([502, 503, 504, 524].includes(response.status)) {
      message =
        response.status === 524
          ? "AI请求等待时间过长，任务可能仍在后台处理中，请稍后刷新页面查看结果，或减少文件数量后重试。"
          : `AI服务暂时不可用（HTTP ${response.status}），请稍后再试。`;
    } else if (response.status === 403 && /verified|verify|organization/i.test(detail)) {
      message = "当前OpenAI组织还没有完成模型权限验证，请完成验证或切换到可用模型。";
    } else if (/country|region|territory/i.test(detail)) {
      message = "当前服务器地区暂时不能使用OpenAI服务，请更换支持地区的服务器。";
    } else if (/API key|not configured|GEMINI_NOT_CONFIGURED|OPENAI_NOT_CONFIGURED/i.test(detail)) {
      message = `${providerLabel} API Key 未配置或不可用${modelLabel}。`;
    } else if (/model|not found|not supported|permission|access/i.test(detail)) {
      message = `${providerLabel}模型不可用${modelLabel}：${data.message || rawDetail || data.error || "请检查模型名称和账号权限。"}`;
    } else if (data.provider || data.model) {
      const visibleDetail = rawDetail && rawDetail !== message ? `；详情：${rawDetail}` : "";
      message = `${providerLabel}请求失败${modelLabel}：${message}${visibleDetail}`;
    }
    const error = new Error(message);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  if (!options.skipAiJobPoll && data?.jobId && data?.status && ["queued", "processing"].includes(data.status)) {
    return waitForAiJob(data.jobId, options);
  }
  return data;
}

export function mapAccountToMember(account) {
  if (!account?.user) {
    return {
      isLoggedIn: false,
      isPaid: false,
      id: "",
      identifier: "",
      role: "guest",
      provider: "用户名",
      plan: "",
      ltBalance: 0,
      storageTotalMb: 50,
    };
  }
  return {
    isLoggedIn: true,
    isPaid: Boolean(account.membership?.isPaid),
    id: account.user.id,
    identifier: account.user.identifier,
    role: account.user.role || "member",
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
