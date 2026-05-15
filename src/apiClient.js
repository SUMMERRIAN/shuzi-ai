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
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || "请求失败");
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
      provider: "网易邮箱",
      plan: "",
      ltBalance: 0,
      storageTotalMb: 50,
    };
  }
  return {
    isLoggedIn: true,
    isPaid: Boolean(account.membership?.isPaid),
    identifier: account.user.identifier,
    provider: account.user.provider || (account.user.channel === "phone" ? "手机号" : "邮箱"),
    plan: account.membership?.planName || "免费用户",
    membershipStatus: account.membership?.status || "free",
    ltBalance: account.wallet?.balance || 0,
    storageTotalMb: account.storage?.totalMb || 50,
    storageUsedBytes: account.storage?.usedBytes || 0,
  };
}
