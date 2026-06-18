export const phetSubjectGroups = [
  {
    id: "physics",
    label: "物理",
    topics: [
      { id: "motion", label: "运动" },
      { id: "waves", label: "声音、振动、波" },
      { id: "work-energy-power", label: "功、能量、功率" },
      { id: "heat", label: "热学" },
      { id: "quantum-phenomena", label: "量子现象" },
      { id: "light-radiation", label: "光和辐射" },
      { id: "electricity-magnetism-circuits", label: "电场、磁场、电路" },
    ],
  },
  {
    id: "math",
    label: "数学",
    topics: [
      { id: "math-concepts", label: "数学概念" },
      { id: "math-applications", label: "数学的应用" },
    ],
  },
  {
    id: "chemistry",
    label: "化学",
    topics: [
      { id: "general-chemistry", label: "普通化学" },
      { id: "quantum-chemistry", label: "量子化学" },
    ],
  },
  {
    id: "earth-science",
    label: "地球科学",
    topics: [],
  },
  {
    id: "biology",
    label: "生物",
    topics: [],
  },
];

export const phetSchoolStages = [
  { id: "primary", label: "小学" },
  { id: "middle", label: "初中" },
  { id: "high", label: "高中" },
];

export const phetSimulations = [
  {
    id: "waves-intro",
    title: "波的入门",
    description: "观察水波、声波与光波，探索频率、振幅和波速之间的关系。",
    subject: "physics",
    topics: ["waves"],
    stages: ["primary", "middle", "high"],
    localUrl: "/simulations/phet/waves-intro.html?locale=zh_CN",
    originalUrl: "https://phet.colorado.edu/zh_CN/simulations/waves-intro",
    available: true,
  },
];

