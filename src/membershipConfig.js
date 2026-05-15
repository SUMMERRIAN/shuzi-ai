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
