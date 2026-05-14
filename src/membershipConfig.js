export const storagePlans = {
  free: {
    name: "免费用户",
    storageMb: 50,
    description: "用于浏览和轻量体验，限制长期保存和大量文件上传。",
  },
  vip: {
    name: "VIP会员",
    monthlyPriceCny: 19.9,
    storageGb: 3,
    description: "开放学生档案、AI功能入口、PDF下载和基础文件存储。",
  },
  expansion: [
    { id: "storage-20gb", name: "20GB扩容包", storageGb: 20 },
    { id: "storage-50gb", name: "50GB扩容包", storageGb: 50 },
  ],
};

export const learningTokenRules = {
  currency: "CNY",
  userFacingUnit: "LT",
  cnyPerLearningToken: 0.01,
  learningTokenPerCny: 100,
  apiCostMarkup: 4.2,
  operatingUsdCnyRate: 6.82,
  formula: "LT消耗 = API真实美元成本 × operatingUsdCnyRate × apiCostMarkup × learningTokenPerCny",
};

export const learningTokenPackages = [
  {
    id: "lt-990",
    priceCny: 9.9,
    learningTokens: 990,
    maxApiCostCny: 2.36,
    maxApiCostUsd: 0.35,
  },
  {
    id: "lt-2990",
    priceCny: 29.9,
    learningTokens: 2990,
    maxApiCostCny: 7.12,
    maxApiCostUsd: 1.04,
  },
  {
    id: "lt-5990",
    priceCny: 59.9,
    learningTokens: 5990,
    maxApiCostCny: 14.26,
    maxApiCostUsd: 2.09,
  },
  {
    id: "lt-9900",
    priceCny: 99,
    learningTokens: 9900,
    maxApiCostCny: 23.57,
    maxApiCostUsd: 3.46,
  },
  {
    id: "lt-19900",
    priceCny: 199,
    learningTokens: 19900,
    maxApiCostCny: 47.38,
    maxApiCostUsd: 6.95,
  },
];

export function estimateLearningTokenCost(apiCostUsd) {
  return Math.ceil(
    apiCostUsd *
      learningTokenRules.operatingUsdCnyRate *
      learningTokenRules.apiCostMarkup *
      learningTokenRules.learningTokenPerCny
  );
}
