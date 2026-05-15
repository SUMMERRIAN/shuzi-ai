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
  "token-100": { id: "token-100", title: "Token充值 ¥100", priceCny: 100, learningTokens: 10000 },
  "token-300": { id: "token-300", title: "Token充值 ¥300", priceCny: 300, learningTokens: 30000 },
  "token-500": { id: "token-500", title: "Token充值 ¥500", priceCny: 500, learningTokens: 50000 },
};

export const tokenBillingRules = {
  markup: 3.5,
  tokensPerCny: 100,
};

export const storageExpansionPackages = {
  "storage-20gb": { id: "storage-20gb", title: "20GB扩容包", priceCny: 0, storageGb: 20 },
  "storage-50gb": { id: "storage-50gb", title: "50GB扩容包", priceCny: 0, storageGb: 50 },
};
