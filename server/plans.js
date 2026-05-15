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
};

export const ltPackages = {
  "lt-990": { id: "lt-990", title: "990 LT充值包", priceCny: 9.9, learningTokens: 990 },
  "lt-2990": { id: "lt-2990", title: "2990 LT充值包", priceCny: 29.9, learningTokens: 2990 },
  "lt-5990": { id: "lt-5990", title: "5990 LT充值包", priceCny: 59.9, learningTokens: 5990 },
  "lt-9900": { id: "lt-9900", title: "9900 LT充值包", priceCny: 99, learningTokens: 9900 },
  "lt-19900": { id: "lt-19900", title: "19900 LT充值包", priceCny: 199, learningTokens: 19900 },
};

export const storageExpansionPackages = {
  "storage-20gb": { id: "storage-20gb", title: "20GB扩容包", priceCny: 0, storageGb: 20 },
  "storage-50gb": { id: "storage-50gb", title: "50GB扩容包", priceCny: 0, storageGb: 50 },
};
