export const usageGuideSections = [
  {
    id: "understand",
    label: "了解学情",
    intro: "先收集真实情况，再让AI形成判断。不要跳过前面的资料准备。",
    items: [
      {
        title: "1. 填写学情问卷",
        image: "/usage-guide/01-questionnaire.png",
        summary: "按照页面问题填写学生的真实学习情况，完成后保存或提交。",
        emphasis: "尽量具体、真实地填写，这是后续画像和任务建议的重要依据。",
      },
      {
        title: "2. 补充学情陈述",
        image: "/usage-guide/02-statement.png",
        summary: "选择科目和场景，再用文字、录音或上传语音说明当前困扰。",
        emphasis: "一条记录集中讲清一个问题；可以继续追问补充细节。",
      },
      {
        title: "3. 生成学情画像",
        image: "/usage-guide/03-profile.png",
        summary: "选择问卷、陈述、反思等资料，让AI综合分析学生的学习状态。",
        emphasis: "画像负责判断问题，不等同于学习计划；确认资料后再生成。",
      },
    ],
  },
  {
    id: "execute",
    label: "任务与计划",
    intro: "把学情判断变成具体任务，再安排到可以执行的一周时间里。",
    items: [
      {
        title: "4. 制定学习任务",
        image: "/usage-guide/04-tasks.png",
        summary: "按科目选择已有资料，让AI给出阶段任务、训练重点和完成标准。",
        emphasis: "每次只处理当前科目，生成后还可以结合实际情况修改。",
      },
      {
        title: "5. 安排学习计划",
        image: "/usage-guide/05-plan.png",
        summary: "把学习任务放入一周时间表，并记录每日反思和每周讨论。",
        emphasis: "AI给出的是建议，学生应根据学校作息和真实时间调整。",
      },
    ],
  },
  {
    id: "practice",
    label: "练习与理解",
    intro: "围绕具体问题训练，不让AI替学生思考。",
    items: [
      {
        title: "6. 使用错题专项",
        image: "/usage-guide/06-mistakes.png",
        summary: "上传题目、试卷或材料，选择分析错题、分析试卷或生成类似题。",
        emphasis: "先选任务，再上传材料并补充说明；生成后继续追问更有效。",
      },
      {
        title: "7. 使用“没有答案”",
        image: "/usage-guide/07-no-answer.png",
        summary: "提交问题后，AI通过提示和追问引导学生自己找到方法。",
        emphasis: "这里不会直接给最终答案，适合培养独立思考。",
      },
      {
        title: "8. 生成知识笔记",
        image: "/usage-guide/08-knowledge-notes.png",
        summary: "输入想理解的知识点，生成讲解或教材风格知识图。",
        emphasis: "主题要明确；生成后可以查看提示词、下载并保存知识图。",
      },
    ],
  },
  {
    id: "archive",
    label: "日历与资料",
    intro: "把任务、笔记和学习资料长期整理，形成可回看的个人档案。",
    items: [
      {
        title: "9. 记录学习日历",
        image: "/usage-guide/09-calendar.png",
        summary: "点击日期新建学习页面，记录任务、提醒、正文和附件。",
        emphasis: "一个日期可以建立多条记录，适合保存每天的重要学习事项。",
      },
      {
        title: "10. 整理学习资料库",
        image: "/usage-guide/10-library.png",
        summary: "上传资料、建立文件夹，并为文件补充学习笔记或整理内容。",
        emphasis: "资料会进入个人学习资料库，可以预览、下载和继续整理。",
      },
    ],
  },
  {
    id: "communicate",
    label: "交流与自由问",
    intro: "交流学习经验，或处理临时出现的知识与生活问题。",
    items: [
      {
        title: "11. 使用学习社区",
        image: "/usage-guide/11-community.png",
        summary: "浏览学习帖子，会员可以发帖、留言和向版主提问。",
        emphasis: "围绕学习问题交流，注意保护个人隐私，不发布敏感信息。",
      },
      {
        title: "12. 使用AI自由问",
        image: "/usage-guide/12-free-ask.png",
        summary: "输入临时问题，也可以上传图片或文件并选择合适的模型。",
        emphasis: "AI自由问只回答当前问题，不会自动写入学情画像。",
      },
    ],
  },
  {
    id: "membership",
    label: "会员与充值",
    intro: "选择会员和Token额度后提交申请，管理员确认后才会正式入账。",
    items: [
      {
        title: "13. 开通会员与充值",
        image: "/usage-guide/13-membership-payment-safe.png",
        summary: "先选择会员类型和Token额度，再确认金额、付款并提交确认申请。",
        emphasis: "本页二维码已安全遮挡；实际付款码和联系方式只在会员中心的正式流程中查看。",
      },
    ],
  },
];
