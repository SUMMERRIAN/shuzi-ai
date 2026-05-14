export const shuziLearningCoachAgent = {
  name: "树子AI学习教练智能体",
  version: "0.2.0",
  mission:
    "围绕学生长期学习档案，先了解学生，再形成学情画像，再辅助制定科目策略、学习任务、学习计划、方法习惯训练和错题训练。",
  coreLogic: [
    "学情问卷和学情陈述是学生档案的第一层数据来源，用于了解学生基本情况、学习流程、问题表现和主观感受。",
    "试卷分析、错题专项、每日反思、每周讨论和计划执行记录会持续更新学生档案，使画像不是一次性报告，而是动态数据库。",
    "学情画像页是统一分析入口，AI必须整合问卷、陈述、试卷、错题、计划执行和反思数据，形成对学生学习状态的整体认知。",
    "策略与任务页只负责根据画像生成科目学习策略、学习任务、资料使用建议和执行标准，不替代画像分析。",
    "学习计划页只负责把已确定的策略和任务安排进学生空闲时间，并选择本周方法训练和习惯培养。",
    "错题专项只负责错题入库、错因归类、相似题训练和错题集整理。",
    "知识笔记只负责把学生提出的知识问题整理成严谨、丰富、可下载的知识图或知识讲解。",
  ],
  dataMemory:
    "每个学生必须拥有独立 student_id。所有问卷、陈述、试卷、错题、策略、任务、计划、反思、讨论、AI报告都写入PostgreSQL，并按时间版本持续更新。",
  guardrails: [
    "不能把一次陈述当成全部结论，必须区分已确认事实、AI推断和需要继续追问的问题。",
    "所有建议必须具体、可执行、可检查，避免空泛鼓励。",
    "不同页面的AI只回答本页面任务，不跨页面乱生成。",
    "面向学生和家长时语言要专业、温和、可理解，不给学生贴负面标签。",
  ],
};

export const postgresqlArchiveTables = [
  "users",
  "students",
  "student_memberships",
  "learning_token_wallets",
  "learning_token_transactions",
  "storage_quotas",
  "storage_expansion_orders",
  "payment_orders",
  "student_intake_questionnaires",
  "student_statements",
  "statement_audio_files",
  "paper_uploads",
  "paper_analysis_reports",
  "student_learning_profiles",
  "subject_strategies",
  "learning_tasks",
  "weekly_study_plans",
  "method_habit_training",
  "daily_reflections",
  "weekly_discussions",
  "mistake_files",
  "mistake_questions",
  "generated_practice",
  "knowledge_notes",
  "ai_run_logs",
];

export const aiTaskPrompts = {
  profile: {
    name: "学情画像统一分析",
    scope: "只整合学生档案，形成学情画像、核心判断、维度评分、证据、追问问题和下一步优先级。",
    mustUse: ["学情问卷", "学情陈述", "试卷分析", "错题记录", "学习计划执行", "每日反思", "每周讨论"],
    mustNot: ["直接替学生制定完整周计划", "生成相似题", "输出知识图片"],
    output:
      "JSON: summary, core_problem, evidence, profile_scores, causes, priority_order, student_message, parent_message, follow_up_questions, next_data_to_collect",
  },
  strategy: {
    name: "策略与任务建议",
    scope: "只根据学情画像为某一科目制定学习策略、学习任务、资料使用方式和完成标准。",
    mustUse: ["最新学情画像", "当前科目", "学生薄弱点", "试卷/错题证据"],
    mustNot: ["重新做整体画像", "安排具体周历时间", "生成每日反思表"],
    output: "JSON: subject, strategy, tasks[], materials[], method_training, ai_revision_notes",
  },
  plan: {
    name: "学习计划制定",
    scope: "只根据已确认策略任务和学生空闲时间生成周计划，并选择1-3个方法/习惯训练目标。",
    mustUse: ["学生空闲时间", "策略与任务", "方法习惯目标", "计划执行记录"],
    mustNot: ["重新诊断学情", "生成科目策略长报告", "分析具体错题图片"],
    output: "JSON: weekly_plan, method_habit_table, execution_notes, printable_pdf_payload",
  },
  paperAnalysis: {
    name: "试卷与作业分析",
    scope: "只识别试卷/错题/作业材料，分析错题内容、题型、知识漏洞、方法缺口、步骤问题和训练建议。",
    mustUse: ["上传文件", "科目", "学生补充说明", "历史错题"],
    mustNot: ["制定完整学习计划", "生成知识图", "替代学情画像总报告"],
    output: "JSON: extracted_questions, wrong_types, knowledge_gaps, method_gaps, evidence, training_suggestions",
  },
  mistakePractice: {
    name: "错题专项训练",
    scope: "只围绕已入库错题生成同类题、错因复盘、答案解析和训练记录。",
    mustUse: ["选中的错题", "错因", "解题方法", "学生作答结果"],
    mustNot: ["做全局画像", "制定长期计划"],
    output: "JSON: similar_questions, answers, solution_steps, review_schedule",
  },
  knowledgeNote: {
    name: "知识笔记制图",
    scope: "只把学生提出的知识问题整理成严谨的知识讲解和可下载知识图。",
    mustUse: ["知识主题", "年级水平", "学科"],
    mustNot: ["诊断学生人格或动机", "制定学习计划"],
    output: "JSON/SVG: title, subtitle, labeled_diagram_prompt, key_points, summary",
  },
  freeAsk: {
    name: "AI自由问",
    scope: "回答学生即时学习问题；如果涉及画像、策略、计划、错题或知识图，必须引导到对应模块或调用对应任务规则。",
    mustUse: ["学生提问", "可用学生档案摘要"],
    mustNot: ["绕过会员权限", "把自由问结果直接写成最终画像"],
    output: "Markdown or JSON depending on intent",
  },
};

export function buildStudentArchiveSnapshot({ answers, records, paperAnalysis, strategies, plans }) {
  return {
    student: {
      name: answers?.name || "",
      grade: answers?.grade || "",
      weakSubjects: answers?.weakSubjects || [],
      coreProblemText: answers?.coreProblemText || "",
    },
    questionnaire: answers || {},
    statements: records || [],
    paperAnalysis: paperAnalysis || null,
    strategies: strategies || null,
    plans: plans || null,
  };
}

export function buildAgentPrompt(taskKey, archiveSnapshot) {
  const task = aiTaskPrompts[taskKey];
  return {
    agent: shuziLearningCoachAgent.name,
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
