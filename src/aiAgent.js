export const shuziLearningCoachAgent = {
  name: "树子AI学习教练智能体",
  version: "0.4.0",
  mission:
    "先通过学生档案理解学生，再形成学情画像，并把画像转化为学习任务、学习计划和方法习惯训练。",
  coreLogic: [
    "学情画像只整合学情问卷、学情陈述、每日反思和每周讨论；最近1-2个月的信息优先作为动态记忆。",
    "学习任务只根据最新学情画像和当前科目生成可执行建议，不重新诊断，也不处理错题图片。",
    "学习计划只把已确认的策略、任务、默认可用时间规则、方法习惯目标安排进周计划。",
    "错题专项、知识笔记、学习日历、学习资料库、学习社区、AI自由问不参与学情画像和学习计划判断。",
    "错题专项独立使用 Gemini，负责当前错题或试卷材料分析、相似题和错题档案。",
    "知识笔记独立使用 OpenAI 图像模型，把当前知识问题生成知识图。",
    "AI自由问只回答当前问题，可由学生选择 OpenAI 或 Gemini，不把回答自动写成学情判断。",
    "学习日历、学习资料库和学习社区只做记录、资料和交流管理，不调用 AI。",
  ],
  dataMemory:
    "每个学生必须拥有独立 student_id。问卷、陈述、反思、讨论、AI画像、策略任务、计划、错题、知识图、资料和社区记录都写入 PostgreSQL；但只有问卷、陈述、每日反思和每周讨论进入学情画像分析。",
  guardrails: [
    "不能把一次陈述当成全部结论，必须区分已确认事实、AI推断和需要继续追问的问题。",
    "所有建议必须具体、可执行、可检查，避免空泛鼓励。",
    "不同页面的 AI 只回答本页面任务，不跨页面混用数据。",
    "面向学生和家长时语言要专业、温和、可理解，不给学生贴负面标签。",
    "所有 AI 调用只在用户明确点击按钮或提交问题时执行一次，不自动重复生成。",
  ],
};

export const defaultStudyPlanTimePolicy = {
  summary: "没有明确作息时，学习计划按中国大陆中学生常见学习日节奏生成，并允许学生自行修改。",
  weekdayBlocks: [
    "早晨7:00前：15到20分钟轻任务，如背诵、预习、回忆错题方法。",
    "白天在校：不安排完整自主学习任务；课间10分钟最多安排约5分钟轻任务。",
    "晚自习：默认一节课左右的自主学习时间，适合错题复盘、专题训练、限时练习或阶段复习。",
    "回家后：默认约30分钟收尾时间，适合复盘、整理明日任务、轻量背诵或检查作业漏洞。",
    "晚上22:30到23:00左右睡觉，计划必须留出休息余量。",
  ],
  rule: "计划说明必须提醒学生：这些时间只是默认建议，可以按真实作息自行调整。",
};

export const postgresqlArchiveTables = [
  "users",
  "students",
  "student_memberships",
  "learning_token_wallets",
  "learning_token_transactions",
  "storage_quotas",
  "payment_orders",
  "student_intake_questionnaires",
  "student_statements",
  "statement_audio_files",
  "student_learning_profiles",
  "student_archive_events",
  "mistake_files",
  "generated_practice",
  "knowledge_notes",
  "learning_calendar_events",
  "library_items",
];

export const profileSourcePolicy = {
  include: ["学情问卷", "学情陈述", "每日反思", "每周讨论"],
  exclude: ["错题专项", "知识笔记", "学习日历", "学习资料库", "学习社区", "AI自由问"],
  memoryWindow: "优先参考最近1-2个月记录；旧记录只作为背景。",
};

export const aiTaskPrompts = {
  profile: {
    name: "学情画像统一分析",
    scope:
      "只整合学情问卷、学情陈述、每日反思和每周讨论，形成学情画像、核心判断、维度评分、证据、追问问题和下一步优先级。",
    mustUse: [...profileSourcePolicy.include, profileSourcePolicy.memoryWindow],
    mustNot: [...profileSourcePolicy.exclude, "直接制定完整周计划", "生成相似题", "输出知识图片"],
    output: "JSON: summary, core, reasons, evidence, tags, questions, next, archiveConclusion, scores",
  },
  strategy: {
    name: "学习任务建议",
    scope:
      "只根据最新学情画像、学情问卷、学情陈述和当前科目，为学生制定一组具体、可执行、可检查的学习任务建议。",
    mustUse: ["最新学情画像", "学情问卷", "学情陈述", "当前科目", "已确认的学习目标"],
    mustNot: ["重新做整体画像", "安排具体周历时间", "分析错题图片", "生成每日反思表", "生成资料推荐", "只生成单个任务"],
    output: "JSON: strategy_suggestion, ai_note, tasks",
  },
  plan: {
    name: "学习计划制定",
    scope:
      "只根据已确认学情画像、学习任务、默认可用时间规则、方法训练和习惯培养目标，生成可修改的周学习计划。",
    mustUse: ["学情画像", "学习任务", "默认可用时间规则", "方法习惯目标"],
    mustNot: ["重新诊断学情", "生成科目策略长报告", "分析错题图片", "生成相似题"],
    output: "JSON: note, rows, method_focus_suggestions, habit_focus_suggestions, execution_notes",
  },
  mistakePractice: {
    name: "错题专项",
    scope:
      "只围绕当前上传或选中的错题、作业、试卷材料，进行错题分析、同类题生成、试卷分析和错题档案整理。",
    mustUse: ["当前错题材料", "当前学生提示词", "当前科目"],
    mustNot: ["学情画像总分析", "学习计划制定", "知识图生成", "学习社区内容"],
    output:
      "JSON: title, summary, sections, extracted_questions, similar_questions, training_suggestions, archive_note",
  },
  knowledgeNote: {
    name: "知识笔记与知识图",
    scope:
      "只把学生当前提出的知识问题整理成严谨、丰富、可下载的知识图或知识讲解。",
    mustUse: ["当前知识主题", "年级水平", "学生可编辑的提示词模板"],
    mustNot: ["诊断学生学习画像", "制定学习计划", "分析错题档案"],
    output: "图片与简短知识说明",
  },
  freeAsk: {
    name: "AI自由问",
    scope:
      "回答学生当前提出的任意问题，可以结合当前上传的图片或文件。模型可在 OpenAI 和 Gemini 之间切换。",
    mustUse: ["当前提问", "当前上传附件", "当前选择的模型和模式"],
    mustNot: ["自动写入学情画像", "自动制定学习计划", "重复提交同一问题"],
    output: "Markdown 文本；如果明确要求图片，可返回图片结果",
  },
};

function studentBase(answers = {}) {
  return {
    name: answers?.name || "",
    grade: answers?.grade || "",
    weakSubjects: answers?.weakSubjects || [],
    coreProblemText: answers?.coreProblemText || "",
  };
}

export function buildProfileArchiveSnapshot({
  answers = {},
  records = [],
  dailyReflections = [],
  weeklyDiscussions = [],
} = {}) {
  return {
    policy: profileSourcePolicy,
    student: studentBase(answers),
    questionnaire: answers || {},
    statements: records || [],
    dailyReflections,
    weeklyDiscussions,
  };
}

export function buildStrategyArchiveSnapshot({
  answers = {},
  records = [],
  aiInsight = null,
  strategies = null,
  activeSubject = "",
  dailyReflections = [],
  weeklyDiscussions = [],
} = {}) {
  return {
    policy: {
      basis: "只使用学情画像和当前科目学习任务上下文，不重新分析错题或生成计划。",
      excluded: profileSourcePolicy.exclude,
    },
    student: studentBase(answers),
    profile: aiInsight,
    subject: activeSubject,
    questionnaireSummary: {
      weakSubjects: answers?.weakSubjects || [],
      coreProblemText: answers?.coreProblemText || "",
    },
    recentStatements: records || [],
    dailyReflections,
    weeklyDiscussions,
    strategies,
  };
}

export function buildPlanArchiveSnapshot({
  answers = {},
  records = [],
  aiInsight = null,
  strategies = null,
  plans = null,
  dailyReflections = [],
  weeklyDiscussions = [],
} = {}) {
  return {
    policy: {
      basis: "根据已确认学情画像、学习任务、默认可用时间规则和方法习惯目标制定计划。没有明确作息时，不要求学生额外填写时间，先按默认中学生学习日节奏生成可修改计划。",
      excluded: ["错题图片分析", "知识图生成", "学习社区内容", "资料库文件内容"],
    },
    defaultTimePolicy: defaultStudyPlanTimePolicy,
    student: studentBase(answers),
    profile: aiInsight,
    recentStatements: records || [],
    dailyReflections,
    weeklyDiscussions,
    strategies,
    plans,
  };
}

export function buildPageOnlySnapshot({ page = "", answers = {}, payload = {} } = {}) {
  return {
    policy: "只处理当前页面当前请求，不调用或更新学情画像。",
    page,
    student: {
      grade: answers?.grade || "",
    },
    payload,
  };
}

export function buildStudentArchiveSnapshot(input = {}) {
  return buildProfileArchiveSnapshot(input);
}

export function buildAgentPrompt(taskKey, archiveSnapshot) {
  const task = aiTaskPrompts[taskKey];
  return {
    agent: shuziLearningCoachAgent.name,
    version: shuziLearningCoachAgent.version,
    mission: shuziLearningCoachAgent.mission,
    task: task?.name || taskKey,
    taskScope: task?.scope || "",
    mustUse: task?.mustUse || [],
    mustNot: task?.mustNot || [],
    outputContract: task?.output || "",
    archiveSnapshot,
    guardrails: shuziLearningCoachAgent.guardrails,
  };
}
