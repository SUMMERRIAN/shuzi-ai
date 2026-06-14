export const membershipPlans = {
  free: {
    id: "free",
    name: "免费用户",
    priceCny: 0,
    storageMb: 50,
    durationDays: null,
  },
  monthly: {
    id: "monthly",
    name: "VIP月度会员",
    priceCny: 19.9,
    storageMb: 3072,
    durationDays: 31,
  },
  season: {
    id: "season",
    name: "VIP季度会员",
    priceCny: 59,
    storageMb: 3072,
    durationDays: 93,
  },
  halfYear: {
    id: "halfYear",
    name: "VIP半年会员",
    priceCny: 109,
    storageMb: 3072,
    durationDays: 186,
  },
  yearly: {
    id: "yearly",
    name: "VIP年度会员",
    priceCny: 199,
    storageMb: 3072,
    durationDays: 366,
  },
};

export const ltPackages = {
  "token-100": { id: "token-100", title: "积分充值 ¥100", priceCny: 100, learningTokens: 10000 },
  "token-300": { id: "token-300", title: "积分充值 ¥300", priceCny: 300, learningTokens: 30000 },
  "token-500": { id: "token-500", title: "积分充值 ¥500", priceCny: 500, learningTokens: 50000 },
};

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const tokenBillingRules = {
  markup: numberFromEnv("AI_BILLING_MARKUP", 3.5),
  tokensPerCny: numberFromEnv("TOKENS_PER_CNY", 100),
  usdToCny: numberFromEnv("USD_TO_CNY", 7.3),
  minimumChargeTokens: Math.max(0, Math.ceil(numberFromEnv("AI_MIN_CHARGE_TOKENS", 1))),
  completedJobReuseMinutes: Math.max(0, Math.ceil(numberFromEnv("AI_COMPLETED_JOB_REUSE_MINUTES", 5))),
  pricingUpdatedAt: "2026-06-02",
  textPricingUsdPer1M: {
    "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
    "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
    "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
    "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
    "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gemini-3.5-flash": { input: 1.5, cachedInput: 0.15, output: 9 },
    "gemini-3.1-flash-lite": { input: 0.25, cachedInput: 0.025, output: 1.5 },
    "gemini-2.5-flash": { input: 0.3, cachedInput: 0.075, output: 2.5 },
    "gemini-2.5-pro": { input: 1.25, cachedInput: 0.31, output: 10 },
  },
  imagePricingUsd: {
    "gpt-image-2": {
      "1024x1024": { low: 0.011, medium: 0.042, high: 0.167 },
      default: { low: 0.011, medium: 0.042, high: 0.167 },
    },
    "gemini-3-pro-image": {
      default: {
        low: numberFromEnv("GEMINI_IMAGE_COST_USD_LOW", 0),
        medium: numberFromEnv("GEMINI_IMAGE_COST_USD_MEDIUM", 0),
        high: numberFromEnv("GEMINI_IMAGE_COST_USD_HIGH", 0),
      },
    },
  },
};

export const storageExpansionPackages = {
  "storage-20gb": { id: "storage-20gb", title: "20GB扩容包", priceCny: 0, storageGb: 20 },
  "storage-50gb": { id: "storage-50gb", title: "50GB扩容包", priceCny: 0, storageGb: 50 },
};
