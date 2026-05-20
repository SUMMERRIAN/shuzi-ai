import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  BarChart3,
  BookOpen,
  Brain,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock3,
  CreditCard,
  Crown,
  Download,
  FileAudio,
  FileDown,
  FileImage,
  FileMusic,
  FileText,
  FileVideo,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Image as ImageIcon,
  Library,
  Loader2,
  LockKeyhole,
  LogIn,
  LogOut,
  Mic,
  PauseCircle,
  Plus,
  Save,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  UploadCloud,
  UserRound,
  WandSparkles,
} from "lucide-react";
import { aiTaskPrompts, buildAgentPrompt, buildStudentArchiveSnapshot, postgresqlArchiveTables, shuziLearningCoachAgent } from "./aiAgent.js";
import { apiRequest, getAuthToken, mapAccountToMember, setAuthToken } from "./apiClient.js";
import { storagePlans } from "./membershipConfig.js";
import "./styles.css";

const subPages = [
  { id: "home", label: "首页", icon: Home },
  { id: "questionnaire", label: "学情问卷", icon: ClipboardList },
  { id: "statement", label: "学情陈述", icon: Mic },
  { id: "profile", label: "学情画像", icon: BarChart3 },
  { id: "strategy", label: "策略与任务", icon: BookOpen },
  { id: "plan", label: "学习计划", icon: CalendarDays },
  { id: "mistakes", label: "错题专项", icon: Library },
  { id: "notes", label: "知识笔记", icon: ImageIcon },
  { id: "calendar", label: "学习日历", icon: CalendarDays },
  { id: "library", label: "学习资料库", icon: FolderOpen },
  { id: "forum", label: "学习社区", icon: UserRound },
  { id: "freeAsk", label: "AI自由问", icon: Sparkles },
];

const defaultMemberPlans = [
  { id: "monthly", name: "月付会员", price: "¥19.9/月", priceCny: 19.9, durationDays: 31, description: `适合先体验完整学习系统，包含AI分析、错题训练、资料下载和${storagePlans.vip.storageGb}GB基础存储。` },
  { id: "season", name: "季付会员", price: "¥59/季", priceCny: 59, durationDays: 93, description: "适合跟进一个阶段的学习调整，持续保存个人档案和学习记录。" },
  { id: "halfYear", name: "半年会员", price: "¥109/半年", priceCny: 109, durationDays: 186, description: "适合稳定训练学习方法、错题复测和阶段性学习策略优化。" },
  { id: "yearly", name: "年度会员", price: "¥199/年", priceCny: 199, durationDays: 366, description: "适合长期建立学生学习数据库，持续跟踪学情变化和训练结果。" },
];

const defaultTokenPackages = [
  { id: "token-100", label: "¥100", priceCny: 100, tokens: 10000 },
  { id: "token-300", label: "¥300", priceCny: 300, tokens: 30000 },
  { id: "token-500", label: "¥500", priceCny: 500, tokens: 50000 },
];

function formatPriceLabel(plan) {
  const suffixMap = { monthly: "/月", season: "/季", halfYear: "/半年", yearly: "/年" };
  return `¥${Number(plan.priceCny || 0)}${suffixMap[plan.id] || ""}`;
}

function normalizeMemberPlans(plans = []) {
  const descriptions = Object.fromEntries(defaultMemberPlans.map((plan) => [plan.id, plan.description]));
  return plans
    .filter((plan) => plan.id !== "free")
    .map((plan) => ({
      ...plan,
      price: plan.price || formatPriceLabel(plan),
      description: plan.description || descriptions[plan.id] || "开通后可以使用AI分析、个人档案、错题训练、资料下载等会员能力。",
    }));
}

function normalizeTokenPackages(packages = []) {
  return packages.map((pack) => ({
    ...pack,
    label: pack.label || `¥${Number(pack.priceCny || 0)}`,
    tokens: Number(pack.tokens ?? pack.learningTokens ?? 0),
  }));
}

function orderStatusLabel(status) {
  if (status === "paid") return "已确认";
  if (status === "cancelled") return "已取消";
  if (status === "refunded") return "已退款";
  return "待确认";
}

function orderTypeLabel(type) {
  if (type === "membership") return "会员开通";
  if (type === "lt_recharge") return "Token充值";
  if (type === "storage_expansion") return "存储扩容";
  return "付款申请";
}

const freeAskModelOptions = [
  { value: "openai-fast", provider: "openai", mode: "fast", label: "OpenAI · 快速" },
  { value: "openai-thinking", provider: "openai", mode: "thinking", label: "OpenAI · 思考" },
  { value: "gemini-fast", provider: "gemini", mode: "fast", label: "Gemini · 快速" },
  { value: "gemini-thinking", provider: "gemini", mode: "thinking", label: "Gemini · 思考" },
];

const libraryViews = [
  { id: "home", label: "首页", icon: Home },
  { id: "drive", label: "我的云端硬盘", icon: HardDrive },
  { id: "recent", label: "最近用过", icon: Clock3 },
  { id: "starred", label: "已加星标", icon: Star },
  { id: "trash", label: "回收站", icon: Trash2 },
  { id: "storage", label: "存储空间", icon: UploadCloud },
];

const maxCalendarImageSize = 25 * 1024 * 1024;

function toDateKey(date) {
  const target = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(target.getTime())) return new Date().toISOString().slice(0, 10);
  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildMonthDays(cursor) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      date,
      key: toDateKey(date),
      inMonth: date.getMonth() === month,
    };
  });
}

function formatFileSize(bytes = 0) {
  const size = Number(bytes || 0);
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function fileIconFor(item) {
  const mime = item?.mimeType || "";
  if (item?.type === "folder") return FolderOpen;
  if (mime.startsWith("image/")) return FileImage;
  if (mime.startsWith("video/")) return FileVideo;
  if (mime.startsWith("audio/")) return FileMusic;
  return FileText;
}

function previewKindFor(item) {
  const mime = item?.mimeType || "";
  const name = (item?.name || item?.originalName || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || name.endsWith(".txt")) return "text";
  return "";
}

function isWordLike(item) {
  const mime = item?.mimeType || "";
  const name = (item?.name || "").toLowerCase();
  return (
    mime.includes("wordprocessingml") ||
    mime === "application/msword" ||
    name.endsWith(".doc") ||
    name.endsWith(".docx")
  );
}

function fileTypeLabel(item) {
  if (item.type === "folder") return "文件夹";
  if (item.type === "document") return "云端文档";
  const mime = item.mimeType || "";
  if (mime.startsWith("image/")) return "图片";
  if (mime.startsWith("audio/")) return "音频";
  if (mime.startsWith("video/")) return "视频";
  if (mime === "application/pdf") return "PDF";
  if (isWordLike(item)) return "Word";
  if (mime.includes("spreadsheet") || mime.includes("excel")) return "Excel";
  if (mime.includes("presentation") || mime.includes("powerpoint")) return "PPT";
  return "文件";
}
const defaultForumPosts = [
  {
    id: "post-1",
    type: "学习问题",
    title: "错题改完以后，为什么过几天还是不会？",
    content: "我每次订正的时候都觉得自己听懂了，但是过几天再遇到类似题还是会卡住。想问一下应该怎么复习错题才有效？",
    author: "初二会员同学",
    time: "今天 09:20",
    likes: 18,
    replies: [
      { id: "reply-1", author: "版主 · 夏雨学习法", role: "moderator", time: "今天 09:48", content: "你现在的问题不是“没改错”，而是缺少复测。建议把错题分成当天重做、隔天重做、一周后重做三次。" },
      { id: "reply-2", author: "高一会员同学", role: "member", time: "今天 10:12", content: "我现在会在错题本旁边写同类题特征，不只是写答案，感觉会好很多。" },
    ],
  },
  {
    id: "post-2",
    type: "学习心得",
    title: "分享一个让我晚上不拖延的小办法",
    content: "我以前回家总是先玩手机，现在改成进门先把今天必须完成的任务写到纸上，只写三个，不写太多，反而更容易开始。",
    author: "初三会员同学",
    time: "昨天 21:10",
    likes: 31,
    replies: [
      { id: "reply-3", author: "版主 · 夏雨学习法", role: "moderator", time: "昨天 21:36", content: "这个方法很好，本质是降低启动成本。任务不要一开始就追求完整，要先让大脑愿意开始。" },
    ],
  },
];

const statementGuideQuestions = [
  "你现在最困扰的学习问题是什么？",
  "这个问题大概从什么时候开始的？",
  "它主要影响哪个科目或哪个学习环节？",
  "你自己觉得可能是什么原因造成的？",
  "你希望老师、家长或AI学习教练怎样帮助你？",
];

const statementSubjects = ["整体学习", "语文", "数学", "英语", "物理", "化学", "考试发挥", "学习动力", "亲子沟通"];
const statementScenes = ["上课", "作业", "错题", "复习", "考试", "计划执行", "情绪精力", "家庭环境"];

const statementIssueOptions = [
  "上课听不懂",
  "作业拖延",
  "错题反复错",
  "考试发挥不稳定",
  "学习动力不足",
  "计划执行困难",
  "手机干扰",
  "亲子沟通压力",
];

const subjectNames = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治"];

const coreProblemRows = [
  "动力不足",
  "懒或不想行动",
  "不想学习、不想读书",
  "太累了",
  "手机困扰",
  "喜欢玩游戏",
  "喜欢看小说或短视频",
  "不喜欢学习",
  "不喜欢老师",
  "师生关系困扰",
  "不喜欢学校",
  "周围环境太差",
  "同学关系问题",
  "家庭环境困扰",
  "父母关系困扰",
  "作业太多",
  "作业太慢",
  "基础知识太差",
  "学习能力差",
  "自律困扰",
  "上课听不懂",
  "学习方法困扰",
  "作业不会做",
  "心智发展或状态问题",
  "考试发挥不稳定",
  "以上都没有",
];

const planRows = [
  "我会根据自己的学习需要制定学习计划，并努力实践。",
  "我平时不会定什么学习计划，寒暑假或备考阶段也是这样。",
  "我常常定了学习计划，但往往不能按计划去做。",
  "计划当天没有完成，我第二天仍然会继续执行，而不是放弃。",
  "计划没完成时，我会反思并优化计划。",
  "我会兼顾每个科目的学习，尽量不偏科。",
  "我基本只完成学校作业，除此之外不额外安排学习任务。",
  "我会设定每学期的学习目标，比如分数或名次。",
  "我会控制手机、游戏或其他容易影响学习的东西。",
  "我会根据科目不同制定不同的学习策略。",
  "针对不同科目的弱项，我会制定不同的学习任务。",
];

const classRows = [
  "上课时，我通常认真听讲。",
  "上课时，我能够听懂老师所讲的内容。",
  "上课时，我能专心听讲，不分神。",
  "上课时，我不会与同学讲话或做其他小动作。",
  "即使不是优势科目，我也会努力认真听讲。",
  "我只对感兴趣的科目认真听，其他科目不太认真。",
  "上课时，我会根据自己的需要记笔记。",
  "我的笔记是认真、清楚的，不是潦草随意的。",
  "课后我会整理课堂笔记。",
  "我会对笔记内容进行有目的的复习，直到掌握。",
  "我的笔记可以像资料书一样用来查证知识。",
  "老师演示实验、模型或图像时，我会努力看清楚并弄懂它说明什么。",
  "我会用符号对知识进行标记或分类。",
  "老师讲的例子我能听懂，但让我概括时会困难。",
  "我能把课堂知识用自己的话说清楚。",
  "我会主动把新知识和旧知识联系起来。",
];

const homeworkRows = [
  "白天有零碎时间时，我会抓紧时间做作业。",
  "做作业前，我一般不会先复习课堂内容。",
  "做作业前，我会先复习并弄懂教材要点。",
  "作业能帮助我有效巩固课堂所学。",
  "遇到难题时，我会一次又一次地思考。",
  "我经常有抵触作业的情绪或行为。",
  "我经常不能按时完成作业，因为做得很慢。",
  "我做作业慢，但我觉得自己已经很努力。",
  "我做作业慢，是因为不能专注。",
  "问答题或作文，我心里懂，但动笔写不好。",
  "我会按老师要求的规范、格式和流程做题。",
  "写文章或问答题时，我会先列要点再动笔。",
  "当天功课我尽量当天复习并完成作业。",
  "做题时我会认真审题，勾画关键词或画图分析。",
  "我的做题步骤比较规范。",
  "我做题时书写比较工整。",
  "我会分区域、规范地打草稿。",
  "做题之后我会有意识地检查。",
  "做题之后我会标记难题、经典题、错题，方便以后复习。",
  "我喜欢反复品味自己好不容易做出来的题。",
  "做题之后我会总结这道题给我的经验或启示。",
  "作业错题我会改错并整理。",
  "我会总结题目规律，找出解题方法。",
  "老师课堂讲大题后，我会课后凭记忆重新演算一遍。",
  "发现作业中的问题、难点、重点时，我会及时记录。",
];

const reviewRows = [
  "老师讲到难题时，我会认真听。",
  "考试时我常常紧张，本来会做的题也可能做错。",
  "老师讲完试卷或作业后，我基本都能弄懂。",
  "老师讲题时，我会总结解题思路。",
  "我会思考解题方法的本质。",
  "发现有关联的知识点时，我会比较、总结、分析。",
  "重点题听懂后，我会课后复习或再次演算。",
  "我会有计划地定期复习或总结，确保牢固掌握知识。",
  "我有额外的复习计划，不只做老师安排的复习任务。",
  "我重视平时复习，考试前不会特别慌乱。",
  "复习时，我会把详细材料变成简要提纲。",
  "学过的知识在脑子里比较有条理，需要时能找到。",
  "复习时我会列成表格或画图，找出知识区别和联系。",
  "我平时没时间复习，通常老师考哪科才复习哪科。",
  "复习时我喜欢把课文全部背下来，但不一定理解结构。",
  "我会随时进行总结、归类、比较分析。",
  "我会针对弱势题型或弱势科目额外训练。",
  "针对最近老师讲的内容，我会及时复习。",
  "复习时我会地毯式全覆盖复习。",
  "复习后我会反复复习以强化记忆。",
];

const examRows = [
  "我常常做考后复盘。",
  "卷子或作业发回后，有错题我会弄清楚为什么错、怎样做才对。",
  "我一般只关心得了多少分，不太关注错在哪里。",
  "我会统计丢分原因，比如粗心、概念不清、审题错误等。",
  "考试后我会思考考试策略，比如如何减少丢分。",
  "考试后我会反思学习方法和习惯，比如投入时间和收获是否匹配。",
];

const statusRows = [
  "我会无缘无故感到疲乏。",
  "我经常出现疲惫乏力的情况。",
  "我经常失眠。",
  "我上课一般精力旺盛。",
  "我上课容易开小差。",
  "我会突然或莫名其妙想哭。",
  "我经常有身体不舒服。",
  "我经常生气或容易生气。",
  "我经常因为情绪原因不能专注学习。",
  "同学关系经常影响我的学习。",
  "我有三个以上比较要好的朋友。",
  "朋友对我的学习有帮助。",
  "自己的烦恼往往无人可以申述。",
  "我在家里不能专注学习。",
  "我在家几乎不主动看书，除了不得不做作业。",
  "我在家写作业总是很慢。",
  "我在家的时候经常莫名烦躁或糟糕。",
  "我觉得父母对我的学习看管太严。",
  "我作业时，父母会经常偷看我。",
  "我觉得父母给我的学习带来了负面影响。",
  "我常常觉得父母会影响我的情绪。",
  "我经常与父母吵架。",
  "父母经常骂我。",
  "我觉得父母的教育方式不适合我。",
  "我在家里很放松，感觉自由。",
  "如果别人不督促我，我很少主动学习。",
  "我对自己的功课感到自豪。",
  "一直以来，我的学习动力比较弱。",
  "我觉得我学习最大的问题就是自律。",
  "游戏、视频、明星或其他爱好对我的学习影响比较大。",
  "我有不喜欢的科目老师，并且影响学习。",
  "我觉得我能够和所有老师保持较好的关系。",
];

const subjectModules = {
  语文: {
    id: "subject-chinese",
    title: "语文专项",
    description: "语文专项会进一步了解阅读、作文、文言文、朗读、积累和复习情况。",
    analysisTarget: "判断语文问题到底来自积累、阅读方法、表达能力、作业态度，还是课外阅读不足。",
    questions: [
      {
        id: "chineseWeakness",
        label: "你觉得语文这个科目的弱项是什么？",
        type: "multi",
        options: ["现代文阅读", "古诗文阅读", "作文", "语言运用", "基础积累", "课外阅读"],
      },
      {
        id: "chineseLostScore",
        label: "语文考试中你失分最多的原因是什么？",
        type: "multi",
        options: ["作文经常得低分", "阅读理解及古诗赏析丢分多", "阅读速度慢", "古文读不懂", "古文不会翻译", "基础部分丢分多", "应用文阅读丢分多"],
      },
      {
        id: "chineseDifficulty",
        label: "是什么让你觉得学习语文困难？",
        type: "multi",
        options: ["语文一般但时间不够", "不喜欢语文", "不喜欢语文老师", "基础太差", "阅读能力差", "记忆力差", "听不懂老师讲课", "父母或同学关系影响"],
      },
      { id: "chinesePreview", label: "你是否会进行语文预习？", type: "single", options: ["是", "否"] },
      {
        id: "chineseClassEffect",
        label: "哪些情况会影响语文上课效果？",
        type: "multi",
        options: ["与同学说话", "走神", "犯困", "听不懂", "不喜欢老师", "同学干扰", "环境吵闹", "对语文没兴趣"],
      },
      {
        id: "chineseHomeworkFocus",
        label: "现在给你做语文作业的认真专注度打分",
        type: "scale",
        minLabel: "不专注",
        maxLabel: "非常专注",
      },
      {
        id: "chineseReading",
        label: "你是否规律安排课外阅读？",
        type: "single",
        options: ["每周有固定时间", "基本不阅读", "想安排但没时间", "不喜欢，一读就困"],
      },
      {
        id: "chineseReflect",
        label: "你会对阅读题进行反思吗？",
        type: "single",
        options: ["经常总结反思", "偶尔做一下", "不会，做完就过了"],
      },
    ],
  },
  数学: {
    id: "subject-math",
    title: "数学专项",
    description: "数学专项会进一步了解失分原因、听懂程度、作业专注、难题处理和额外训练。",
    analysisTarget: "判断数学问题到底来自基础、计算、思维、听课、作业过程、难题处理，还是复盘不足。",
    questions: [
      {
        id: "mathLostScore",
        label: "数学考试中你失分最多的原因是什么？",
        type: "multi",
        options: ["粗心或计算错误", "较难填空题或大题不会做", "最后几道大题后几问没时间", "整张试卷基本靠蒙", "审题错误", "步骤不规范"],
      },
      {
        id: "mathDifficulty",
        label: "是什么让你觉得学习数学困难？",
        type: "multi",
        options: ["数学一般但时间不够", "不喜欢数学", "不喜欢数学老师", "基础太差", "计算能力差", "思维能力弱", "听不懂老师讲课", "父母或同学关系影响"],
      },
      { id: "mathPreview", label: "你是否会进行数学预习？", type: "single", options: ["是", "否"] },
      {
        id: "mathUnderstand",
        label: "数学课整体听懂程度是多少？",
        type: "single",
        options: ["老师讲的基本都能听懂", "大概80%左右", "只能听懂基础部分", "基本听不懂"],
      },
      {
        id: "mathClassEffect",
        label: "哪些情况会影响数学上课效果？",
        type: "multi",
        options: ["与同学说话", "走神", "犯困", "听不清楚", "听不懂", "不喜欢老师", "同学干扰", "环境吵闹", "对数学没兴趣"],
      },
      {
        id: "mathHomeworkFocus",
        label: "现在给你做数学作业的认真专注度打分",
        type: "scale",
        minLabel: "不专注",
        maxLabel: "非常专注",
      },
      {
        id: "mathHardQuestion",
        label: "你遇到数学难题或不会做的题，会怎么处理？",
        type: "multi",
        options: ["跳过不管", "思考一下不会就算了", "反复思考后再处理", "问老师", "直接问软件或搜答案", "先标记，之后再处理"],
      },
      {
        id: "mathExtra",
        label: "除了老师作业，你会额外做练习巩固吗？",
        type: "single",
        options: ["会", "不会", "想做但完全没有时间"],
      },
    ],
  },
  英语: {
    id: "subject-english",
    title: "英语专项",
    description: "英语专项会进一步了解单词、阅读、听力、语法、朗读、复习和作业状态。",
    analysisTarget: "判断英语问题到底来自输入量、单词、语法、阅读速度、听力、朗读习惯，还是作业复盘不足。",
    questions: [
      {
        id: "englishWeakness",
        label: "你觉得英语这个科目的弱项是什么？",
        type: "multi",
        options: ["阅读", "作文", "听力", "语法", "单词", "朗读", "课文熟悉度"],
      },
      {
        id: "englishLostScore",
        label: "英语考试中你失分最多的原因是什么？",
        type: "multi",
        options: ["阅读读不懂句子", "作文错误多", "作文不会写", "单词填写不对", "认错单词意思", "阅读速度慢", "听力部分", "改错或语法部分"],
      },
      {
        id: "englishDifficulty",
        label: "是什么让你觉得学习英语困难？",
        type: "multi",
        options: ["英语一般但时间不够", "不喜欢英语", "不喜欢英语老师", "基础太差", "阅读能力差", "记忆力差", "听不懂老师讲课", "父母或同学关系影响"],
      },
      { id: "englishPreview", label: "你是否会进行英语预习？", type: "single", options: ["是", "否"] },
      {
        id: "englishUnderstand",
        label: "英语课整体听懂程度是多少？",
        type: "single",
        options: ["老师讲的基本都能听懂", "大概80%左右", "只能听懂基础部分", "基本听不懂"],
      },
      {
        id: "englishReadAloud",
        label: "除了学校早读，你会额外安排英语朗读吗？",
        type: "single",
        options: ["规律安排并长期坚持", "想做但没时间", "没有意识", "觉得没必要"],
      },
      {
        id: "englishWords",
        label: "你是否会额外花时间记单词？",
        type: "single",
        options: ["会", "不会"],
      },
      {
        id: "englishReview",
        label: "你会规律复习英语知识、错题或笔记吗？",
        type: "single",
        options: ["会", "不会"],
      },
    ],
  },
};

function buildCoreSteps() {
  return [
    {
      id: "basic",
      title: "基本信息",
      description: "了解你的基本情况、学习阶段和平时成绩。",
      analysisTarget: "建立学生档案，并让后续分析知道学生所处年级、目标和科目基础。",
      questions: [
        { id: "name", label: "你的姓名是？", type: "text", required: true, placeholder: "请输入姓名" },
        { id: "gender", label: "你的性别是？", type: "single", options: ["男", "女", "不想填写"] },
        { id: "age", label: "你的年龄是？", type: "text", placeholder: "例如：14岁" },
        {
          id: "grade",
          label: "你现在读几年级？",
          type: "single",
          required: true,
          options: ["小学", "初一", "初二", "初三", "高一", "高二", "高三", "其他"],
        },
        { id: "school", label: "你所在的学校是？", type: "text", placeholder: "请输入学校名称" },
        {
          id: "stage",
          label: "你目前主要处于哪个学习阶段？",
          type: "single",
          options: ["平时学习", "期中期末备考", "中考备考", "高考备考", "寒暑假提升", "其他"],
        },
        {
          id: "scores",
          label: "请填写你的平时成绩，不需要非常准确，写大概水平即可。",
          type: "scoreTable",
          subjects: subjectNames,
        },
      ],
    },
    {
      id: "core-problem",
      title: "核心事项",
      description: "请给可能影响你学习的问题打分，0表示没有影响，10表示影响非常严重。",
      analysisTarget: "快速定位影响学习的核心因素：动力、环境、关系、基础、能力、方法、作业、心智状态。",
      questions: [
        {
          id: "coreProblemMatrix",
          label: "哪些因素正在阻碍你的进步？",
          type: "scoreMatrix",
          rows: coreProblemRows,
        },
        { id: "coreProblemText", label: "你认为最核心的问题是什么？请用自己的话说明。", type: "textarea" },
      ],
    },
    {
      id: "feeling-env",
      title: "学习环境",
      description: "了解你对学习、环境、父母支持的真实感受。",
      analysisTarget: "判断学习压力、快乐感、主动性、专注度，以及环境和家庭因素是否影响学习。",
      questions: [
        {
          id: "environment",
          label: "你觉得学习环境中有哪些问题？",
          type: "multi",
          options: ["班级学习风气不好", "老师教学方法不适合自己", "不喜欢任课老师", "老师对我不重视", "同学相处困难", "周围环境吵闹", "没有明显问题"],
        },
        {
          id: "parents",
          label: "你对父母在学习上的支持有什么感受？",
          type: "multi",
          options: ["家里气氛不好，无法学习", "父母期望过高，压力大", "父母总拿我和别人比较", "父母没有尽到支持责任", "父母经常批评、吼我", "父母比较理解我", "没有明显问题"],
        },
        { id: "easyScore", label: "你觉得学习轻松还是吃力？", type: "scale", minLabel: "非常吃力", maxLabel: "非常轻松" },
        { id: "happyScore", label: "你觉得学习痛苦还是快乐？", type: "scale", minLabel: "非常痛苦", maxLabel: "非常快乐" },
        { id: "passionScore", label: "你对学习有多大热情？", type: "scale", minLabel: "很不情愿", maxLabel: "很有热情" },
        { id: "focusScore", label: "你学习时有多专注？", type: "scale", minLabel: "很不专注", maxLabel: "非常专注" },
      ],
    },
    {
      id: "plan-strategy",
      title: "计划与策略",
      description: "判断你是否有计划、能否执行、是否会按科目制定策略。",
      analysisTarget: "对应原问卷的计划与策略部分，判断计划能力、执行能力、目标感、手机控制和科目策略意识。",
      questions: [{ id: "planStrategyGrid", label: "请快速判断下面这些说法是否符合你。", type: "yesNoGrid", rows: planRows }],
    },
    {
      id: "class-understanding",
      title: "上课与笔记",
      description: "上课不是只看人在不在教室，而是看是否真正理解、记录、整理和概括。",
      analysisTarget: "判断课堂学习链前半段是否健康：听课、理解、专注、笔记、实验观察、知识概括。",
      questions: [{ id: "classGrid", label: "请判断下面这些课堂学习情况。", type: "yesNoGrid", rows: classRows }],
    },
    {
      id: "homework-errors",
      title: "作业与错题",
      description: "作业和错题最能反映学习是否真正发生。",
      analysisTarget: "判断作业前复习、作业专注、审题、规范、检查、错题整理、反思和课后重做是否完整。",
      questions: [{ id: "homeworkGrid", label: "请判断下面这些作业和错题情况。", type: "yesNoGrid", rows: homeworkRows }],
    },
    {
      id: "review-exam",
      title: "复习巩固",
      description: "复习和考后复盘决定知识能不能真正留住、迁移和减少丢分。",
      analysisTarget: "判断学生是否有复习体系、知识整理能力、弱项强化、试卷归因和考试策略反思。",
      questions: [
        { id: "reviewGrid", label: "复习巩固情况", type: "yesNoGrid", rows: reviewRows },
        { id: "examGrid", label: "考后复盘情况", type: "yesNoGrid", rows: examRows },
      ],
    },
    {
      id: "method-state",
      title: "方法与状态",
      description: "学习问题经常和方法、精力、情绪、家庭、同学、老师关系交织在一起。",
      analysisTarget: "对应原问卷的一般性学习方法、精力、情绪、动力、家庭关系、同学关系、师生关系。",
      sensitive: true,
      questions: [
        {
          id: "generalMethod",
          label: "一般学习方法",
          type: "multi",
          options: ["会总结学习经验", "会反思学习问题", "记忆力不错", "阅读速度较快", "能分解知识要点", "知识在脑子里比较乱", "很少用参考书或工具书", "会尝试背诵和复述"],
        },
        { id: "statusGrid", label: "状态与关系快速判断", type: "yesNoGrid", rows: statusRows },
      ],
    },
    {
      id: "subject-select",
      title: "科目专项",
      description: "选择你最需要深入分析的科目，系统会展开对应专项问卷。",
      analysisTarget: "控制问卷长度，让学生只回答和自己相关的科目专项，同时保留专业深度。",
      questions: [
        {
          id: "weakSubjects",
          label: "你现在最需要帮助的科目是？",
          type: "multi",
          required: true,
          options: subjectNames,
        },
        {
          id: "subjectNote",
          label: "如果有某一科特别想说明，可以写在这里。",
          type: "textarea",
        },
      ],
    },
    {
      id: "final",
      title: "最后补充",
      description: "如果前面的题目还没有说清楚你的问题，可以在这里补充。",
      analysisTarget: "保留开放输入，避免标准题遗漏学生的真实情况。",
      questions: [
        {
          id: "finalSupplement",
          label: "如果以上问题还没有了解到你的情况，请在这里补充说明。",
          type: "textarea",
          placeholder: "可以用语音转文字输入，也可以慢慢写。",
        },
      ],
    },
  ];
}

function buildQuestionnaireSteps(answers) {
  const selected = Array.isArray(answers.weakSubjects) ? answers.weakSubjects : [];
  const subjectSteps = selected
    .filter((subject) => subjectModules[subject])
    .map((subject) => subjectModules[subject]);
  const core = buildCoreSteps();
  const final = core.pop();
  return [...core, ...subjectSteps, final];
}

const profileSections = [
  {
    index: "一",
    title: "学情主诉",
    score: 6.5,
    question: "孩子的学习主要的问题是？",
    finding: "学生已经能说出自己的学习困扰，但问题还需要继续拆到科目、场景和错因。",
    evidence: "来自问卷中的核心事项矩阵、学情陈述和科目专项。",
    explanation:
      "学情主诉关注孩子在学习上的核心问题，也就是找出影响学习生活或心理健康最核心的因素。问题可能来自成长状态、关系问题、学习方法、基础知识和能力发展，也可能是多个因素相互影响。我们需要尽量精准地了解孩子真正被什么卡住，这是后续帮助孩子改变的根本。",
    sources: ["核心事项矩阵", "学情陈述", "学生最后补充说明", "AI追问结果"],
    suggestion: "先不要急着给方案，优先把学生口中的问题拆成科目、场景、时间、原因和影响程度。",
  },
  {
    index: "二",
    title: "心智发展水平",
    score: 6.2,
    question: "孩子当前心理发展水平是否适应学习要求？",
    finding: "孩子能配合学习，但面对挫折、压力和长期任务时稳定性不足。",
    evidence: "来自学习状态、情绪精力、家庭关系、同学关系和问题申述。",
    explanation:
      "心智发展水平可以理解为孩子目前的心理水平和智力水平是否适应当前学习要求。我们会观察认知是否正确、情感是否适当、意志是否合理、态度是否积极、行为是否恰当、适应是否良好。学习是否主动、能否合作、面对挫折如何反应，都会影响学习能不能顺利继续。",
    sources: ["状态与关系快速判断", "学习环境评价", "父母评价", "申述中的情绪线索"],
    suggestion: "如果该项偏低，后续策略要降低任务难度，先建立安全感、稳定感和可完成的小任务。",
  },
  {
    index: "三",
    title: "学习动机",
    score: 6.0,
    question: "孩子的学习动机如何？",
    finding: "学习意愿存在，但更依赖外部压力，内部成就感还不稳定。",
    evidence: "来自学习热情、快乐感、主动性、动力和自律相关题目。",
    explanation:
      "学习动机可以理解为学习的意愿。我们会评估孩子对学习的态度和行为，同时分析为什么会这样。学习动机与个人心理水平、外界关系、成就感和目标感都有关系。这个维度对学习效率影响很大，所以需要单独判断。",
    sources: ["学习热情评分", "学习快乐感评分", "动力与自律题组", "手机/游戏影响题组"],
    suggestion: "不要只用催促解决动力问题，应帮助孩子建立可见的进步证据和可重复的成就感。",
  },
  {
    index: "四",
    title: "知识基础与能力",
    score: 5.7,
    question: "知识储备和能力水平是否具备进一步学习的基础？",
    finding: "部分科目存在前置知识漏洞，尤其是综合题、模型题和错题复现。",
    evidence: "来自平时成绩、科目专项、作业难题处理和考后复盘。",
    explanation:
      "这里关注孩子之前储备的知识和能力，能否支持当下的学习，能否有效理解和运用知识。如果基础不成立，后续学习会变成消耗时间和精力。遇到这种情况，需要谦卑地回到孩子能够学习的部分，重新打基础、训练能力。",
    sources: ["平时成绩矩阵", "各科专项弱项", "作业难题处理", "考试失分原因"],
    suggestion: "如果基础不足，不宜直接拔高；要先回到前置知识，确定孩子能学、会学、能用。",
  },
  {
    index: "五",
    title: "科目学习策略",
    score: 5.8,
    question: "孩子的科目学习策略是否正确？",
    finding: "当前学习方式偏被动，科目之间缺少差异化策略。",
    evidence: "来自计划策略、科目专项和额外训练题目。",
    explanation:
      "选择大于努力。我们需要评估孩子在不同科目上走的方向是否正确。如果路径不对，即使很努力，也可能浪费大量时间和精力。比如英语只背单词但语感和语法没有过关，可能后面仍然读不懂句子。",
    sources: ["计划与策略题组", "语文/数学/英语专项", "额外训练情况", "科目弱项选择"],
    suggestion: "每个科目要给不同策略，不要用同一种学习方式处理所有科目问题。",
  },
  {
    index: "六",
    title: "学习链完整度",
    score: 5.4,
    question: "孩子是否具有相对稳定的知识生产流程？",
    finding: "预习、上课、作业、改错、复习、测试之间没有形成完整闭环。",
    evidence: "来自上课、作业、错题、复习、考后复盘五个流程模块。",
    explanation:
      "学习链就像知识生产线。一个知识从不懂到掌握，需要经过预习、上课、作业、评讲、复习、测试等环节。学习流程环环相扣，任何一环断开，都可能影响最终效果。改善成绩要从根本上完善学习流程细节，而不是只靠更多补课。",
    sources: ["上课与笔记题组", "作业过程题组", "错题处理", "复习巩固", "考后复盘"],
    suggestion: "优先找断点：是预习没有、听课不懂、作业不规范、错题不复测，还是复习测试缺失。",
  },
  {
    index: "七",
    title: "学习秩序与任务处理",
    score: 6.1,
    question: "孩子面对繁杂任务时，是否能持续、有效、有序地学习？",
    finding: "孩子有一定学习意愿，但任务安排、时间管理和反馈机制不够稳定。",
    evidence: "来自计划与策略、作业过程、复习安排和未完成原因。",
    explanation:
      "孩子每天面对多个科目、弱点弱项、改错和疑问，时间和精力有限。我们关注的是孩子能否在众多学习任务中保持持续、有效、有序，而不是被事情推着走。学习计划是重要工具，但核心是学习生活能否长期维持秩序。",
    sources: ["计划执行题组", "未完成原因", "作业速度", "复习安排", "任务反馈"],
    suggestion: "把任务拆小，建立每日反馈，让学习从被动混乱转为持续、有序、可追踪。",
  },
  {
    index: "八",
    title: "学习方法与习惯",
    score: 6.3,
    question: "孩子是否具有提高学习效率的核心方法或素质？",
    finding: "孩子有部分方法意识，但错题复测、总结反思和主动复习还不稳定。",
    evidence: "来自一般学习方法、笔记整理、错题处理、复习和考后复盘。",
    explanation:
      "当基础问题相对稳定后，我们会关注孩子是否具备能提升效率的核心方法或习惯。这些方法可以帮助孩子更轻松地学习，并看到更稳定的成绩改善。它主要体现在学习方法、行为习惯和日常执行细节里。",
    sources: ["一般学习方法题组", "笔记整理", "审题草稿检查", "总结反思", "经验交流"],
    suggestion: "选择一两个最关键习惯训练，例如错题归因、课后重做、笔记整理或复习提纲。",
  },
  {
    index: "九",
    title: "核心能力训练",
    score: 5.9,
    question: "孩子日常学习任务中，是否安排有提高核心能力的关键事项？",
    finding: "核心能力训练还不够明确，需要把数学逻辑、语文分析、英语输入等训练长期化。",
    evidence: "来自科目专项、额外训练、难题处理和学习任务安排。",
    explanation:
      "个人成长并不是随着年级变化自动发生的。真正让孩子持续成长的是刻意训练，尤其是核心能力训练，比如数学逻辑分析、物理情景推演、语文课文分析、英语语感输入等。这些能力需要被安排进日常任务。",
    sources: ["科目专项弱项", "额外强化训练", "难题处理方式", "阅读/表达/逻辑训练记录"],
    suggestion: "把核心能力训练写进计划，例如数学拆题、语文精读、英语朗读、物理画图推演。",
  },
  {
    index: "十",
    title: "情绪精力与关系管理",
    score: 6.4,
    question: "孩子的情绪、精力、人际关系管理如何？",
    finding: "精力、压力、手机和关系因素可能影响晚间学习效率。",
    evidence: "来自状态与关系快速判断、学习环境和父母评价。",
    explanation:
      "情绪、精力和人际关系会随时影响学习状态。如果状态不好，学习效率会下降，也可能导致学习挣扎甚至厌学。很多时候孩子只感到烦躁、拖延、做作业不认真，却不知道原因，因此需要专门分析。",
    sources: ["精力题组", "情绪题组", "家庭关系", "同学关系", "师生关系", "手机游戏影响"],
    suggestion: "如果该项影响明显，先处理睡眠、手机、家庭沟通和情绪压力，再安排高强度学习任务。",
  },
];

const strategySubjects = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "政治", "体育"];

const materialItem = (name, description) => ({ name, description, usage: "" });

const subjectStrategyData = {
  语文: {
    diagnosis: "语文学习要先判断问题来自积累、阅读方法、表达能力、课文精读，还是学习动力与专注状态。",
    strategy:
      "如果基础薄弱，先把课文精读、文言诗词朗读、阅读方法和作文表达拆成固定任务。语文不能只靠刷题，要建立朗读、理解、分析、表达、修改的闭环。",
    materials: [
      materialItem("语文课本", "用于课文精读、字词积累、文言文和古诗词背诵，是语文基础训练的核心资料。"),
      materialItem("文言文与古诗词资料", "用于补充背景、注释、翻译和赏析，帮助学生真正理解而不是只背答案。"),
      materialItem("阅读训练资料", "用于训练阅读题思路，重点看问题怎么问、答案从哪里来、和中心思想有什么关系。"),
      materialItem("作文素材本", "用于积累真实事例、细节表达和优秀句段，服务每周作文写改训练。"),
      materialItem("课堂笔记", "用于整理老师讲过的重点、答题方法和易错提醒，帮助课后复盘。"),
    ],
    tasks: [
      {
        title: "每日朗读与积累",
        problem: "文言文、古诗词和语言感觉不足",
        time: "每天早晚任选 15 分钟",
        material: "语文课本、文言文或唐诗宋词资料",
        detail: "先读原文，再看背景和解析。两天背一首，读完后用自己的话说出意思和情感。",
        standard: "能流利朗读，能说出重点词句含义，并完成当天背诵或复述。",
        studentNote: "",
      },
      {
        title: "阅读三问训练",
        problem: "阅读题知道大概意思，但答题思路不清楚",
        time: "每两天 30 分钟",
        material: "阅读训练资料、知识清单",
        detail: "做题后回答三问：为什么这么问？答案思路是什么？答案和中心思想有什么关系？",
        standard: "每篇阅读至少整理 3 个答题规律，并能说清楚答案来源。",
        studentNote: "",
      },
      {
        title: "作文写改一体",
        problem: "作文表达不具体，素材和结构不稳定",
        time: "每周 1 次，写 1 小时，改 1 小时",
        material: "作文纸、优秀作文、个人素材本",
        detail: "先列结构，再写 600 字作文。写完后重点修改开头、事例细节、段落连接和结尾升华。",
        standard: "完成一篇可修改作文，并保留修改痕迹和本周表达收获。",
        studentNote: "",
      },
    ],
  },
  数学: {
    diagnosis: "数学学习要先判断学生是基础概念断点、例题不会迁移、错题不复测，还是考试和书写流程不稳定。",
    strategy:
      "基础差的同学，数学策略首先不是做难题，而是补概念、定义、课本例题和基础题。会听不会做的同学，要强化例题复现、错题归因和三遍做题法。",
    materials: [
      materialItem("数学课本", "用于回到定义、定理、例题和课后基础题，基础差的学生必须先把课本弄清楚。"),
      materialItem("课堂笔记", "用于复习老师强调的题型、步骤和易错点，避免课后只凭印象做题。"),
      materialItem("王后雄教材全解", "用于看例题解析、知识点讲解和对应练习，帮助学生从听懂走向会做。"),
      materialItem("错题本", "用于记录错因、正确做法和复测时间，重点服务三遍做题法。"),
      materialItem("单元测试卷", "用于检测一个单元是否真正过关，并发现下一轮补弱点。"),
    ],
    tasks: [
      {
        title: "概念定义补强",
        problem: "上课听懂，但自己做题时不知道用哪个知识点",
        time: "每天 25-30 分钟",
        material: "数学课本、课堂笔记、王后雄教材全解",
        detail: "先读课本定义和定理，再用自己的话解释含义，最后做对应课后基础题。",
        standard: "能说清楚概念意思，能独立完成对应基础题，并标记不懂处。",
        studentNote: "",
      },
      {
        title: "例题复现与迁移",
        problem: "例题看懂了，但换一道题不会做",
        time: "每次学习 30 分钟",
        material: "王后雄教材全解、课本例题",
        detail: "先自己尝试做例题，再看讲解，最后合上答案独立写一遍完整步骤。",
        standard: "同类例题能独立写出关键步骤，并说明题目关键点。",
        studentNote: "",
      },
      {
        title: "错题三遍做题法",
        problem: "错题改完以后过几天又不会",
        time: "当天、隔天、一周后各复做一次",
        material: "错题本、试卷、作业本",
        detail: "第一遍看懂答案，第二遍独立写步骤，第三遍隔几天重新做并总结错因。",
        standard: "能说出错在哪里、对的方法是什么、下次怎么避免。",
        studentNote: "",
      },
    ],
  },
  英语: {
    diagnosis: "英语学习要判断问题来自语感、词汇、语法、课文熟练度、阅读输入，还是听写和翻译训练不足。",
    strategy:
      "英语基础差时，先建立朗读、单词、课文、语法和泛读的稳定输入。不要只背单词或只刷题，要通过反复朗读和听写形成语感。",
    materials: [
      materialItem("英语课本", "用于课文朗读、句子熟悉、重点短语和课文听写，是建立语感的核心资料。"),
      materialItem("课文音频", "用于跟读、听写和纠正发音，帮助学生把文字输入变成声音输入。"),
      materialItem("单词表", "用于每日词汇循环，重点记录不会读、不会拼、不会用的词。"),
      materialItem("无敌英语语法", "用于一周一章梳理语法规则，再配合基础练习巩固。"),
      materialItem("泛读材料", "用于扩大阅读输入，例如英语报、绘本、新概念或适合水平的短文。"),
    ],
    tasks: [
      {
        title: "课文朗读与语感建立",
        problem: "读不顺、语感弱、句子不熟",
        time: "每天 30 分钟",
        material: "英语课本、课文音频",
        detail: "张口大声读。重点课文反复朗读，配合听写和翻译，逐步形成语感。",
        standard: "能流利朗读课文，能听写关键句，并说出主要意思。",
        studentNote: "",
      },
      {
        title: "每日单词循环",
        problem: "词汇量不足，阅读和写作受影响",
        time: "每天 15-20 分钟",
        material: "初中单词表、错词本",
        detail: "每天背 20 个单词，新词和旧词循环复习，错词单独记录。",
        standard: "当天能默写，三天后复查仍能认读和拼写。",
        studentNote: "",
      },
      {
        title: "语法一章一清",
        problem: "语法知识零散，做题靠感觉",
        time: "每周 1 章",
        material: "无敌英语语法、课堂笔记",
        detail: "先看本章核心规则，再做基础练习，错题整理成规则提醒。",
        standard: "能讲清本章语法规则，并完成对应基础题。",
        studentNote: "",
      },
    ],
  },
  物理: {
    diagnosis: "物理学习要判断问题来自概念理解、模型建构、公式使用、画图分析，还是题目条件和过程分析不足。",
    strategy:
      "物理基础薄弱时，先把概念、现象、公式意义和模型图讲清楚。做题时要训练画图、找条件、列公式、解释过程，而不是直接套答案。",
    materials: [
      materialItem("物理课本", "用于理解概念、实验现象、公式含义和基础例题，避免只套公式。"),
      materialItem("课堂笔记", "用于整理模型、图像、实验和老师强调的分析流程。"),
      materialItem("王后雄教材全解", "用于补充概念解释、例题步骤和知识点之间的联系。"),
      materialItem("必刷题或专项练习", "用于从基础题到提升题分层训练，重点突破同类题。"),
      materialItem("错题本", "用于记录错因、画图过程、公式选择错误和复测安排。"),
    ],
    tasks: [
      {
        title: "概念和现象解释",
        problem: "概念听过，但不知道它说明什么",
        time: "每天 20-25 分钟",
        material: "物理课本、课堂笔记",
        detail: "读概念后，用自己的话解释它描述的现象，并举一个生活例子。",
        standard: "能说清概念、单位、公式含义和适用场景。",
        studentNote: "",
      },
      {
        title: "画图建模训练",
        problem: "题目条件多时不会分析过程",
        time: "每次作业前 10 分钟",
        material: "物理题、草稿本",
        detail: "遇到力学、电学等题目，先画图，再标已知量、未知量和关系。",
        standard: "每道重点题都有图、有条件标记、有公式来源。",
        studentNote: "",
      },
      {
        title: "专项题三遍做法",
        problem: "同类题反复错，迁移能力弱",
        time: "每周 2-3 次",
        material: "必刷题、专项练习、错题本",
        detail: "基础题先过关，再做提升题。错题当天弄懂，隔天复做，一周后再测。",
        standard: "同类题正确率明显提高，并能说出题型关键条件。",
        studentNote: "",
      },
    ],
  },
  化学: {
    diagnosis: "化学学习要判断学生是概念不清、方程式不过关、实验现象记不住，还是计算和推断题流程不稳定。",
    strategy:
      "化学基础薄弱时，先处理元素符号、化学式、方程式、实验现象和基础概念。再通过典型题训练推断、计算和实验分析，不要一上来只刷综合题。",
    materials: [
      materialItem("化学课本", "用于理解概念、实验、物质性质和方程式来源，是最重要的基础资料。"),
      materialItem("课堂笔记", "用于整理老师强调的实验现象、易错概念和题型方法。"),
      materialItem("方程式清单", "用于每日默写、配平和应用训练，帮助学生形成基础反应库。"),
      materialItem("实验与推断专项", "用于训练现象判断、物质推断和实验步骤分析。"),
      materialItem("错题本", "用于记录概念混淆、方程式错误、计算错误和推断断点。"),
    ],
    tasks: [
      {
        title: "方程式每日过关",
        problem: "方程式不会写、不会配平或不会应用",
        time: "每天 15-20 分钟",
        material: "方程式清单、化学课本",
        detail: "每天默写一组核心方程式，写出反应条件、现象和应用场景。",
        standard: "能独立写对并配平，能说出对应实验现象。",
        studentNote: "",
      },
      {
        title: "实验现象整理",
        problem: "实验题记不住现象，推断题没有线索",
        time: "每周 2 次，每次 25 分钟",
        material: "课本实验、课堂笔记",
        detail: "按物质、现象、结论整理实验，重点写清为什么能得出这个结论。",
        standard: "能根据现象反推物质或反应，并说明判断依据。",
        studentNote: "",
      },
    ],
  },
  生物: {
    diagnosis: "生物学习要判断问题来自概念零散、图表不会看、实验题不会分析，还是背诵和理解没有结合。",
    strategy:
      "生物不能只死记硬背，要把概念、结构图、过程图和实验分析联系起来。基础差的学生先建立章节框架，再做图文互译和关键词表达。",
    materials: [
      materialItem("生物课本", "用于建立概念、结构图和生命过程的基础理解。"),
      materialItem("课堂笔记", "用于整理老师强调的关键词、图示和实验结论。"),
      materialItem("知识框架图", "用于把零散知识连成结构，帮助复习时快速定位。"),
      materialItem("实验题专项", "用于训练变量、对照、结论和表达规范。"),
      materialItem("错题本", "用于记录概念混淆、图表误读和表达不规范。"),
    ],
    tasks: [
      {
        title: "章节框架整理",
        problem: "知识点很多，脑子里比较散",
        time: "每周 2 次，每次 30 分钟",
        material: "生物课本、知识框架图",
        detail: "每学完一节，用关键词画出结构图，再用自己的话讲一遍。",
        standard: "能看着框架说清本节核心概念和关系。",
        studentNote: "",
      },
      {
        title: "图表理解训练",
        problem: "看到结构图、曲线图不知道怎么分析",
        time: "每周 2 次，每次 20 分钟",
        material: "课本图表、练习题",
        detail: "先说图中对象，再说变化关系，最后写出结论和依据。",
        standard: "能用规范语言解释图表表达的信息。",
        studentNote: "",
      },
    ],
  },
  历史: {
    diagnosis: "历史学习要判断问题来自时间线混乱、事件因果不清、材料题不会提取信息，还是背了但不会用。",
    strategy:
      "历史基础差时，先建立时间线和事件因果链。材料题训练要从材料关键词、设问方向和课本知识三者结合，而不是只背结论。",
    materials: [
      materialItem("历史课本", "用于掌握基本事件、人物、时间、影响和历史结论。"),
      materialItem("时间轴资料", "用于把朝代、事件和阶段特征串起来，减少混乱。"),
      materialItem("课堂笔记", "用于整理老师强调的因果关系和材料题方法。"),
      materialItem("材料题专项", "用于训练从材料中找关键词、概括观点和联系课本。"),
      materialItem("错题本", "用于记录时间混淆、概念混淆和材料理解错误。"),
    ],
    tasks: [
      {
        title: "时间线与因果链",
        problem: "事件背过但顺序和因果关系不清楚",
        time: "每周 2 次，每次 30 分钟",
        material: "历史课本、时间轴资料",
        detail: "按时间顺序整理事件，并写出背景、经过、影响三个关键词。",
        standard: "能说清事件前后关系和主要影响。",
        studentNote: "",
      },
      {
        title: "材料题关键词训练",
        problem: "材料题看得懂，但不知道怎么答",
        time: "每周 2 次，每次 25 分钟",
        material: "材料题专项、课堂笔记",
        detail: "先圈材料关键词，再判断设问方向，最后联系课本知识组织答案。",
        standard: "答案能包含材料信息、课本知识和清楚结论。",
        studentNote: "",
      },
    ],
  },
  政治: {
    diagnosis: "政治学习要判断问题来自概念不熟、观点不会迁移、材料题不会分层，还是答题语言不规范。",
    strategy:
      "政治学习要把核心观点、材料分析和规范表达结合起来。基础薄弱时，先背清关键词和观点，再练习用观点解释材料。",
    materials: [
      materialItem("政治课本", "用于掌握核心概念、观点和规范表述。"),
      materialItem("课堂笔记", "用于整理老师强调的答题角度和关键词。"),
      materialItem("时政材料", "用于训练用课本观点分析现实问题。"),
      materialItem("材料题专项", "用于训练审题、分层、观点匹配和表达。"),
      materialItem("错题本", "用于记录观点遗漏、材料没用上和表达不规范。"),
    ],
    tasks: [
      {
        title: "观点关键词过关",
        problem: "知识点背得模糊，答题写不到点上",
        time: "每天 10-15 分钟",
        material: "政治课本、课堂笔记",
        detail: "每天整理一组核心观点，背关键词，并用一句自己的话解释。",
        standard: "能准确说出观点关键词，并知道适用情境。",
        studentNote: "",
      },
      {
        title: "材料分层答题",
        problem: "材料题不会结合材料，答案空泛",
        time: "每周 2 次，每次 25 分钟",
        material: "材料题专项、时政材料",
        detail: "先把材料分层，再为每层匹配课本观点，最后写成规范答案。",
        standard: "答案有观点、有材料、有分析，不只堆概念。",
        studentNote: "",
      },
    ],
  },
  体育: {
    diagnosis: "体育训练要判断问题来自体能基础、专项动作、训练频率、恢复睡眠，还是考试项目技巧不熟。",
    strategy:
      "体育提升要建立规律训练和恢复机制。基础薄弱的学生先做低强度、可坚持的体能任务，再逐步加入专项技术和测试模拟。",
    materials: [
      materialItem("体育考试项目标准", "用于明确项目要求、评分标准和训练目标。"),
      materialItem("训练记录表", "用于记录每天训练内容、成绩、身体感受和恢复情况。"),
      materialItem("专项动作视频", "用于观察动作细节，例如跑步姿势、跳绳节奏、跳远摆臂等。"),
      materialItem("体能训练清单", "用于安排力量、耐力、柔韧和协调训练。"),
      materialItem("测试成绩表", "用于记录阶段测试成绩，判断训练是否有效。"),
    ],
    tasks: [
      {
        title: "基础体能打底",
        problem: "体能弱，训练一会儿就累",
        time: "每周 4 次，每次 20-30 分钟",
        material: "体能训练清单、训练记录表",
        detail: "先做慢跑、核心力量、拉伸和基础协调训练，强度逐步增加。",
        standard: "能稳定完成训练，并记录心率、疲劳感或完成情况。",
        studentNote: "",
      },
      {
        title: "考试项目专项训练",
        problem: "体能有一点基础，但考试项目动作和节奏不稳定",
        time: "每周 3 次，每次 20 分钟",
        material: "体育考试项目标准、专项动作视频",
        detail: "选择一个考试项目，拆成动作要点、节奏训练和模拟测试三步。",
        standard: "专项成绩有记录，动作问题能被具体指出并改进。",
        studentNote: "",
      },
    ],
  },
};

function createSubjectWorkspace(subject) {
  const data = subjectStrategyData[subject];
  return {
    strategy: data.strategy,
    strategySuggestion: "点击“生成AI策略建议”后，这里会结合学情画像、学情陈述和当前科目，生成一份可以选择接受或重新生成的学习策略。",
    acceptedStrategy: "",
    studentStrategy: "",
    materials: data.materials.map((item, index) => ({ ...item, id: `${subject}-material-${index}` })),
    customMaterials: [
      {
        id: `${subject}-custom-material-0`,
        name: "",
        purpose: "",
        usage: "",
      },
    ],
    tasks: data.tasks.map((task, index) => ({ ...task, id: `${subject}-task-${index}` })),
    aiNote: "AI建议会根据学情画像、申述记录和当前科目内容生成。",
  };
}

const defaultAnswers = {
  name: "张同学",
  grade: "初三",
  stage: "中考备考",
  weakSubjects: ["语文", "数学", "英语"],
  easyScore: 4,
  happyScore: 5,
  passionScore: 5,
  focusScore: 6,
  coreProblemText: "我上课好像能听懂，但是自己做题经常卡住，错题改完以后过几天又不会。",
};

const weekDays = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];

const hourOptions = Array.from({ length: 19 }, (_, index) => String(index + 5).padStart(2, "0"));
const minuteOptions = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));

const defaultPlanRows = [
  { id: "plan-row-1", cells: { 星期一: { start: "19:30", end: "20:10", task: "数学错题复测", note: "用三遍做题法" } } },
  { id: "plan-row-2", cells: { 星期一: { start: "20:20", end: "21:00", task: "英语朗读与单词", note: "朗读后听写关键词" } } },
  { id: "plan-row-3", cells: { 星期一: { start: "21:10", end: "21:25", task: "每日反思", note: "记录√、!、×" } } },
];

function createWeekCells(seed = {}) {
  return Object.fromEntries(
    weekDays.map((day) => [
      day,
      {
        start: seed[day]?.start || "19:00",
        end: seed[day]?.end || "19:30",
        task: seed[day]?.task || "",
        note: seed[day]?.note || "",
      },
    ])
  );
}

function normalizePlanRows(rows) {
  return rows.map((row) => ({ ...row, cells: createWeekCells(row.cells) }));
}

function createFocusRows(type, options) {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `${type}-${index + 1}`,
    enabled: index === 0,
    item: options[index],
    custom: "",
    scores: Object.fromEntries(["星期一", "星期二", "星期三", "星期四", "星期五"].map((day) => [day, ""])),
  }));
}

const methodTrainingOptions = [
  "自定义训练",
  "三遍做题法",
  "费曼讲解法",
  "错题归因复测",
  "睡前过电影",
  "课后凭记忆重做例题",
  "阅读三问训练",
  "知识框架整理",
  "限时训练",
  "试卷失分统计",
  "每日任务复盘",
];

const habitTrainingOptions = [
  "自定义习惯",
  "每天固定时间开始学习",
  "学习前准备好资料",
  "手机远离学习区",
  "先复习再作业",
  "每天记录√、!、×",
  "不会题先标记再处理",
  "每45分钟短休息",
  "书桌保持清空",
  "睡前整理明日任务",
  "周五整理未完成任务",
];

const scoreOptions = ["", ...Array.from({ length: 10 }, (_, index) => String(index + 1))];

const dailyReflectionRows = [
  "回味：今天上课老师讲了什么知识，我可以仔细回忆每一个细节吗？",
  "今天自主学习的任务我做得怎么样？我还可以做得更好吗？",
  "今天上课效果如何，有需要改善的地方吗？",
  "今天时间安排怎么样，零碎时间是否利用得更好？",
  "我今天过得快乐吗？",
];

const weeklyProblemRows = [
  "本周学习中所遇到的问题",
  "你觉得怎么办比较好呢？",
];

const weeklyStateRows = [
  "这一周的心情评分",
  "这一周的睡眠情况评分",
  "这一周的师生同学关系评分",
  "这一周的家庭关系评分",
];

const weeklyDiscussionRows = [
  "本周学习计划的任务完成度评分及原因",
  "这一周在学习行为和心态上有什么改善？",
  "学习方法或细节上有哪些可以优化的地方？",
  "学习任务安排是否合理，是否需要优化？",
  "这一周的学习热情、学习动力和学习情绪状态如何？",
];

const mistakeSubjects = ["数学", "语文", "英语", "物理", "化学", "生物", "历史", "政治", "地理"];

const mistakeQuickTasks = {
  analyzeMistake: {
    label: "AI分析错题",
    prompt: "请帮我分析上传的错题。请识别题目内容，指出对应知识点、错误类型、错因、正确解题思路、以后遇到同类题的判断方法，并给出后续训练建议。",
  },
  generateSimilar: {
    label: "AI生成类似题",
    prompt: "请根据我上传或选择的错题，生成1-3道同类型训练题。每道题需要有题目、答案、详细解析、训练目的，并说明它和原错题相似在哪里。",
  },
  analyzePaper: {
    label: "AI分析试卷",
    prompt: "请分析我上传的试卷或作业材料。请整理错题清单、薄弱知识点、错误类型、解题方法缺口、优先训练顺序，并给出后续复习建议。",
  },
};

const defaultKnowledgePromptTemplate = `超精细教育信息图 [SUBJECT]，
科学教科书插画风格，
干净的学术学习版式，
高度整理的学习笔记美学，
带有虚线引导的结构注释图，
物体周围带有多个教育说明标签，
适合学生阅读的清晰视觉层级，
教材风格，
科学课堂海报设计，
教育用途的结构注释与组件标注，
手写笔记感与现代信息图设计结合，
适合学生理解的可视化讲解，
分步骤结构拆解，
悬浮式标签与指示箭头，
点状连接虚线，
精准的科学可视化表现，
居中构图，
纯白干净背景，
柔和粉彩配色，
高可读性，
现代教育出版物风格，
干净留白边距，
3D 科学渲染，
Octane Render 渲染风格，
次表面散射（Subsurface Scattering），
超高细节纹理，
电影级灯光，
视觉化学习设计，
教育海报美学。`;

const defaultMistakes = [
  {
    id: "mistake-1",
    title: "数学二次函数综合题",
    subject: "数学",
    source: "月考试卷",
    fileName: "月考数学错题.jpg",
    type: "图片",
    reason: "函数图像与几何条件结合时，关键点坐标没有先列出来。",
    method: "先画图，标关键点，再列函数表达式和几何关系。",
    date: "今天",
    previewUrl: "",
  },
  {
    id: "mistake-2",
    title: "英语阅读长难句",
    subject: "英语",
    source: "周练阅读",
    fileName: "英语阅读错题.pdf",
    type: "PDF",
    reason: "句子主干没有先找出来，导致选项判断靠感觉。",
    method: "先划主谓宾，再看修饰成分和转折词。",
    date: "昨天",
    previewUrl: "",
  },
];

function escapeSvgText(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildKnowledgeNote(question) {
  const raw = question.trim() || "细胞结构";
  const isCell = /细胞|细胞核|细胞质|细胞膜/.test(raw);
  const title = isCell ? "动物细胞三维结构图" : `${raw}严谨知识讲解图`;
  const subtitle = isCell ? "用结构标注、功能解释和总结区，帮助学生把细胞当成一个完整生命系统来理解" : "把一个知识问题拆成结构、关系、应用、易错点和记忆线索";
  const points = isCell
    ? [
        ["细胞膜", "包围细胞，保护内部结构，并控制物质进出"],
        ["细胞质", "充满细胞内部，是多种生命活动发生的半流体环境"],
        ["细胞核", "储存遗传物质，是细胞生命活动的控制中心"],
        ["核膜", "双层膜结构，把细胞核与细胞质分隔开"],
        ["核孔", "实现细胞核与细胞质之间的物质交换"],
        ["核仁", "与核糖体的形成有关，参与蛋白质合成准备"],
        ["线粒体", "进行有氧呼吸，为细胞活动产生ATP"],
        ["粗面内质网", "表面附着核糖体，参与蛋白质合成、加工和运输"],
        ["核糖体", "合成蛋白质的场所，可附着在内质网上或游离存在"],
        ["高尔基体", "对蛋白质进行加工、分类和包装，并参与分泌"],
        ["溶酶体", "含有水解酶，分解衰老、损伤的细胞结构和大分子物质"],
        ["细胞骨架", "维持细胞形态，支持细胞结构，并参与细胞运动和运输"],
        ["中心体", "由两个中心粒组成，参与细胞分裂时纺锤体的形成"],
      ]
    : [
        ["核心定义", `先说明${raw}是什么、解决什么问题、在哪个知识单元出现`],
        ["组成结构", "拆成可以观察、比较或推理的组成部分"],
        ["关键关系", "说明原因、条件、过程、结果之间的联系"],
        ["典型应用", "给出考试或生活情境中的使用方式"],
        ["易错提醒", "指出相似概念、常见误判和容易漏写的步骤"],
        ["记忆线索", "用图像、对比、关键词或口诀帮助长期记忆"],
      ];

  const prompt = [
    `请为中学生生成一张严谨、丰富、专业的知识讲解图片，主题是「${raw}」。`,
    "画面要求：不是简单卡片，不是空泛插画，而是教材级信息图海报。",
    "主体要求：中央必须有清晰、精致、层次丰富的主体结构图，必要时使用3D质感、剖面结构或流程结构。",
    "标注要求：左右两侧用标注线连接关键结构，每个标注包含“名称 + 一句话功能解释”。",
    "讲解要求：底部增加“功能总览 / 知识总结”区域，用表格或项目符号总结核心作用。",
    "文字要求：中文清晰准确，适合初中或高中学生理解，避免概念错误和过度简化。",
    "风格要求：深色学术背景、高清质感、排版稳重，整体类似专业教材插图或科普海报。",
    "输出要求：可下载保存的高清知识图片，画面信息丰富但层级清楚。",
  ].join("\n");

  const wrapLine = (text, max = 15) => {
    const clean = String(text);
    const first = clean.slice(0, max);
    const second = clean.slice(max, max * 2);
    return [first, second].filter(Boolean);
  };

  const infoLabel = ({ x, y, tx, ty, name, desc, side = "left" }) => {
    const anchor = side === "right" ? "end" : "start";
    const elbow = side === "right" ? x - 32 : x + 32;
    const textX = side === "right" ? x - 8 : x + 8;
    const descLines = wrapLine(desc, 16);
    return `
      <g font-family="Microsoft YaHei, Arial, sans-serif">
        <path d="M${tx} ${ty} L${elbow} ${y} H${x}" fill="none" stroke="#b9d9f4" stroke-width="2" opacity="0.95"/>
        <circle cx="${tx}" cy="${ty}" r="4" fill="#9ee7ff"/>
        <text x="${textX}" y="${y - 8}" text-anchor="${anchor}" font-size="21" font-weight="900" fill="#f3fbff">${escapeSvgText(name)}</text>
        ${descLines
          .map(
            (line, index) =>
              `<text x="${textX}" y="${y + 18 + index * 24}" text-anchor="${anchor}" font-size="15" font-weight="700" fill="#c8d7e4">${escapeSvgText(line)}</text>`
          )
          .join("")}
      </g>`;
  };

  const summaryItems = points
    .slice(0, isCell ? 10 : 6)
    .map(([name, desc], index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const x = 530 + col * 230;
      const y = 1042 + row * 46;
      return `<text x="${x}" y="${y}" font-size="16" font-weight="700" fill="#dce9f7" font-family="Microsoft YaHei, Arial, sans-serif">· ${escapeSvgText(name)}：${escapeSvgText(desc.slice(0, 13))}</text>`;
    })
    .join("");

  const cellSvg = `
    <defs>
      <radialGradient id="cellBody" cx="50%" cy="40%" r="62%">
        <stop offset="0%" stop-color="#6bc6ff" stop-opacity="0.5"/>
        <stop offset="52%" stop-color="#2e77b3" stop-opacity="0.5"/>
        <stop offset="100%" stop-color="#112b52" stop-opacity="0.85"/>
      </radialGradient>
      <radialGradient id="nucleus" cx="50%" cy="42%" r="58%">
        <stop offset="0%" stop-color="#f9b8ff"/>
        <stop offset="58%" stop-color="#8d45c6"/>
        <stop offset="100%" stop-color="#472174"/>
      </radialGradient>
      <linearGradient id="mito" x1="0" x2="1">
        <stop offset="0%" stop-color="#ff7a3d"/>
        <stop offset="100%" stop-color="#ffd178"/>
      </linearGradient>
      <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="8" result="blur"/>
        <feMerge>
          <feMergeNode in="blur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>
    <ellipse cx="627" cy="535" rx="350" ry="318" fill="url(#cellBody)" stroke="#8bd4ff" stroke-width="6" opacity="0.94" filter="url(#softGlow)"/>
    <ellipse cx="627" cy="535" rx="310" ry="275" fill="#77c7f3" opacity="0.12" stroke="#d6f4ff" stroke-width="2"/>
    <path d="M470 372 C565 292, 720 326, 768 432 C830 570, 700 680, 562 650 C423 620, 380 466, 470 372Z" fill="url(#nucleus)" stroke="#f0caff" stroke-width="5"/>
    <circle cx="632" cy="505" r="46" fill="#4b1e83" opacity="0.9"/>
    <circle cx="632" cy="505" r="25" fill="#a879e9"/>
    <path d="M430 450 C485 390, 620 380, 742 432 M420 492 C505 435, 640 433, 786 493 M438 536 C538 488, 673 501, 790 558 M470 582 C576 548, 690 558, 768 626" fill="none" stroke="#265fbc" stroke-width="18" stroke-linecap="round" opacity="0.82"/>
    <path d="M430 450 C485 390, 620 380, 742 432 M420 492 C505 435, 640 433, 786 493 M438 536 C538 488, 673 501, 790 558 M470 582 C576 548, 690 558, 768 626" fill="none" stroke="#ff6ac4" stroke-width="3" stroke-dasharray="2 18" stroke-linecap="round"/>
    <path d="M780 650 C840 622, 900 642, 902 690 C904 746, 814 754, 760 726 C714 702, 724 676, 780 650Z" fill="#e85b85" stroke="#ffabc1" stroke-width="5"/>
    <path d="M790 674 C826 654, 870 660, 876 690 M776 706 C820 684, 874 704, 890 722" stroke="#ffc3d2" stroke-width="8" stroke-linecap="round" fill="none"/>
    <g>
      <ellipse cx="875" cy="318" rx="68" ry="34" fill="url(#mito)" stroke="#ffb06f" stroke-width="4" transform="rotate(18 875 318)"/>
      <path d="M828 317 C850 300, 866 334, 888 316 C900 306, 915 317, 929 306" fill="none" stroke="#8d3418" stroke-width="5" stroke-linecap="round"/>
      <ellipse cx="384" cy="694" rx="70" ry="34" fill="url(#mito)" stroke="#ffb06f" stroke-width="4" transform="rotate(13 384 694)"/>
      <path d="M338 692 C358 674, 378 710, 400 690 C414 678, 430 692, 442 682" fill="none" stroke="#8d3418" stroke-width="5" stroke-linecap="round"/>
      <ellipse cx="356" cy="395" rx="58" ry="29" fill="url(#mito)" stroke="#ffb06f" stroke-width="4" transform="rotate(-20 356 395)"/>
    </g>
    <g fill="#5fd1ff" opacity="0.86">
      <circle cx="303" cy="526" r="18"/><circle cx="875" cy="482" r="19"/><circle cx="826" cy="775" r="23"/><circle cx="461" cy="778" r="14"/>
    </g>
    <g fill="#ff7ccb" opacity="0.82">
      <circle cx="768" cy="362" r="9"/><circle cx="530" cy="708" r="8"/><circle cx="715" cy="704" r="8"/><circle cx="425" cy="540" r="7"/><circle cx="695" cy="445" r="7"/>
    </g>
    <g transform="translate(610 770) rotate(-8)">
      <rect x="-38" y="-9" width="76" height="18" rx="9" fill="#f8bf42" stroke="#ffe29a" stroke-width="3"/>
      <rect x="-8" y="-38" width="18" height="76" rx="9" fill="#f8bf42" stroke="#ffe29a" stroke-width="3" transform="rotate(90)"/>
    </g>
    <path d="M352 736 C430 812, 590 825, 704 793 C815 761, 906 695, 936 578" fill="none" stroke="#ffd26b" stroke-width="2" opacity="0.5"/>
    <path d="M298 480 C345 338, 492 244, 660 248 C778 250, 892 314, 946 422" fill="none" stroke="#d7f7ff" stroke-width="2" opacity="0.45"/>
    ${infoLabel({ x: 95, y: 190, tx: 350, ty: 298, name: "细胞膜", desc: points[0][1] })}
    ${infoLabel({ x: 95, y: 310, tx: 370, ty: 510, name: "细胞质", desc: points[1][1] })}
    ${infoLabel({ x: 95, y: 430, tx: 520, ty: 418, name: "核膜", desc: points[3][1] })}
    ${infoLabel({ x: 95, y: 550, tx: 505, ty: 520, name: "核孔", desc: points[4][1] })}
    ${infoLabel({ x: 95, y: 670, tx: 632, ty: 505, name: "核仁", desc: points[5][1] })}
    ${infoLabel({ x: 95, y: 790, tx: 560, ty: 585, name: "细胞核", desc: points[2][1] })}
    ${infoLabel({ x: 1158, y: 190, tx: 875, ty: 318, name: "线粒体", desc: points[6][1], side: "right" })}
    ${infoLabel({ x: 1158, y: 310, tx: 770, ty: 493, name: "粗面内质网", desc: points[7][1], side: "right" })}
    ${infoLabel({ x: 1158, y: 430, tx: 695, ty: 445, name: "核糖体", desc: points[8][1], side: "right" })}
    ${infoLabel({ x: 1158, y: 550, tx: 838, ty: 674, name: "高尔基体", desc: points[9][1], side: "right" })}
    ${infoLabel({ x: 1158, y: 670, tx: 826, ty: 775, name: "溶酶体", desc: points[10][1], side: "right" })}
    ${infoLabel({ x: 1158, y: 790, tx: 705, ty: 793, name: "细胞骨架", desc: points[11][1], side: "right" })}
    ${infoLabel({ x: 95, y: 900, tx: 610, ty: 770, name: "中心体", desc: points[12][1] })}`;

  const genericLabels = points
    .map(([name, desc], index) => {
      const leftSide = index % 2 === 0;
      const y = 260 + index * 95;
      return infoLabel({
        x: leftSide ? 100 : 1158,
        y,
        tx: leftSide ? 520 : 735,
        ty: 405 + Math.sin(index) * 140,
        name,
        desc,
        side: leftSide ? "left" : "right",
      });
    })
    .join("");

  const genericSvg = `
    <defs>
      <radialGradient id="conceptGlow" cx="50%" cy="50%" r="60%">
        <stop offset="0%" stop-color="#e7fff7"/>
        <stop offset="48%" stop-color="#58b98d"/>
        <stop offset="100%" stop-color="#163a32"/>
      </radialGradient>
    </defs>
    <circle cx="627" cy="535" r="225" fill="#123331" stroke="#89e6d2" stroke-width="3" opacity="0.95"/>
    <circle cx="627" cy="535" r="165" fill="url(#conceptGlow)" opacity="0.88"/>
    <text x="627" y="506" text-anchor="middle" font-size="44" font-weight="900" fill="#041816" font-family="Microsoft YaHei, Arial, sans-serif">${escapeSvgText(raw.slice(0, 9))}</text>
    <text x="627" y="558" text-anchor="middle" font-size="22" font-weight="900" fill="#0b3029" font-family="Microsoft YaHei, Arial, sans-serif">结构 · 关系 · 应用 · 易错</text>
    <path d="M430 410 C520 330, 744 330, 824 420 M430 660 C540 755, 734 748, 824 650" fill="none" stroke="#c7fff0" stroke-width="3" opacity="0.6"/>
    ${genericLabels}`;

  const visualBody = isCell ? cellSvg : genericSvg;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254">
    <defs>
      <linearGradient id="posterBg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stop-color="#061426"/>
        <stop offset="48%" stop-color="#0b2138"/>
        <stop offset="100%" stop-color="#06101d"/>
      </linearGradient>
    </defs>
    <rect width="1254" height="1254" fill="url(#posterBg)"/>
    <circle cx="310" cy="220" r="120" fill="#123b61" opacity="0.22"/>
    <circle cx="1040" cy="860" r="180" fill="#144b72" opacity="0.18"/>
    <text x="627" y="86" text-anchor="middle" font-size="48" font-weight="900" fill="#f7fbff" font-family="Microsoft YaHei, Arial, sans-serif">${escapeSvgText(title)}</text>
    <text x="627" y="124" text-anchor="middle" font-size="18" font-weight="700" fill="#b9d9f4" font-family="Microsoft YaHei, Arial, sans-serif">${escapeSvgText(subtitle.slice(0, 48))}</text>
    ${visualBody}
    <rect x="82" y="1014" width="1090" height="160" rx="8" fill="#0d2038" stroke="#8eb8d9" stroke-width="2" opacity="0.96"/>
    <rect x="82" y="1014" width="174" height="160" rx="8" fill="#123a62" stroke="#8eb8d9" stroke-width="2"/>
    <text x="169" y="1078" text-anchor="middle" font-size="27" font-weight="900" fill="#f7fbff" font-family="Microsoft YaHei, Arial, sans-serif">功能总览</text>
    <text x="169" y="1120" text-anchor="middle" font-size="22" font-weight="900" fill="#d8efff" font-family="Microsoft YaHei, Arial, sans-serif">知识总结</text>
    ${summaryItems}
    <text x="627" y="1215" text-anchor="middle" font-size="15" font-weight="700" fill="#83a6c7" font-family="Microsoft YaHei, Arial, sans-serif">树子AI知识笔记 · 严谨结构图 + 标注解释 + 学习总结</text>
  </svg>`;

  return { title, subtitle, points, svg, prompt };
}

function App() {
  const [activePage, setActivePage] = useState("home");
  const [member, setMember] = useState({
    isLoggedIn: false,
    isPaid: false,
    identifier: "",
    provider: "用户名",
    plan: "",
    ltBalance: 0,
    storageTotalMb: 50,
  });
  const [billingConfig, setBillingConfig] = useState({
    memberPlans: defaultMemberPlans,
    tokenPackages: defaultTokenPackages,
  });
  const [accountNotice, setAccountNotice] = useState("");
  const [aiNotice, setAiNotice] = useState({ page: "", message: "" });
  const [authModal, setAuthModal] = useState({
    open: false,
    actionName: "",
    message: "",
  });
  const [authForm, setAuthForm] = useState({
    mode: "register",
    username: "",
    displayName: "",
    password: "",
    confirmPassword: "",
  });
  const [memberCenter, setMemberCenter] = useState({
    loading: false,
    message: "",
    data: null,
    displayName: "",
    oldPassword: "",
    newPassword: "",
  });
  const [adminPanel, setAdminPanel] = useState({
    token: "",
    username: "树子AI",
    password: "",
    isLoggedIn: false,
    message: "",
    users: [],
    orders: [],
    orderNote: "",
    identifier: "",
    planId: "monthly",
    membershipStartDate: new Date().toISOString().slice(0, 10),
    paidAmount: "",
    tokenAmount: "10000",
  });
  const [checkout, setCheckout] = useState({
    planId: "",
    tokenPackageId: "",
    customTokenAmount: "",
    showQr: false,
    message: "",
  });
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState(defaultAnswers);
  const [submitted, setSubmitted] = useState(false);
  const [lastSaved, setLastSaved] = useState("尚未保存");
  const [statementText, setStatementText] = useState(
    "我数学上课好像能听懂，但自己做综合题就卡住。错题改完以后过几天又不会，晚上学习效率也比较低。"
  );
  const [statementSubject, setStatementSubject] = useState("数学");
  const [statementScene, setStatementScene] = useState("作业");
  const [statementIntensity, setStatementIntensity] = useState(7);
  const [guidedAnswers, setGuidedAnswers] = useState({
    "你现在最困扰的学习问题是什么？": "数学综合题自己做不出来。",
    "它主要影响哪个科目或哪个学习环节？": "主要影响数学作业和考试。",
  });
  const [statementIssueDetails, setStatementIssueDetails] = useState({});
  const [records, setRecords] = useState([
    {
      id: 1,
      type: "文字申述",
      title: "数学会听不会做",
      content: "错题改完以后过几天又不会，晚上学习效率比较低。",
      time: "今天 10:20",
      subject: "数学",
      scene: "错题",
      intensity: 7,
      tags: ["会听不会做", "错题复测不足"],
    },
  ]);
  const [recordingState, setRecordingState] = useState("idle");
  const [audioUrl, setAudioUrl] = useState("");
  const [aiStatus, setAiStatus] = useState("idle");
  const [aiInsight, setAiInsight] = useState(null);
  const [activeSubject, setActiveSubject] = useState("数学");
  const [strategyWorkspaces, setStrategyWorkspaces] = useState(() =>
    Object.fromEntries(strategySubjects.map((subject) => [subject, createSubjectWorkspace(subject)]))
  );
  const [strategyAiStatus, setStrategyAiStatus] = useState("");
  const [planRows, setPlanRows] = useState(() => normalizePlanRows(defaultPlanRows));
  const [planNote, setPlanNote] = useState("本周先保证每天有明确空闲时间、明确任务和每日反思，不追求任务数量。");
  const [planAiStatus, setPlanAiStatus] = useState("idle");
  const [methodFocusRows, setMethodFocusRows] = useState(() => createFocusRows("method", methodTrainingOptions));
  const [habitFocusRows, setHabitFocusRows] = useState(() => createFocusRows("habit", habitTrainingOptions));
  const [mistakes, setMistakes] = useState(defaultMistakes);
  const [mistakeDraft, setMistakeDraft] = useState({
    title: "新上传学习材料",
    subject: "数学",
    source: "错题/作业/试卷",
    reason: "",
    method: "",
    fileName: "",
    type: "",
    previewUrl: "",
    files: [],
  });
  const [mistakeWorkspaceTab, setMistakeWorkspaceTab] = useState("ai");
  const [mistakePrompt, setMistakePrompt] = useState("");
  const [mistakeTaskType, setMistakeTaskType] = useState("analyzeMistake");
  const [mistakeResult, setMistakeResult] = useState(null);
  const [selectedArchiveMistakeIds, setSelectedArchiveMistakeIds] = useState([]);
  const [mistakeArchiveSubject, setMistakeArchiveSubject] = useState("全部");
  const [selectedMistakeId, setSelectedMistakeId] = useState(defaultMistakes[0].id);
  const [mistakeAiStatus, setMistakeAiStatus] = useState("idle");
  const [knowledgeQuestion, setKnowledgeQuestion] = useState("细胞结构");
  const [knowledgeNote, setKnowledgeNote] = useState(() => buildKnowledgeNote("细胞结构"));
  const [knowledgeAiStatus, setKnowledgeAiStatus] = useState("idle");
  const [knowledgeUseTemplate, setKnowledgeUseTemplate] = useState(false);
  const [knowledgePromptTemplate, setKnowledgePromptTemplate] = useState(defaultKnowledgePromptTemplate);
  const [forumPosts, setForumPosts] = useState(defaultForumPosts);
  const [activeForumPostId, setActiveForumPostId] = useState(defaultForumPosts[0].id);
  const [forumDraft, setForumDraft] = useState({
    type: "学习问题",
    title: "",
    content: "",
    reply: "",
  });
  const [freeAskInput, setFreeAskInput] = useState("");
  const [freeAskFiles, setFreeAskFiles] = useState([]);
  const [freeAskStatus, setFreeAskStatus] = useState("idle");
  const [freeAskModelChoice, setFreeAskModelChoice] = useState("openai-fast");
  const [freeAskMessages, setFreeAskMessages] = useState([]);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [calendarEditor, setCalendarEditor] = useState(null);
  const [calendarStatus, setCalendarStatus] = useState("idle");
  const [libraryItems, setLibraryItems] = useState([]);
  const [libraryView, setLibraryView] = useState("drive");
  const [libraryFolderId, setLibraryFolderId] = useState(null);
  const [librarySearch, setLibrarySearch] = useState("");
  const [librarySort, setLibrarySort] = useState("name");
  const [librarySortDir, setLibrarySortDir] = useState("asc");
  const [libraryEditor, setLibraryEditor] = useState(null);
  const [libraryPreview, setLibraryPreview] = useState(null);
  const [libraryStatus, setLibraryStatus] = useState("idle");
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const pendingMemberActionRef = useRef(null);
  const memberActionBypassRef = useRef(false);
  const freeAskSendingRef = useRef(false);
  const freeAskLastSubmitRef = useRef({ signature: "", time: 0 });
  const calendarFileInputRef = useRef(null);
  const libraryFileInputRef = useRef(null);
  const libraryFolderInputRef = useRef(null);

  const questionnaireSteps = useMemo(() => buildQuestionnaireSteps(answers), [answers.weakSubjects]);
  const progress = Math.round(((currentStep + 1) / questionnaireSteps.length) * 100);
  const completion = useMemo(() => calculateCompletion(answers, questionnaireSteps), [answers, questionnaireSteps]);
  const reportReady = submitted || aiInsight;

  const activeAiNotice = aiNotice.page === activePage ? aiNotice.message : "";
  const memberPlans = billingConfig.memberPlans.length ? billingConfig.memberPlans : defaultMemberPlans;
  const tokenPackages = billingConfig.tokenPackages.length ? billingConfig.tokenPackages : defaultTokenPackages;

  function showAiError(error, fallback = "AI服务暂时不可用，请稍后再试。") {
    setAiNotice({ page: activePage, message: error?.message || fallback });
  }

  function clearAiNotice() {
    setAiNotice({ page: "", message: "" });
  }

  useEffect(() => {
    if (currentStep >= questionnaireSteps.length) {
      setCurrentStep(questionnaireSteps.length - 1);
    }
  }, [currentStep, questionnaireSteps.length]);

  useEffect(() => {
    apiRequest("/membership/plans")
      .then((data) => {
        const nextMemberPlans = normalizeMemberPlans(data.membershipPlans || []);
        const nextTokenPackages = normalizeTokenPackages(data.ltPackages || []);
        setBillingConfig({
          memberPlans: nextMemberPlans.length ? nextMemberPlans : defaultMemberPlans,
          tokenPackages: nextTokenPackages.length ? nextTokenPackages : defaultTokenPackages,
        });
      })
      .catch(() => {
        setBillingConfig({ memberPlans: defaultMemberPlans, tokenPackages: defaultTokenPackages });
      });
  }, []);

  useEffect(() => {
    apiRequest("/me")
      .then((data) => {
        setMember(mapAccountToMember(data.account));
        setAccountNotice("");
      })
      .catch(() => {
        setAuthToken("");
      });
  }, []);

  useEffect(() => {
    if (activePage === "calendar" && member.isLoggedIn) loadCalendarEvents();
  }, [activePage, member.isLoggedIn]);

  useEffect(() => {
    if (activePage === "library" && member.isLoggedIn) loadLibraryItems();
  }, [activePage, member.isLoggedIn, libraryView, libraryFolderId, librarySort, librarySortDir]);

  useEffect(() => {
    if (activePage !== "library" || libraryView !== "drive" || libraryFolderId) {
      closeLibraryPreview();
      setLibraryEditor(null);
    }
  }, [activePage, libraryView, libraryFolderId]);

  async function loadCalendarEvents() {
    try {
      setCalendarStatus("loading");
      const data = await apiRequest("/calendar/events");
      setCalendarEvents(data.events || []);
      setCalendarStatus("idle");
    } catch (error) {
      setCalendarStatus("error");
      showAiError(error, "学习日历暂时无法读取，请稍后再试。");
    }
  }

  function openCalendarEditor(dateKey, event = null) {
    if (calendarEditor?.attachmentPreview?.url) URL.revokeObjectURL(calendarEditor.attachmentPreview.url);
    setCalendarEditor({
      id: event?.id || "",
      eventDate: dateKey,
      title: event?.title || "",
      content: event?.content || "",
      files: event?.files || [],
      newFiles: [],
      attachmentPreview: null,
    });
  }

  function updateCalendarEditor(patch) {
    setCalendarEditor((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function closeCalendarEditor() {
    if (calendarEditor?.attachmentPreview?.url) URL.revokeObjectURL(calendarEditor.attachmentPreview.url);
    setCalendarEditor(null);
  }

  function pickCalendarFiles(files) {
    const picked = Array.from(files || []);
    const tooLarge = picked.find((file) => file.type.startsWith("image/") && file.size > maxCalendarImageSize);
    if (tooLarge) {
      showAiError(new Error("单张图片不能超过 25MB。"));
      return;
    }
    updateCalendarEditor({ newFiles: picked });
  }

  async function quickCreateCalendarEvent(dateKey, title) {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    if (!requireMemberAction("新建学习日历页面", () => quickCreateCalendarEvent(dateKey, cleanTitle), "学习日历会保存到学生个人档案，需要登录并开通会员后继续。")) return;
    try {
      setCalendarStatus("saving");
      const form = new FormData();
      form.append("eventDate", dateKey);
      form.append("title", cleanTitle);
      form.append("content", "");
      const data = await apiRequest("/calendar/events", { method: "POST", body: form });
      setCalendarEvents((prev) => [...prev, data.event]);
      setCalendarStatus("idle");
    } catch (error) {
      setCalendarStatus("error");
      showAiError(error, "学习日历保存失败，请稍后再试。");
    }
  }

  async function saveCalendarEvent() {
    if (!calendarEditor?.title.trim()) {
      showAiError(new Error("请先写一个标题。"));
      return;
    }
    if (
      !requireMemberAction("保存学习日历", saveCalendarEvent, "学习日历会保存到学生个人档案，需要登录并开通会员后继续。")
    ) {
      return;
    }
    try {
      setCalendarStatus("saving");
      if (calendarEditor.id) {
        const hasNewFiles = (calendarEditor.newFiles || []).length > 0;
        const requestBody = hasNewFiles ? new FormData() : null;
        if (requestBody) {
          requestBody.append("eventDate", calendarEditor.eventDate);
          requestBody.append("title", calendarEditor.title);
          requestBody.append("content", calendarEditor.content || "");
          (calendarEditor.newFiles || []).forEach((file) => requestBody.append("files", file));
        }
        const data = await apiRequest(`/calendar/events/${calendarEditor.id}`, {
          method: "PATCH",
          body:
            requestBody ||
            JSON.stringify({
              eventDate: calendarEditor.eventDate,
              title: calendarEditor.title,
              content: calendarEditor.content,
            }),
        });
        setCalendarEvents((prev) => prev.map((item) => (item.id === data.event.id ? { ...item, ...data.event } : item)));
      } else {
        const form = new FormData();
        form.append("eventDate", calendarEditor.eventDate);
        form.append("title", calendarEditor.title);
        form.append("content", calendarEditor.content || "");
        (calendarEditor.newFiles || []).forEach((file) => form.append("files", file));
        const data = await apiRequest("/calendar/events", { method: "POST", body: form });
        setCalendarEvents((prev) => [...prev, data.event]);
      }
      closeCalendarEditor();
      setCalendarStatus("idle");
    } catch (error) {
      setCalendarStatus("error");
      showAiError(error, "学习日历保存失败，请稍后再试。");
    }
  }

  async function removeCalendarEvent(id) {
    if (!requireMemberAction("删除学习日历记录", () => removeCalendarEvent(id))) return;
    try {
      await apiRequest(`/calendar/events/${id}`, { method: "DELETE" });
      setCalendarEvents((prev) => prev.filter((item) => item.id !== id));
      closeCalendarEditor();
    } catch (error) {
      showAiError(error, "日历记录删除失败。");
    }
  }

  async function fetchFileSummaryBlob(file) {
    if (!file?.id) return null;
    const token = getAuthToken();
    const response = await fetch(`/api/files/${file.id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error("文件读取失败");
    return response.blob();
  }

  async function previewCalendarFile(file) {
    try {
      const blob = await fetchFileSummaryBlob(file);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      if (calendarEditor?.attachmentPreview?.url) URL.revokeObjectURL(calendarEditor.attachmentPreview.url);
      const kind = previewKindFor(file);
      const text = kind === "text" ? await blob.text() : "";
      updateCalendarEditor({ attachmentPreview: { file, kind, url, text } });
    } catch (error) {
      showAiError(error, "文件预览失败，可以先下载查看。");
    }
  }

  async function downloadCalendarFile(file) {
    try {
      const blob = await fetchFileSummaryBlob(file);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.originalName || "学习日历附件";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      showAiError(error, "文件下载失败。");
    }
  }

  async function loadLibraryItems() {
    try {
      setLibraryStatus("loading");
      const params = new URLSearchParams({ view: libraryView });
      if (libraryFolderId) params.set("folderId", libraryFolderId);
      if (librarySearch.trim()) params.set("search", librarySearch.trim());
      params.set("sort", librarySort);
      params.set("dir", librarySortDir);
      const data = await apiRequest(`/library/items?${params.toString()}`);
      setLibraryItems(data.items || []);
      if (data.account) setMember(mapAccountToMember(data.account));
      setLibraryStatus("idle");
    } catch (error) {
      setLibraryStatus("error");
      showAiError(error, "资料库暂时无法读取，请稍后再试。");
    }
  }

  async function createLibraryFolder() {
    const name = window.prompt("文件夹名称", "新建文件夹");
    if (!name) return;
    if (!requireMemberAction("新建资料库文件夹", createLibraryFolder, "资料库会占用个人存储空间，需要会员权限。")) return;
    try {
      const data = await apiRequest("/library/folders", {
        method: "POST",
        body: JSON.stringify({ name, parentId: libraryFolderId }),
      });
      setLibraryItems((prev) => [data.item, ...prev]);
    } catch (error) {
      showAiError(error, "文件夹创建失败。");
    }
  }

  async function createLibraryDocument() {
    const name = window.prompt("文档名称", "新建学习文档");
    if (!name) return;
    if (!requireMemberAction("新建云端文档", createLibraryDocument, "云端文档会保存到个人资料库，需要会员权限。")) return;
    try {
      const data = await apiRequest("/library/documents", {
        method: "POST",
        body: JSON.stringify({ name, parentId: libraryFolderId }),
      });
      setLibraryItems((prev) => [data.item, ...prev]);
      setLibraryEditor(data.item);
    } catch (error) {
      showAiError(error, "文档创建失败。");
    }
  }

  async function uploadLibraryFiles(files) {
    const picked = Array.from(files || []);
    if (!picked.length) return;
    if (!requireMemberAction("上传学习资料", () => uploadLibraryFiles(files), "上传资料会保存到学生资料库，需要会员权限。")) return;
    try {
      setLibraryStatus("saving");
      const form = new FormData();
      if (libraryFolderId) form.append("parentId", libraryFolderId);
      picked.forEach((file) => form.append("files", file, file.webkitRelativePath || file.name));
      const data = await apiRequest("/library/files", { method: "POST", body: form });
      setLibraryItems((prev) => [...(data.items || []), ...prev]);
      if (data.account) setMember(mapAccountToMember(data.account));
      setLibraryStatus("idle");
    } catch (error) {
      setLibraryStatus("error");
      showAiError(error, "资料上传失败，请检查文件大小或稍后再试。");
    }
  }

  async function updateLibraryItem(item, patch) {
    try {
      const data = await apiRequest(`/library/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setLibraryItems((prev) => prev.map((row) => (row.id === item.id ? data.item : row)));
      if (libraryEditor?.id === item.id) setLibraryEditor(data.item);
      if (libraryPreview?.item?.id === item.id) setLibraryPreview((prev) => (prev ? { ...prev, item: data.item } : prev));
      return data.item;
    } catch (error) {
      showAiError(error, "资料库更新失败。");
      return null;
    }
  }

  async function openLibraryItem(item) {
    if (item.type === "folder") {
      closeLibraryPreview();
      setLibraryEditor(null);
      setLibraryFolderId(item.id);
      setLibraryView("drive");
      return;
    }
    const updated = await updateLibraryItem(item, { opened: true });
    const target = updated || item;
    const kind = previewKindFor(target);
    if (kind) {
      await openLibraryPreview(target, kind);
      return;
    }
    setLibraryEditor(target);
    closeLibraryPreview();
  }

  async function fetchLibraryFileBlob(item) {
    if (!item.fileId) return;
    const token = getAuthToken();
    const response = await fetch(`/api/files/${item.fileId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error("下载失败");
    return response.blob();
  }

  async function openLibraryPreview(item, kind = previewKindFor(item)) {
    if (!item.fileId || !kind) return;
    try {
      const blob = await fetchLibraryFileBlob(item);
      const url = URL.createObjectURL(blob);
      if (libraryPreview?.url) URL.revokeObjectURL(libraryPreview.url);
      const text = kind === "text" ? await blob.text() : "";
      setLibraryPreview({ item, kind, url, text });
      setLibraryEditor(item);
    } catch (error) {
      showAiError(error, "文件预览失败，可以先下载原文件查看。");
    }
  }

  function closeLibraryPreview() {
    if (libraryPreview?.url) URL.revokeObjectURL(libraryPreview.url);
    setLibraryPreview(null);
  }

  async function downloadLibraryFile(item) {
    if (!item.fileId) return;
    try {
      const blob = await fetchLibraryFileBlob(item);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = item.name || "学习资料";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      showAiError(error, "文件下载失败。");
    }
  }

  function requireMemberAction(actionName, callback, message = "") {
    if (memberActionBypassRef.current || (member.isLoggedIn && member.isPaid)) {
      return true;
    }
    pendingMemberActionRef.current = callback || null;
    setAuthModal({
      open: true,
      actionName,
      message:
        message ||
        (member.isLoggedIn
          ? "这个功能会使用AI能力或生成下载文件，需要开通会员后继续。"
          : "你可以浏览页面和了解功能，但使用AI分析、个人档案保存和下载能力前，需要先注册或登录。"),
    });
    return false;
  }

  async function completeAuth() {
    const username = authForm.username.trim();
    const password = authForm.password;
    if (!username || username.length < 3) {
      setAuthModal((prev) => ({ ...prev, message: "请设置至少3个字符的用户名。" }));
      return;
    }
    if (!password || password.length < 6) {
      setAuthModal((prev) => ({ ...prev, message: "密码至少需要6位。" }));
      return;
    }
    if (authForm.mode === "register" && password !== authForm.confirmPassword) {
      setAuthModal((prev) => ({ ...prev, message: "两次输入的密码不一致。" }));
      return;
    }
    try {
      const data = await apiRequest(authForm.mode === "register" ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          displayName: authForm.displayName.trim(),
        }),
      });
      setAuthToken(data.token);
      setMember(mapAccountToMember(data.account));
      setAccountNotice("");
      setAuthModal((prev) => ({
        ...prev,
        message: "账号已登录。继续开通会员后，就可以使用AI分析、下载和个人档案能力。",
      }));
    } catch (error) {
      setAuthModal((prev) => ({
        ...prev,
        message: error.message || "登录失败，请确认后端服务已经启动。",
      }));
    }
  }

  async function activateMember(planId = "monthly") {
    const plan = memberPlans.find((item) => item.id === planId) || memberPlans[0];
    if (!member.isLoggedIn) {
      setAuthModal((prev) => ({ ...prev, message: "请先注册或登录，再提交会员开通申请。" }));
      return;
    }
    try {
      const data = await apiRequest("/membership/orders", {
        method: "POST",
        body: JSON.stringify({ planId }),
      });
      setAccountNotice(data.message || "已提交会员开通申请。");
      setAuthModal((prev) => ({
        ...prev,
        message: `已提交「${plan.name}」开通申请。当前版本需要管理员确认后开通。`,
      }));
    } catch (error) {
      setAuthModal((prev) => ({
        ...prev,
        message: error.message || "会员开通申请提交失败。",
      }));
    }
  }

  async function requestTokenOrder(packageId = "token-100", customAmount = "") {
    if (!member.isLoggedIn) {
      setAuthModal((prev) => ({ ...prev, message: "请先注册或登录，再提交Token充值申请。" }));
      return;
    }
    if (packageId === "custom" && Number(customAmount || 0) < 50) {
      setAuthModal((prev) => ({ ...prev, message: "自定义充值金额最低为50元。" }));
      return;
    }
    try {
      const data = await apiRequest("/lt/orders", {
        method: "POST",
        body: JSON.stringify({ packageId, customAmount }),
      });
      setAccountNotice(data.message || "已提交Token充值申请。");
      setAuthModal((prev) => ({ ...prev, message: "充值申请已提交。请扫码付款后等待管理员确认入账。" }));
    } catch (error) {
      setAuthModal((prev) => ({ ...prev, message: error.message || "Token充值申请提交失败。" }));
    }
  }

  function openPaymentModal() {
    setCheckout({
      planId: member.isPaid ? "" : (memberPlans[0]?.id || "monthly"),
      tokenPackageId: "",
      customTokenAmount: "",
      showQr: false,
      message: "",
    });
    setAuthModal({
      open: true,
      actionName: "会员开通与Token充值",
      message: "先选择需要的会员方案或Token额度，确认金额后再扫码付款。",
    });
  }

  async function submitCheckoutPaid() {
    if (!member.isLoggedIn) {
      setCheckout((prev) => ({ ...prev, message: "请先注册或登录，再提交付款确认。" }));
      return;
    }
    const selectedPlan = member.isPaid ? null : memberPlans.find((item) => item.id === checkout.planId);
    const selectedToken = tokenPackages.find((item) => item.id === checkout.tokenPackageId);
    const customAmount = Number(checkout.customTokenAmount || 0);
    if (customAmount > 0 && customAmount < 50) {
      setCheckout((prev) => ({ ...prev, message: "自定义充值金额最低为50元。" }));
      return;
    }
    if (!selectedPlan && !selectedToken && customAmount <= 0) {
      setCheckout((prev) => ({ ...prev, message: "请先选择会员方案或Token充值额度。" }));
      return;
    }
    try {
      if (selectedPlan) {
        await apiRequest("/membership/orders", {
          method: "POST",
          body: JSON.stringify({ planId: selectedPlan.id }),
        });
      }
      if (selectedToken || customAmount > 0) {
        await apiRequest("/lt/orders", {
          method: "POST",
          body: JSON.stringify({
            packageId: selectedToken?.id || "custom",
            customAmount: selectedToken ? "" : customAmount,
          }),
        });
      }
      const message = "已提交付款确认申请。请扫描管理员微信二维码，告知管理员支付情况；管理员确认后会员及Token额度会更新。";
      setCheckout((prev) => ({ ...prev, message }));
      setAuthModal((prev) => ({ ...prev, message }));
      setAccountNotice(message);
    } catch (error) {
      setCheckout((prev) => ({ ...prev, message: error.message || "付款确认提交失败。" }));
    }
  }

  function logoutMember() {
    pendingMemberActionRef.current = null;
    memberActionBypassRef.current = false;
    setAuthToken("");
    setAccountNotice("");
    setMember({ isLoggedIn: false, isPaid: false, identifier: "", provider: "用户名", plan: "", ltBalance: 0, storageTotalMb: 50 });
  }

  async function loadMemberCenter() {
    if (!member.isLoggedIn) {
      setAuthModal({ open: true, actionName: "会员中心", message: "请先注册或登录，再查看会员中心。" });
      return;
    }
    setActivePage("memberCenter");
    setMemberCenter((prev) => ({ ...prev, loading: true, message: "" }));
    try {
      const data = await apiRequest("/account/center");
      setMemberCenter((prev) => ({
        ...prev,
        loading: false,
        data,
        displayName: data.account?.student?.name || data.account?.user?.displayName || "",
      }));
      setMember(mapAccountToMember(data.account));
    } catch (error) {
      setMemberCenter((prev) => ({ ...prev, loading: false, message: error.message || "会员中心加载失败。" }));
    }
  }

  async function updateMemberProfile() {
    try {
      const data = await apiRequest("/account/profile", {
        method: "POST",
        body: JSON.stringify({ displayName: memberCenter.displayName }),
      });
      setMember(mapAccountToMember(data.account));
      setMemberCenter((prev) => ({ ...prev, message: "资料已更新。" }));
      loadMemberCenter();
    } catch (error) {
      setMemberCenter((prev) => ({ ...prev, message: error.message || "资料更新失败。" }));
    }
  }

  async function updateMemberPassword() {
    try {
      await apiRequest("/account/password", {
        method: "POST",
        body: JSON.stringify({ oldPassword: memberCenter.oldPassword, newPassword: memberCenter.newPassword }),
      });
      setMemberCenter((prev) => ({ ...prev, oldPassword: "", newPassword: "", message: "密码已修改。" }));
    } catch (error) {
      setMemberCenter((prev) => ({ ...prev, message: error.message || "密码修改失败。" }));
    }
  }

  async function recordDownload(title, filename, href) {
    try {
      await apiRequest("/account/downloads", {
        method: "POST",
        body: JSON.stringify({ title, filename, href }),
      });
    } catch {
      // 下载不能因为记录失败而中断。
    }
  }

  async function loadAdminUsers() {
    if (!adminPanel.token.trim()) {
      setAdminPanel((prev) => ({ ...prev, message: "请先登录管理员账号。" }));
      return;
    }
    try {
      const data = await apiRequest("/admin/users", { headers: { "x-admin-token": adminPanel.token.trim() } });
      setAdminPanel((prev) => ({ ...prev, users: data.users || [], message: "管理员数据已刷新。" }));
    } catch (error) {
      setAdminPanel((prev) => ({ ...prev, message: error.message || "管理员数据加载失败。" }));
    }
  }

  async function loadAdminOrders(token = adminPanel.token.trim()) {
    if (!token) {
      setAdminPanel((prev) => ({ ...prev, message: "请先登录管理员账号。" }));
      return;
    }
    try {
      const data = await apiRequest("/admin/orders", { headers: { "x-admin-token": token } });
      setAdminPanel((prev) => ({ ...prev, orders: data.orders || [], message: "付款申请已刷新。" }));
    } catch (error) {
      setAdminPanel((prev) => ({ ...prev, message: error.message || "付款申请加载失败。" }));
    }
  }

  async function refreshAdminData(token = adminPanel.token.trim(), message = "管理员数据已刷新。") {
    const [usersData, ordersData] = await Promise.all([
      apiRequest("/admin/users", { headers: { "x-admin-token": token } }),
      apiRequest("/admin/orders", { headers: { "x-admin-token": token } }),
    ]);
    setAdminPanel((prev) => ({
      ...prev,
      users: usersData.users || [],
      orders: ordersData.orders || [],
      message,
    }));
  }

  async function loginAdmin() {
    try {
      const data = await apiRequest("/admin/login", {
        method: "POST",
        body: JSON.stringify({ username: adminPanel.username, password: adminPanel.password }),
      });
      const [userData, orderData] = await Promise.all([
        apiRequest("/admin/users", { headers: { "x-admin-token": data.adminToken } }),
        apiRequest("/admin/orders", { headers: { "x-admin-token": data.adminToken } }),
      ]);
      setAdminPanel((prev) => ({
        ...prev,
        token: data.adminToken,
        password: "",
        isLoggedIn: true,
        users: userData.users || [],
        orders: orderData.orders || [],
        message: "管理员已登录，用户数据已刷新。",
      }));
    } catch (error) {
      setAdminPanel((prev) => ({ ...prev, message: error.message || "管理员登录失败。" }));
    }
  }

  async function adminActivateMembership() {
    try {
      await apiRequest("/admin/memberships/activate", {
        method: "POST",
        headers: { "x-admin-token": adminPanel.token.trim() },
        body: JSON.stringify({
          identifier: adminPanel.identifier,
          planId: adminPanel.planId,
          startDate: adminPanel.membershipStartDate,
          paidAmountCny: Number(adminPanel.paidAmount || 0),
        }),
      });
      setAdminPanel((prev) => ({ ...prev, message: "会员已开通。" }));
      refreshAdminData(adminPanel.token.trim(), "会员已开通。");
    } catch (error) {
      setAdminPanel((prev) => ({ ...prev, message: error.message || "开通失败。" }));
    }
  }

  async function adminRechargeToken() {
    try {
      await apiRequest("/admin/lt/recharge", {
        method: "POST",
        headers: { "x-admin-token": adminPanel.token.trim() },
        body: JSON.stringify({
          identifier: adminPanel.identifier,
          amount: Number(adminPanel.tokenAmount),
          paidAmountCny: Number(adminPanel.paidAmount || 0),
          note: "管理员手动充值",
        }),
      });
      setAdminPanel((prev) => ({ ...prev, message: "Token已入账。" }));
      refreshAdminData(adminPanel.token.trim(), "Token已入账。");
    } catch (error) {
      setAdminPanel((prev) => ({ ...prev, message: error.message || "充值失败。" }));
    }
  }

  async function adminConfirmOrder(orderId) {
    try {
      await apiRequest(`/admin/orders/${orderId}/confirm`, {
        method: "POST",
        headers: { "x-admin-token": adminPanel.token.trim() },
        body: JSON.stringify({
          note: adminPanel.orderNote,
          startDate: adminPanel.membershipStartDate,
        }),
      });
      setAdminPanel((prev) => ({ ...prev, orderNote: "", message: "付款申请已确认入账。" }));
      refreshAdminData(adminPanel.token.trim(), "付款申请已确认入账。");
    } catch (error) {
      setAdminPanel((prev) => ({ ...prev, message: error.message || "确认付款失败。" }));
    }
  }

  async function adminCancelOrder(orderId) {
    try {
      await apiRequest(`/admin/orders/${orderId}/cancel`, {
        method: "POST",
        headers: { "x-admin-token": adminPanel.token.trim() },
        body: JSON.stringify({ note: adminPanel.orderNote }),
      });
      setAdminPanel((prev) => ({ ...prev, orderNote: "", message: "付款申请已取消。" }));
      refreshAdminData(adminPanel.token.trim(), "付款申请已取消。");
    } catch (error) {
      setAdminPanel((prev) => ({ ...prev, message: error.message || "取消申请失败。" }));
    }
  }

  function closeAuthModal() {
    pendingMemberActionRef.current = null;
    memberActionBypassRef.current = false;
    setAuthModal({ open: false, actionName: "", message: "" });
  }

  function updateAnswer(question, value) {
    setAnswers((prev) => ({ ...prev, [question.id]: value }));
    setLastSaved("正在编辑，尚未保存");
  }

  function toggleMulti(question, option) {
    const current = Array.isArray(answers[question.id]) ? answers[question.id] : [];
    const next = current.includes(option)
      ? current.filter((item) => item !== option)
      : [...current, option];
    updateAnswer(question, next);
  }

  async function saveDraft() {
    if (!requireMemberAction("保存学情问卷到个人档案", saveDraft, "保存进度会写入学生个人档案，需要登录并开通会员。")) return;
    try {
      await apiRequest("/archive/questionnaire", {
        method: "POST",
        body: JSON.stringify({ answers, completion, status: "draft" }),
      });
    } catch (error) {
      setAccountNotice(error.message || "学情问卷暂时没有写入服务器。");
    }
    setLastSaved(`已保存草稿 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
  }

  async function submitQuestionnaire() {
    if (!requireMemberAction("提交学情问卷并生成档案", submitQuestionnaire, "提交问卷后会进入学生个人档案，并用于后续AI画像分析，需要会员权限。")) return;
    try {
      await apiRequest("/archive/questionnaire", {
        method: "POST",
        body: JSON.stringify({ answers, completion, status: "submitted" }),
      });
    } catch (error) {
      setAccountNotice(error.message || "问卷提交暂时没有写入服务器。");
    }
    setSubmitted(true);
    setLastSaved("问卷已提交，已进入学生个人档案");
    setActivePage("statement");
  }

  async function saveStatement() {
    if (!requireMemberAction("保存学情陈述", saveStatement, "学情陈述会被保存到个人档案，后续会在学情画像页面统一分析。")) return;
    const content = statementText.trim();
    if (!content) return;
    const selectedSubject = statementSubject || "未选主题";
    const selectedScene = statementScene || "未选场景";
    const tags = [selectedSubject, selectedScene, statementIntensity >= 8 ? "高影响" : "需跟进"];
    try {
      await apiRequest("/archive/statements", {
        method: "POST",
        body: JSON.stringify({
          subject: selectedSubject,
          scene: selectedScene,
          intensity: statementIntensity,
          content,
          guidedAnswers,
        }),
      });
    } catch (error) {
      setAccountNotice(error.message || "学情陈述暂时没有写入服务器。");
    }
    setRecords((prev) => [
      {
        id: Date.now(),
        type: "文字申述",
        title: `${selectedSubject} · ${selectedScene}`,
        content,
        time: "刚刚",
        subject: selectedSubject,
        scene: selectedScene,
        intensity: statementIntensity,
        tags,
        guidedAnswers,
      },
      ...prev,
    ]);
  }

  async function startRecording() {
    if (!requireMemberAction("使用麦克风保存学情陈述", startRecording, "语音陈述会保存到个人档案，后续会在学情画像页面统一分析。")) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        stream.getTracks().forEach((track) => track.stop());
        setRecords((prev) => [
          {
            id: Date.now(),
            type: "麦克风录音",
            title: "学生语音申述",
            content: "已保存一段实时录音，后续会转写成文字并进入个人学情档案。",
            time: "刚刚",
            subject: statementSubject,
            scene: statementScene,
            intensity: statementIntensity,
            tags: [statementSubject, statementScene, "语音待转写"],
            audioUrl: url,
          },
          ...prev,
        ]);
      };
      recorder.start();
      setRecordingState("recording");
    } catch {
      setRecordingState("blocked");
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && recordingState === "recording") {
      mediaRecorderRef.current.stop();
      setRecordingState("idle");
    }
  }

  async function uploadAudio(event) {
    if (!requireMemberAction("上传语音并保存", null, "上传语音会保存到个人档案，后续会在学情画像页面统一分析。")) {
      event.target.value = "";
      return;
    }
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    let transcriptText = "";
    try {
      clearAiNotice();
      const formData = new FormData();
      formData.append("audio", file);
      const data = await apiRequest("/ai/transcribe", {
        method: "POST",
        body: formData,
      });
      transcriptText = data.transcript || "";
    } catch (error) {
      showAiError(error, "语音已添加到页面，但暂时没有完成服务器转写。");
    }
    setRecords((prev) => [
      {
        id: Date.now(),
        type: "上传语音",
        title: file.name,
        content: transcriptText || "已上传学生录制的语音，后续会转写成文字并进入个人学情档案。",
        time: "刚刚",
        subject: statementSubject,
        scene: statementScene,
        intensity: statementIntensity,
        tags: [statementSubject, statementScene, "上传语音"],
        audioUrl: url,
      },
      ...prev,
    ]);
  }

  function generateProfileAnalysis() {
    if (!requireMemberAction("生成学情画像统一分析", generateProfileAnalysis, "学情画像会整合问卷、陈述、错题专项和学习记录，需要会员权限。")) return;
    if (aiStatus === "loading") return;
    clearAiNotice();
    const archiveSnapshot = buildStudentArchiveSnapshot({
      answers,
      records,
      mistakes,
      strategies: strategyWorkspaces,
      plans: { planRows, methodFocusRows, habitFocusRows },
    });
    const prompt = buildAgentPrompt("profile", archiveSnapshot);
    console.info("树子AI任务提示词", prompt);
    setAiStatus("loading");
    window.setTimeout(() => {
      const weakSubjects = Array.isArray(answers.weakSubjects) && answers.weakSubjects.length ? answers.weakSubjects.join("、") : "数学、英语等薄弱科目";
      setAiInsight({
        summary: `AI已整合学情问卷、${records.length}条学情陈述和错题专项记录，形成当前学生学习档案快照。`,
        core: `当前核心判断：学生需要先把${weakSubjects}中的基础漏洞、错题复测和计划执行连接起来，避免只靠临时努力。`,
        reasons: ["学情问卷反映学习链和方法习惯需要继续稳定", "学情陈述显示学生能说出困扰，但需要把问题落到科目和场景", "错题专项提示知识调用、审题步骤和错题复测需要重点跟进", "学习计划需要从少量、明确、可检查的任务开始"],
        evidence: ["问卷数据：基础信息、学习链、作业错题、复习巩固和科目专项", "陈述数据：文字/语音陈述、发生场景、影响程度", "错题数据：错题类型、知识漏洞、方法缺口", "执行数据：计划、方法习惯训练、反思讨论会持续更新画像"],
        tags: ["动态学情画像", "知识漏洞", "方法习惯", "计划执行"],
        questions: ["最近一周最影响学习效率的固定场景是什么？", "哪一类错题已经重复出现三次以上？", "学生最愿意先训练的一个方法或习惯是什么？", "家长能提供的稳定支持是什么？"],
        next: "下一步进入“策略与任务”，先为薄弱科目制定1-3个可执行任务，再进入“学习计划”安排到具体空闲时间。",
        archiveConclusion: "该画像不是一次性结论，会随着问卷补充、错题训练、每日反思和每周讨论持续更新。",
        source: JSON.stringify(prompt),
      });
      setAiStatus("done");
    }, 800);
  }

  function updateStatementIssueDetail(issue, field, value) {
    setStatementIssueDetails((prev) => ({
      ...prev,
      [issue]: {
        ...(prev[issue] || {}),
        enabled: true,
        [field]: value,
      },
    }));
  }

  function toggleStatementIssue(issue) {
    setStatementIssueDetails((prev) => ({
      ...prev,
      [issue]: {
        ...(prev[issue] || {}),
        enabled: !prev[issue]?.enabled,
      },
    }));
  }

  function updateStrategyWorkspace(subject, updater) {
    setStrategyWorkspaces((prev) => ({
      ...prev,
      [subject]: updater(prev[subject]),
    }));
  }

  function updateStrategyText(value, field = "studentStrategy") {
    updateStrategyWorkspace(activeSubject, (workspace) => ({
      ...workspace,
      [field]: value,
      strategy: field === "studentStrategy" ? value || workspace.acceptedStrategy || workspace.strategy : workspace.strategy,
    }));
  }

  function acceptStrategySuggestion() {
    updateStrategyWorkspace(activeSubject, (workspace) => ({
      ...workspace,
      acceptedStrategy: workspace.strategySuggestion,
      strategy: workspace.strategySuggestion,
      aiNote: "已接受当前AI策略建议，这份策略会作为本学科后续任务和计划设计的依据。",
    }));
  }

  function rejectStrategySuggestion() {
    updateStrategyWorkspace(activeSubject, (workspace) => ({
      ...workspace,
      acceptedStrategy: "",
      aiNote: "当前AI策略建议暂未采用。可以重新生成，或以学生自己的策略为准继续设计任务。",
    }));
  }

  function updateStrategyTask(taskId, field, value) {
    updateStrategyWorkspace(activeSubject, (workspace) => ({
      ...workspace,
      tasks: workspace.tasks.map((task) => (task.id === taskId ? { ...task, [field]: value } : task)),
    }));
  }

  function updateMaterialUsage(materialId, field, value) {
    updateStrategyWorkspace(activeSubject, (workspace) => ({
      ...workspace,
      materials: workspace.materials.map((material) => (material.id === materialId ? { ...material, [field]: value } : material)),
    }));
  }

  function updateCustomMaterial(materialId, field, value) {
    updateStrategyWorkspace(activeSubject, (workspace) => ({
      ...workspace,
      customMaterials: workspace.customMaterials.map((material) => (material.id === materialId ? { ...material, [field]: value } : material)),
    }));
  }

  function addCustomMaterial() {
    updateStrategyWorkspace(activeSubject, (workspace) => ({
      ...workspace,
      customMaterials: [
        ...workspace.customMaterials,
        {
          id: `${activeSubject}-custom-material-${Date.now()}`,
          name: "",
          purpose: "",
          usage: "",
        },
      ],
    }));
  }

  function addStrategyTask() {
    updateStrategyWorkspace(activeSubject, (workspace) => ({
      ...workspace,
      tasks: [
        ...workspace.tasks,
        {
          id: `${activeSubject}-task-${Date.now()}`,
          title: "自定义学习任务",
          problem: "写清楚这个任务要解决的学习问题",
          time: "例如：每天晚饭后 30 分钟",
          material: "例如：课本、错题本、教材全解",
          detail: "写清楚任务步骤，越具体越容易执行。",
          standard: "写清楚怎样算完成，以及如何检查效果。",
          studentNote: "",
        },
      ],
    }));
  }

  function updatePlanCell(rowId, day, field, value) {
    setPlanRows((prev) =>
      prev.map((row) =>
        row.id === rowId
          ? {
              ...row,
              cells: {
                ...row.cells,
                [day]: {
                  ...row.cells[day],
                  [field]: value,
                },
              },
            }
          : row
      )
    );
  }

  function addPlanRow() {
    setPlanRows((prev) => [...prev, { id: `plan-row-${Date.now()}`, cells: createWeekCells() }]);
  }

  function removePlanRow(rowId) {
    setPlanRows((prev) => prev.filter((row) => row.id !== rowId));
  }

  async function runPlanAi() {
    if (!requireMemberAction("AI辅助制定学习计划", runPlanAi, "AI会根据已经形成的学情画像、策略任务和方法习惯目标生成可修改的周计划，需要会员权限。")) return;
    if (planAiStatus === "loading") return;
    setPlanAiStatus("loading");
    clearAiNotice();
    const archiveSnapshot = buildStudentArchiveSnapshot({
      answers,
      records,
      mistakes,
      strategies: strategyWorkspaces,
      plans: { planRows, methodFocusRows, habitFocusRows },
    });
    console.info("树子AI任务提示词", buildAgentPrompt("plan", archiveSnapshot));
    try {
      const data = await apiRequest("/ai/study-plan", {
        method: "POST",
        body: JSON.stringify({
          archiveSnapshot,
          currentPlanRows: planRows,
          methodFocusRows,
          habitFocusRows,
        }),
      });
      const rows = Array.isArray(data.plan?.rows) ? data.plan.rows : [];
      if (rows.length) {
        setPlanRows(
          normalizePlanRows(
            rows.slice(0, 8).map((row, index) => ({
              id: `ai-plan-row-${Date.now()}-${index}`,
              cells: row.cells || row,
            }))
          )
        );
      }
      if (data.plan?.note) setPlanNote(data.plan.note);
      setPlanAiStatus("done");
      return;
    } catch (error) {
      showAiError(error, "AI学习计划暂时没有响应，已先生成一份可修改的基础计划。");
    }
    const weakSubject = Array.isArray(answers.weakSubjects) && answers.weakSubjects[0] ? answers.weakSubjects[0] : "数学";
    setPlanRows(
      normalizePlanRows([
        { id: `ai-plan-row-${Date.now()}-1`, cells: { 星期一: { start: "19:30", end: "20:10", task: `${weakSubject}基础回补`, note: "先做课本例题和基础题" }, 星期三: { start: "19:30", end: "20:10", task: `${weakSubject}错题复测`, note: "重做1-2道典型错题" } } },
        { id: `ai-plan-row-${Date.now()}-2`, cells: { 星期二: { start: "19:30", end: "20:00", task: "方法训练", note: "使用本周选定学习方法" }, 星期四: { start: "19:30", end: "20:00", task: "同类题训练", note: "控制题量，写清步骤" } } },
        { id: `ai-plan-row-${Date.now()}-3`, cells: { 星期五: { start: "20:30", end: "20:50", task: "本周复盘", note: "记录完成情况和下周调整点" }, 星期日: { start: "19:30", end: "20:00", task: "整理错题", note: "更新错题库和复测安排" } } },
      ])
    );
    setPlanNote("AI建议先把任务安排得少而清楚：每次只处理一个明确问题，并在备注里写完成标准。");
    setPlanAiStatus("done");
  }

  function updateFocusRow(kind, rowId, field, value) {
    const setter = kind === "method" ? setMethodFocusRows : setHabitFocusRows;
    setter((prev) => prev.map((row) => (row.id === rowId ? { ...row, [field]: value } : row)));
  }

  function updateFocusScore(kind, rowId, day, value) {
    const setter = kind === "method" ? setMethodFocusRows : setHabitFocusRows;
    setter((prev) => prev.map((row) => (row.id === rowId ? { ...row, scores: { ...row.scores, [day]: value } } : row)));
  }

  function updateMistakeDraft(field, value) {
    setMistakeDraft((prev) => ({ ...prev, [field]: value }));
  }

  function handleMistakeFile(event) {
    if (!requireMemberAction("上传学习材料到错题专项", null, "上传的错题、作业或试卷会进入学生个人错题档案，后续用于AI分析和训练，需要会员权限。")) {
      event.target.value = "";
      return;
    }
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const normalizedFiles = files.map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      file,
      name: file.name,
      type: file.type || "文件",
      size: file.size,
      previewUrl: (file.type || "").startsWith("image/") ? URL.createObjectURL(file) : "",
    }));
    setMistakeDraft((prev) => ({
      ...prev,
      fileName: normalizedFiles.map((item) => item.name).join("、"),
      type: normalizedFiles.length > 1 ? "多文件" : normalizedFiles[0].type,
      rawFile: normalizedFiles[0].file,
      files: [...(prev.files || []), ...normalizedFiles],
      title: prev.title === "新上传学习材料" ? normalizedFiles[0].name.replace(/\.[^.]+$/, "") : prev.title,
      previewUrl: normalizedFiles[0].previewUrl || prev.previewUrl,
    }));
    setMistakeResult(null);
    event.target.value = "";
  }

  function removeMistakeUpload(fileId) {
    setMistakeDraft((prev) => {
      const files = (prev.files || []).filter((item) => item.id !== fileId);
      return {
        ...prev,
        files,
        fileName: files.map((item) => item.name).join("、"),
        rawFile: files[0]?.file || null,
        previewUrl: files.find((item) => item.previewUrl)?.previewUrl || "",
      };
    });
  }

  function applyMistakeQuickTask(taskType) {
    const task = mistakeQuickTasks[taskType];
    if (!task) return;
    setMistakeTaskType(taskType);
    setMistakePrompt(task.prompt);
    setMistakeWorkspaceTab("ai");
  }

  function normalizeMistakeResultToArchive(report, savedId) {
    const extracted = Array.isArray(report?.extracted_questions) && report.extracted_questions.length
      ? report.extracted_questions
      : [
          {
            title: report?.title || mistakeDraft.title || "AI整理结果",
            question_content: report?.summary || "",
            subject: mistakeDraft.subject,
            error_type: report?.analysis?.error_reason || report?.error_reason || "等待确认",
            knowledge_points: report?.analysis?.knowledge_points || report?.knowledge_points || [],
            method_gap: report?.analysis?.method_gap || report?.method_gap || "",
            correction_steps: report?.analysis?.correction_steps || report?.correction_steps || "",
            suggestion: Array.isArray(report?.analysis?.training_suggestions)
              ? report.analysis.training_suggestions.join("；")
              : report?.analysis?.training_suggestions || report?.review_schedule || "",
          },
        ];

    return extracted.map((question, index) => ({
      id: `${savedId || "mistake"}-${Date.now()}-${index}`,
      title: question.title || `错题 ${index + 1}`,
      subject: question.subject || mistakeDraft.subject,
      source: mistakeDraft.source || "错题专项",
      fileName: mistakeDraft.fileName || "未上传文件",
      type: mistakeQuickTasks[mistakeTaskType]?.label || "AI处理",
      reason: question.error_type || report?.analysis?.error_reason || "等待补充错因。",
      method: question.method_gap || question.correction_steps || report?.analysis?.method_gap || "等待补充解题方法或思路。",
      date: "刚刚",
      previewUrl: mistakeDraft.previewUrl,
      content: question.question_content || "",
      knowledgePoints: question.knowledge_points || [],
      suggestion: question.suggestion || report?.analysis?.review_schedule || "",
      report,
    }));
  }

  async function runMistakeWorkspaceAi() {
    const taskLabel = mistakeQuickTasks[mistakeTaskType]?.label || "AI处理错题";
    if (!requireMemberAction(taskLabel, runMistakeWorkspaceAi, "错题专项会调用AI分析材料并写入学生个人错题档案，需要登录并开通会员。")) return;
    if (mistakeAiStatus === "loading") return;
    if (!mistakePrompt.trim() && !(mistakeDraft.files || []).length) {
      setAiNotice({ page: activePage, message: "请先上传材料，或者在输入框里写清楚你想让AI处理什么。" });
      return;
    }
    setMistakeAiStatus("loading");
    try {
      clearAiNotice();
      const formData = new FormData();
      formData.append("taskType", mistakeTaskType);
      formData.append("prompt", mistakePrompt);
      formData.append("subject", mistakeDraft.subject);
      formData.append("title", mistakeDraft.title);
      formData.append("source", mistakeDraft.source);
      formData.append("archiveSnapshot", JSON.stringify(buildStudentArchiveSnapshot({ answers, records, mistakes })));
      (mistakeDraft.files || []).forEach((item) => formData.append("files", item.file));
      const data = await apiRequest("/ai/mistakes/workflow", {
        method: "POST",
        body: formData,
      });
      const report = data.report || {};
      const nextItems = normalizeMistakeResultToArchive(report, data.saved?.id);
      setMistakeResult(report);
      setMistakes((prev) => {
        const nextKeys = new Set(nextItems.map((item) => `${item.subject}|${item.title}|${item.fileName}`));
        return [...nextItems, ...prev.filter((item) => !nextKeys.has(`${item.subject}|${item.title}|${item.fileName}`))];
      });
      setSelectedMistakeId(nextItems[0]?.id || selectedMistakeId);
      setMistakeAiStatus("done");
    } catch (error) {
      showAiError(error, "AI处理暂时不可用，请稍后再试。");
      setMistakeAiStatus("idle");
    }
  }

  function toggleArchiveMistake(mistakeId) {
    setSelectedArchiveMistakeIds((prev) =>
      prev.includes(mistakeId) ? prev.filter((id) => id !== mistakeId) : [...prev, mistakeId]
    );
  }

  function selectAllArchiveMistakes(items) {
    setSelectedArchiveMistakeIds(items.map((item) => item.id));
  }

  function downloadMistakeWordDoc() {
    if (!requireMemberAction("下载错题分析Word", downloadMistakeWordDoc, "下载AI分析文档需要登录并开通会员。")) return;
    if (!mistakeResult) {
      setAiNotice({ page: activePage, message: "请先完成一次AI处理，再下载Word文档。" });
      return;
    }
    const title = mistakeResult.title || mistakeQuickTasks[mistakeTaskType]?.label || "错题专项分析";
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${renderMistakeReportHtml(mistakeResult)}</body></html>`;
    const blob = new Blob([html], { type: "application/msword;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title}.doc`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadSelectedMistakesPdf(visibleItems) {
    if (!requireMemberAction("打包下载错题PDF", () => downloadSelectedMistakesPdf(visibleItems), "错题档案打包下载需要登录并开通会员。")) return;
    const selectedItems = visibleItems.filter((item) => selectedArchiveMistakeIds.includes(item.id));
    if (!selectedItems.length) {
      setAiNotice({ page: activePage, message: "请先在错题档案里选择至少一道错题。" });
      return;
    }
    printPage("打包下载错题PDF", "系统会把你选择的错题整理为打印版；在打印窗口中选择“另存为PDF”。");
  }

  async function generateKnowledgeNote() {
    if (!requireMemberAction("AI生成知识图", generateKnowledgeNote, "知识图生成会调用AI图片与讲解能力，需要会员权限。")) return;
    if (knowledgeAiStatus === "loading") return;
    setKnowledgeAiStatus("loading");
    console.info("树子AI任务提示词", buildAgentPrompt("knowledgeNote", buildStudentArchiveSnapshot({ answers, records, mistakes })));
    try {
      clearAiNotice();
      const data = await apiRequest("/ai/knowledge-note", {
        method: "POST",
        body: JSON.stringify({
          topic: knowledgeQuestion,
          grade: answers.grade,
          subject: "",
          useTemplate: knowledgeUseTemplate,
          template: knowledgePromptTemplate,
        }),
      });
      if (data.imageBase64) {
        setKnowledgeNote({
          title: knowledgeQuestion,
          subtitle: "AI生成知识图",
          points: [],
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254"><image href="data:image/png;base64,${data.imageBase64}" width="1254" height="1254"/></svg>`,
          prompt: data.note?.prompt || "",
        });
        setKnowledgeAiStatus("done");
        return;
      }
    } catch (error) {
      showAiError(error, "服务器知识图生成暂时不可用，已使用前端知识图。");
    }
    setKnowledgeNote(buildKnowledgeNote(knowledgeQuestion));
    setKnowledgeAiStatus("done");
  }

  function downloadKnowledgeImage() {
    if (!requireMemberAction("下载知识图", downloadKnowledgeImage, "下载学习资料和知识图片需要会员权限。")) return;
    const svgBlob = new Blob([knowledgeNote.svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${knowledgeNote.title}.svg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    recordDownload("下载知识图", `${knowledgeNote.title}.svg`, "AI知识图");
  }

  function runStrategyAi(section, mode, targetId = "") {
    if (!requireMemberAction("AI生成或优化学习策略", () => runStrategyAi(section, mode, targetId), "科目策略、任务建议和AI修改都需要结合学生画像调用AI能力，需要会员权限。")) return;
    console.info("树子AI任务提示词", buildAgentPrompt("strategy", buildStudentArchiveSnapshot({ answers, records, mistakes, strategies: strategyWorkspaces })));
    const subject = activeSubject;
    const data = subjectStrategyData[subject];
    const studentName = answers.name || "这位同学";
    const weakSubjects = Array.isArray(answers.weakSubjects) ? answers.weakSubjects.join("、") : "暂未填写";
    const problemText = answers.coreProblemText || aiInsight?.core || "目前主要表现为学习链不完整，需要把策略拆成可执行任务。";
    const actionLabel = mode === "revise" ? "AI已帮你修改" : mode === "generate" ? "AI已生成" : "AI已提出建议";

    setStrategyAiStatus(`${actionLabel}：${subject} · ${section}`);

    if (section === "strategy") {
      updateStrategyWorkspace(subject, (workspace) => ({
        ...workspace,
        strategySuggestion: `${studentName}当前弱项集中在${weakSubjects}。针对${subject}，建议先围绕“${problemText}”建立学习策略：${data.strategy} 本周不要追求任务数量，而要先保证每天有一个能完成、能记录、能复盘的小闭环。`,
        aiNote: `已结合学情画像为${subject}生成策略建议。接受后，它才会作为本学科正式策略继续使用。`,
      }));
      return;
    }

    if (section === "task") {
      if (!targetId) {
        updateStrategyWorkspace(subject, (workspace) => ({
          ...workspace,
          tasks: [
            ...workspace.tasks,
            {
              id: `${subject}-ai-task-${Date.now()}`,
              title: `${subject}AI建议任务`,
              problem: problemText,
              time: "本周选择 2-3 次，每次 25-40 分钟",
              material: workspace.materials?.[0]?.name || "课本、课堂笔记、错题本",
              detail: `围绕当前学情画像中的主要问题，先完成一个小任务：准备资料，完成基础练习，记录错因或收获，再让AI继续帮忙优化。`,
              standard: "能说清楚这个任务解决了什么问题，完成后留下记录，并知道下一次如何复测。",
              studentNote: "",
            },
          ],
        }));
        return;
      }
      updateStrategyWorkspace(subject, (workspace) => ({
        ...workspace,
        tasks: workspace.tasks.map((task) =>
          task.id === targetId
            ? {
                ...task,
                detail: `${task.detail} AI建议：先把任务控制在一个明确时间段内，开始前准备好${task.material}，完成后立刻记录一个收获和一个问题。`,
                standard: `${task.standard} 同时要求学生能用一句话说明：我今天这个任务解决了什么问题。`,
              }
            : task
        ),
      }));
      return;
    }

  }

  function printPage(actionName = "下载或打印PDF", message = "PDF下载和打印属于会员资料导出能力，需要登录并开通会员。") {
    if (!requireMemberAction(actionName, () => printPage(actionName, message), message)) return;
    recordDownload(actionName, "浏览器打印或另存为PDF", window.location.href);
    window.print();
  }

  function downloadProtectedFile(href, filename, actionName) {
    requireMemberAction(actionName, () => {
      const link = document.createElement("a");
      link.href = href;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      recordDownload(actionName, filename, href);
    }, "下载学习工具表格需要会员权限。");
  }

  function updateForumDraft(field, value) {
    setForumDraft((prev) => ({ ...prev, [field]: value }));
  }

  function createForumPost() {
    if (!requireMemberAction("在学习社区发帖", createForumPost, "社区内容可以公开浏览，但发帖、分享学习问题和向版主提问需要会员权限。")) return;
    const title = forumDraft.title.trim();
    const content = forumDraft.content.trim();
    if (!title || !content) return;
    const next = {
      id: `post-${Date.now()}`,
      type: forumDraft.type,
      title,
      content,
      author: member.identifier || "会员同学",
      time: "刚刚",
      likes: 0,
      replies: [],
    };
    setForumPosts((prev) => [next, ...prev]);
    setActiveForumPostId(next.id);
    setForumDraft((prev) => ({ ...prev, title: "", content: "" }));
  }

  function addForumReply() {
    if (!requireMemberAction("在学习社区留言", addForumReply, "社区帖子可以浏览，但留言、讨论和追问版主需要会员权限。")) return;
    const content = forumDraft.reply.trim();
    if (!content) return;
    const reply = {
      id: `reply-${Date.now()}`,
      author: member.identifier || "会员同学",
      role: "member",
      time: "刚刚",
      content,
    };
    setForumPosts((prev) => prev.map((post) => (post.id === activeForumPostId ? { ...post, replies: [...post.replies, reply] } : post)));
    setForumDraft((prev) => ({ ...prev, reply: "" }));
  }

  function handleFreeAskFiles(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const nextFiles = files.map((file) => ({
      id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      type: file.type || "unknown",
      size: file.size,
      rawFile: file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : "",
    }));
    setFreeAskFiles((prev) => [...prev, ...nextFiles]);
    event.target.value = "";
  }

  function removeFreeAskFile(fileId) {
    setFreeAskFiles((prev) => {
      const target = prev.find((file) => file.id === fileId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((file) => file.id !== fileId);
    });
  }

  async function sendFreeAsk() {
    if (!requireMemberAction("使用AI自由问", sendFreeAsk, "AI自由问可以回答问题、识别上传材料、生成学习解释或知识图片，需要登录并开通会员后使用。")) return;
    if (freeAskSendingRef.current || freeAskStatus === "loading") return;
    const content = freeAskInput.trim();
    if (!content && !freeAskFiles.length) return;
    const fileSignature = freeAskFiles.map((file) => `${file.name}:${file.size}:${file.type}`).join("|");
    const submitSignature = `${content}::${fileSignature}`;
    const now = Date.now();
    if (freeAskLastSubmitRef.current.signature === submitSignature && now - freeAskLastSubmitRef.current.time < 3000) return;
    freeAskSendingRef.current = true;
    freeAskLastSubmitRef.current = { signature: submitSignature, time: now };
    setFreeAskStatus("loading");
    clearAiNotice();
    console.info("树子AI任务提示词", buildAgentPrompt("freeAsk", buildStudentArchiveSnapshot({ answers, records, mistakes })));
    const wantsImage = /图|图片|结构图|画|生成图片|知识卡片/.test(content);
    const selectedModel = freeAskModelOptions.find((option) => option.value === freeAskModelChoice) || freeAskModelOptions[0];
    const attachmentText = freeAskFiles.length ? `我上传了 ${freeAskFiles.length} 个附件，请结合附件一起看。` : "";
    const assistantId = `ask-ai-${Date.now()}`;
    const userMessage = {
      id: `ask-user-${Date.now()}`,
      role: "user",
      content: content || attachmentText,
      attachments: freeAskFiles,
    };
    const assistantMessage = {
      id: assistantId,
      role: "assistant",
      content: "我正在阅读你的问题和附件，请稍等。",
      note: null,
    };
    setFreeAskMessages((prev) => [...prev, userMessage, assistantMessage]);
    setFreeAskInput("");
    setFreeAskFiles([]);
    try {
      const formData = new FormData();
      formData.append("question", content);
      formData.append("wantsImage", wantsImage ? "true" : "false");
      formData.append("provider", selectedModel.provider);
      formData.append("mode", selectedModel.mode);
      freeAskFiles.forEach((file) => {
        if (file.rawFile) formData.append("files", file.rawFile);
      });
      const data = await apiRequest("/ai/free-ask", {
        method: "POST",
        body: formData,
      });
      const note = wantsImage ? buildKnowledgeNote(content.replace(/生成|图片|结构图|画|知识卡片/g, "").trim() || content) : null;
      setFreeAskMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: data.answer || "AI已完成回答，但返回内容为空，请换一种问法再试。",
                note,
              }
            : message
        )
      );
    } catch (error) {
      showAiError(error, "AI自由问暂时没有响应，请稍后再试。");
      setFreeAskMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: "AI自由问暂时没有响应。你可以稍后再试，或者把问题拆短一点重新发送。",
                note: wantsImage ? buildKnowledgeNote(content.replace(/生成|图片|结构图|画|知识卡片/g, "").trim() || content) : null,
              }
            : message
        )
      );
    } finally {
      freeAskSendingRef.current = false;
      setFreeAskStatus("idle");
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img src="/assets/shuzi-logo.png" alt="树子AI" />
          </div>
          <div>
            <strong>树子AI</strong>
            <span>个人AI学习教练</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="树子AI功能导航">
          {subPages.map(({ id, label, icon: Icon }) => (
            <button key={id} className={activePage === id ? "nav-item is-active" : "nav-item"} onClick={() => setActivePage(id)}>
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="member-sidebar-card">
          <span className="eyebrow">会员状态</span>
            <strong>{member.isPaid ? "已开通会员" : member.isLoggedIn ? "未开通会员" : "未登录"}</strong>
            <p>
              {member.isLoggedIn
              ? `${member.identifier} · ${member.isPaid ? `${member.plan || "正式会员"}${member.daysRemaining !== null ? ` · 剩余${Math.max(member.daysRemaining, 0)}天` : ""}` : "可浏览，AI功能需开通"} · 存储 ${member.storageTotalMb || 50}MB`
              : "可浏览全部功能，AI分析和下载需登录并开通会员。"}
            </p>
          {accountNotice && <p className="account-notice">{accountNotice}</p>}
        </div>
        <button type="button" className="admin-sidebar-button" onClick={() => setActivePage("admin")}>
          <LockKeyhole size={16} />
          管理员中心
        </button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-actions">
            <button className={member.isPaid ? "member-pill is-active" : "member-pill"} onClick={loadMemberCenter}>
              {member.isPaid ? <Crown size={17} /> : <LockKeyhole size={17} />}
              {member.isLoggedIn ? "会员中心" : "登录 / 注册"}
            </button>
            {member.isLoggedIn && (
              <button className="ghost-action" onClick={logoutMember}>
                <LogOut size={17} />
                退出
              </button>
            )}
          </div>
        </header>
        {activeAiNotice && (
          <div className="ai-service-notice" role="status">
            <div>
              <strong>AI服务提示</strong>
              <p>{activeAiNotice}</p>
            </div>
            <button type="button" onClick={clearAiNotice} aria-label="关闭AI服务提示">
              ×
            </button>
          </div>
        )}

        {activePage === "home" && <HomePage setActivePage={setActivePage} />}

        {activePage === "questionnaire" && (
          <QuestionnairePage
            answers={answers}
            questionnaireSteps={questionnaireSteps}
            currentStep={currentStep}
            progress={progress}
            completion={completion}
            lastSaved={lastSaved}
            submitted={submitted}
            setCurrentStep={setCurrentStep}
            updateAnswer={updateAnswer}
            toggleMulti={toggleMulti}
            saveDraft={saveDraft}
            submitQuestionnaire={submitQuestionnaire}
          />
        )}

        {activePage === "statement" && (
          <ModernStatementPage
            statementText={statementText}
            setStatementText={setStatementText}
            saveStatement={saveStatement}
            statementSubject={statementSubject}
            setStatementSubject={setStatementSubject}
            statementScene={statementScene}
            setStatementScene={setStatementScene}
            statementIntensity={statementIntensity}
            setStatementIntensity={setStatementIntensity}
            guidedAnswers={guidedAnswers}
            setGuidedAnswers={setGuidedAnswers}
            issueDetails={statementIssueDetails}
            toggleIssue={toggleStatementIssue}
            updateIssueDetail={updateStatementIssueDetail}
            recordingState={recordingState}
            startRecording={startRecording}
            stopRecording={stopRecording}
            uploadAudio={uploadAudio}
            audioUrl={audioUrl}
            records={records}
            aiStatus={aiStatus}
            aiInsight={aiInsight}
          />
        )}

        {activePage === "profile" && (
          <ModernProfilePage
            answers={answers}
            records={records}
            aiInsight={aiInsight}
            aiStatus={aiStatus}
            submitted={submitted}
            completion={completion}
            printPage={printPage}
            generateProfileAnalysis={generateProfileAnalysis}
          />
        )}

        {activePage === "strategy" && (
          <StrategyDesignPage
            activeSubject={activeSubject}
            setActiveSubject={setActiveSubject}
            workspaces={strategyWorkspaces}
            answers={answers}
            aiInsight={aiInsight}
            strategyAiStatus={strategyAiStatus}
            updateStrategyText={updateStrategyText}
            updateStrategyTask={updateStrategyTask}
            updateMaterialUsage={updateMaterialUsage}
            updateCustomMaterial={updateCustomMaterial}
            addCustomMaterial={addCustomMaterial}
            addStrategyTask={addStrategyTask}
            acceptStrategySuggestion={acceptStrategySuggestion}
            rejectStrategySuggestion={rejectStrategySuggestion}
            runStrategyAi={runStrategyAi}
          />
        )}

        {activePage === "plan" && (
          <StudyPlanPage
            planRows={planRows}
            updatePlanCell={updatePlanCell}
            addPlanRow={addPlanRow}
            runPlanAi={runPlanAi}
            planAiStatus={planAiStatus}
            removePlanRow={removePlanRow}
            planNote={planNote}
            setPlanNote={setPlanNote}
            methodFocusRows={methodFocusRows}
            habitFocusRows={habitFocusRows}
            updateFocusRow={updateFocusRow}
            updateFocusScore={updateFocusScore}
            printPage={printPage}
            downloadProtectedFile={downloadProtectedFile}
          />
        )}

        {activePage === "mistakes" && (
          <MistakeSpecialPage
            mistakes={mistakes}
            mistakeDraft={mistakeDraft}
            mistakeWorkspaceTab={mistakeWorkspaceTab}
            setMistakeWorkspaceTab={setMistakeWorkspaceTab}
            mistakePrompt={mistakePrompt}
            setMistakePrompt={setMistakePrompt}
            mistakeTaskType={mistakeTaskType}
            applyMistakeQuickTask={applyMistakeQuickTask}
            mistakeResult={mistakeResult}
            selectedArchiveMistakeIds={selectedArchiveMistakeIds}
            mistakeArchiveSubject={mistakeArchiveSubject}
            setMistakeArchiveSubject={setMistakeArchiveSubject}
            updateMistakeDraft={updateMistakeDraft}
            handleMistakeFile={handleMistakeFile}
            removeMistakeUpload={removeMistakeUpload}
            runMistakeWorkspaceAi={runMistakeWorkspaceAi}
            selectedMistakeId={selectedMistakeId}
            setSelectedMistakeId={setSelectedMistakeId}
            mistakeAiStatus={mistakeAiStatus}
            toggleArchiveMistake={toggleArchiveMistake}
            selectAllArchiveMistakes={selectAllArchiveMistakes}
            downloadMistakeWordDoc={downloadMistakeWordDoc}
            downloadSelectedMistakesPdf={downloadSelectedMistakesPdf}
          />
        )}

        {activePage === "notes" && (
          <ModernKnowledgeNotePage
            knowledgeQuestion={knowledgeQuestion}
            setKnowledgeQuestion={setKnowledgeQuestion}
            knowledgeNote={knowledgeNote}
            generateKnowledgeNote={generateKnowledgeNote}
            downloadKnowledgeImage={downloadKnowledgeImage}
            status={knowledgeAiStatus}
            useTemplate={knowledgeUseTemplate}
            setUseTemplate={setKnowledgeUseTemplate}
            promptTemplate={knowledgePromptTemplate}
            setPromptTemplate={setKnowledgePromptTemplate}
          />
        )}

        {activePage === "calendar" && (
          <LearningCalendarPage
            events={calendarEvents}
            cursor={calendarCursor}
            setCursor={setCalendarCursor}
            editor={calendarEditor}
            openEditor={openCalendarEditor}
            updateEditor={updateCalendarEditor}
            quickCreateEvent={quickCreateCalendarEvent}
            saveEvent={saveCalendarEvent}
            removeEvent={removeCalendarEvent}
            closeEditor={closeCalendarEditor}
            fileInputRef={calendarFileInputRef}
            pickFiles={pickCalendarFiles}
            previewFile={previewCalendarFile}
            downloadFile={downloadCalendarFile}
            status={calendarStatus}
            member={member}
          />
        )}

        {activePage === "library" && (
          <LearningLibraryPage
            items={libraryItems}
            view={libraryView}
            setView={(view) => {
              closeLibraryPreview();
              setLibraryEditor(null);
              setLibraryView(view);
              if (view !== "drive") setLibraryFolderId(null);
            }}
            folderId={libraryFolderId}
            setFolderId={setLibraryFolderId}
            search={librarySearch}
            setSearch={setLibrarySearch}
            sort={librarySort}
            setSort={setLibrarySort}
            sortDir={librarySortDir}
            setSortDir={setLibrarySortDir}
            reload={loadLibraryItems}
            createFolder={createLibraryFolder}
            createDocument={createLibraryDocument}
            uploadFiles={uploadLibraryFiles}
            updateItem={updateLibraryItem}
            openItem={openLibraryItem}
            downloadFile={downloadLibraryFile}
            editor={libraryEditor}
            setEditor={setLibraryEditor}
            preview={libraryPreview}
            openPreview={openLibraryPreview}
            closePreview={closeLibraryPreview}
            fileInputRef={libraryFileInputRef}
            folderInputRef={libraryFolderInputRef}
            status={libraryStatus}
            member={member}
          />
        )}

        {activePage === "forum" && (
          <LearningForumPage
            posts={forumPosts}
            activePostId={activeForumPostId}
            setActivePostId={setActiveForumPostId}
            draft={forumDraft}
            updateDraft={updateForumDraft}
            createPost={createForumPost}
            addReply={addForumReply}
            member={member}
            requireMemberAction={requireMemberAction}
          />
        )}

        {activePage === "freeAsk" && (
          <FreeAskPage
            messages={freeAskMessages}
            input={freeAskInput}
            setInput={setFreeAskInput}
            files={freeAskFiles}
            handleFiles={handleFreeAskFiles}
            removeFile={removeFreeAskFile}
            sendFreeAsk={sendFreeAsk}
            status={freeAskStatus}
            modelChoice={freeAskModelChoice}
            setModelChoice={setFreeAskModelChoice}
          />
        )}

        {activePage === "memberCenter" && (
          <MemberCenterPage
            member={member}
            state={memberCenter}
            setState={setMemberCenter}
            refresh={loadMemberCenter}
            updateProfile={updateMemberProfile}
            updatePassword={updateMemberPassword}
            openPayment={openPaymentModal}
          />
        )}

        {activePage === "admin" && (
          <AdminPanelPage
            state={adminPanel}
            setState={setAdminPanel}
            loginAdmin={loginAdmin}
            loadUsers={loadAdminUsers}
            loadOrders={loadAdminOrders}
            confirmOrder={adminConfirmOrder}
            cancelOrder={adminCancelOrder}
            activateMembership={adminActivateMembership}
            rechargeToken={adminRechargeToken}
            plans={memberPlans}
            tokenPackages={tokenPackages}
          />
        )}
      </main>

      {authModal.open && (
        <MemberModal
          member={member}
          authModal={authModal}
          authForm={authForm}
          setAuthForm={setAuthForm}
          completeAuth={completeAuth}
          checkout={checkout}
          setCheckout={setCheckout}
          submitCheckoutPaid={submitCheckoutPaid}
          closeAuthModal={closeAuthModal}
          memberPlans={memberPlans}
          tokenPackages={tokenPackages}
        />
      )}
    </div>
  );
}

function HomePage({ setActivePage }) {
  const workflow = [
    ["1", "学习问题分析", "通过学情问卷、学情陈述和学生自评，先把孩子的问题说清楚。"],
    ["2", "形成学情画像", "把问卷、陈述、AI分析和学生自我评价整合成可理解的画像报告。"],
    ["3", "制定策略与任务", "每个科目形成学习策略、资料使用方法和具体学习任务。"],
    ["4", "学习计划与训练", "把任务安排进每周计划，并通过错题专项和知识笔记持续训练。"],
  ];
  return (
    <section className="stack home-page">
      <div className="hero-band compact home-hero">
        <div>
          <span className="eyebrow">树子AI · 个人AI学习教练</span>
          <div className="home-belief">让AI更懂你，它就可以更好的帮助你！</div>
        </div>
        <div className="strategy-status">
          <strong>AI</strong>
          <span>学习教练</span>
        </div>
      </div>

      <section className="panel home-about-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">什么是树子AI？</span>
            <h2>一个帮助学生学习成长的AI学习伙伴</h2>
          </div>
          <Sparkles size={24} />
        </div>
        <div className="home-about-grid">
          <article className="home-about-main">
            <strong>核心理念：让AI更了解你的学习情况，从而更精准地帮助你。</strong>
            <p>
              树子AI会先了解学生的问卷、陈述、试卷和错题，再帮助分析学习问题、制定科目策略、安排学习计划、整理错题和知识盲点，并陪伴学生长期改进。
            </p>
          </article>
          <article>
            <strong>学生可以随时提问</strong>
            <p>学习问题、方法困惑、计划安排、复习方向、作业题目和知识点，都可以在这里继续追问。</p>
          </article>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">工作流程</span>
            <h2>从学情分析到个性化训练</h2>
          </div>
          <Brain size={24} />
        </div>
        <div className="home-flow-intro">
          <h3>先看清孩子的学习问题，再设计真正能执行的学习通路</h3>
          <p>先通过问卷、陈述和学习材料了解孩子，再生成学情画像，继续制定科目策略、学习计划、错题训练和知识笔记，帮助学生把问题一步步转化成可以执行的行动。</p>
        </div>
        <div className="home-workflow">
          {workflow.map(([index, title, desc]) => (
            <article key={title}>
              <span>{index}</span>
              <strong>{title}</strong>
              <p>{desc}</p>
            </article>
          ))}
        </div>
        <div className="ai-action-row">
          <button type="button" className="primary-action" onClick={() => setActivePage("questionnaire")}>
            开始学情问卷
          </button>
          <button type="button" className="ghost-action" onClick={() => setActivePage("statement")}>
            进入学情陈述
          </button>
        </div>
      </section>
    </section>
  );
}

function LearningCalendarPage({
  events,
  cursor,
  setCursor,
  editor,
  openEditor,
  updateEditor,
  quickCreateEvent,
  saveEvent,
  removeEvent,
  closeEditor,
  fileInputRef,
  pickFiles,
  previewFile,
  downloadFile,
  status,
  member,
}) {
  const [quickDraft, setQuickDraft] = useState(null);
  const [selectedDate, setSelectedDate] = useState(toDateKey(new Date()));
  const [expandedPreview, setExpandedPreview] = useState(null);
  const quickDraftSavingRef = useRef(false);
  const monthDays = useMemo(() => buildMonthDays(cursor), [cursor]);
  const eventsByDate = useMemo(() => {
    return events.reduce((acc, event) => {
      const key = String(event.eventDate || "").slice(0, 10);
      if (!acc[key]) acc[key] = [];
      acc[key].push(event);
      return acc;
    }, {});
  }, [events]);
  const monthTitle = `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`;

  function shiftMonth(delta) {
    const next = new Date(cursor);
    next.setMonth(cursor.getMonth() + delta);
    setCursor(next);
  }

  function beginQuickDraft(dateKey) {
    setSelectedDate(dateKey);
    setQuickDraft({ dateKey, title: "" });
  }

  async function commitQuickDraft() {
    if (!quickDraft) return;
    if (quickDraftSavingRef.current) return;
    quickDraftSavingRef.current = true;
    const title = quickDraft.title.trim();
    setQuickDraft(null);
    if (title) await quickCreateEvent(quickDraft.dateKey, title);
    quickDraftSavingRef.current = false;
  }

  return (
    <section className="calendar-page">
      <div className="calendar-hero">
        <div>
          <span className="eyebrow">学习日历</span>
          <h2>用日历记录每天的学习过程</h2>
          <p>双击日期就能建立学习页面，写文字、上传图片，把每天的重要学习痕迹保存进个人档案。</p>
        </div>
        <div className="calendar-hero-actions">
          <button className="ghost-action" type="button" onClick={() => setCursor(new Date())}>今天</button>
          <button className="primary-action" type="button" onClick={() => openEditor(selectedDate || toDateKey(new Date()))}>
            <Plus size={18} /> 新建页面
          </button>
        </div>
      </div>

      <div className="calendar-shell">
        <div className="calendar-toolbar">
          <button className="icon-button" type="button" onClick={() => shiftMonth(-1)} aria-label="上个月">
            <ChevronLeft size={18} />
          </button>
          <strong>{monthTitle}</strong>
          <button className="icon-button" type="button" onClick={() => shiftMonth(1)} aria-label="下个月">
            <ChevronRight size={18} />
          </button>
          {status === "loading" && <span className="muted-inline">正在同步...</span>}
          {!member.isLoggedIn && <span className="muted-inline">登录后可以保存自己的日历页面。</span>}
        </div>
        <div className="calendar-weekdays">
          {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((day) => <span key={day}>{day}</span>)}
        </div>
        <div className="calendar-grid">
          {monthDays.map((day) => {
            const dayEvents = eventsByDate[day.key] || [];
            return (
              <div
                key={day.key}
                role="button"
                tabIndex={0}
                className={`calendar-day ${day.inMonth ? "" : "is-muted"} ${day.key === toDateKey(new Date()) ? "is-today" : ""} ${day.key === selectedDate ? "is-selected" : ""}`}
                onClick={() => setSelectedDate(day.key)}
                onDoubleClick={() => beginQuickDraft(day.key)}
              >
                <span className="calendar-date">{Number(day.key.slice(-2))}</span>
                <div className="calendar-event-list">
                  {dayEvents.slice(0, 4).map((event) => (
                    <span
                      key={event.id}
                      className="calendar-event-pill"
                      onClick={(eventClick) => {
                        eventClick.stopPropagation();
                        openEditor(day.key, event);
                      }}
                    >
                      {event.title}
                    </span>
                  ))}
                  {quickDraft?.dateKey === day.key && (
                    <input
                      className="calendar-title-draft"
                      autoFocus
                      value={quickDraft.title}
                      onClick={(eventClick) => eventClick.stopPropagation()}
                      onChange={(event) => setQuickDraft({ dateKey: day.key, title: event.target.value })}
                      onBlur={commitQuickDraft}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitQuickDraft();
                        if (event.key === "Escape") setQuickDraft(null);
                      }}
                      placeholder="输入页面标题"
                    />
                  )}
                  {dayEvents.length > 4 && <span className="calendar-more">还有 {dayEvents.length - 4} 条</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {editor && (
        <div className="modal-backdrop calendar-modal-backdrop" onMouseDown={closeEditor}>
          <div className="calendar-editor-panel calendar-editor-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-heading-row">
              <div>
                <span className="eyebrow">学习页面</span>
                <h3>{editor.id ? "编辑日历子页面" : "新建日历子页面"}</h3>
              </div>
              <button className="icon-button" type="button" onClick={closeEditor}>×</button>
            </div>
            <div className="calendar-editor-grid">
              <label>
                页面标题
                <input value={editor.title} onChange={(event) => updateEditor({ title: event.target.value })} placeholder="例如：数学错题复盘 / 周末阅读记录" />
              </label>
              <label>
                日期
                <input type="date" value={editor.eventDate} onChange={(event) => updateEditor({ eventDate: event.target.value })} />
              </label>
            </div>
            <label>
              记录内容
              <textarea
                rows={9}
                value={editor.content}
                onChange={(event) => updateEditor({ content: event.target.value })}
                placeholder="写下今天发生了什么、学到了什么、哪些问题还需要解决。"
              />
            </label>
            <div className="calendar-upload-row">
              <button className="ghost-action" type="button" onClick={() => fileInputRef.current?.click()}>
                <UploadCloud size={17} /> 上传图片或文件
              </button>
              <input ref={fileInputRef} type="file" hidden multiple onChange={(event) => pickFiles(event.target.files)} />
              <span>图片单张最多 25MB，其他文件按会员存储空间保存。</span>
            </div>
            <div className="attached-file-list is-detailed">
              {(editor.files || []).map((file) => (
                <span key={file.id}>
                  {file.originalName}
                  <button type="button" onClick={() => previewFile(file)}>查看</button>
                  <button type="button" onClick={() => downloadFile(file)}>下载</button>
                </span>
              ))}
              {(editor.newFiles || []).map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
            </div>
            {editor.attachmentPreview && (
              <div className="calendar-inline-preview">
                <div className="panel-heading-row">
                  <div>
                    <span className="eyebrow">附件预览</span>
                    <h4>{editor.attachmentPreview.file.originalName}</h4>
                  </div>
                  {(editor.attachmentPreview.kind === "image" || editor.attachmentPreview.kind === "pdf") && (
                    <button className="ghost-action is-compact" type="button" onClick={() => setExpandedPreview(editor.attachmentPreview)}>
                      放大查看
                    </button>
                  )}
                </div>
                <div className={`calendar-preview-body is-${editor.attachmentPreview.kind || "file"}`}>
                  {editor.attachmentPreview.kind === "image" && (
                    <img
                      src={editor.attachmentPreview.url}
                      alt={editor.attachmentPreview.file.originalName}
                      onClick={() => setExpandedPreview(editor.attachmentPreview)}
                    />
                  )}
                  {editor.attachmentPreview.kind === "pdf" && <iframe src={editor.attachmentPreview.url} title={editor.attachmentPreview.file.originalName} />}
                  {editor.attachmentPreview.kind === "text" && <pre>{editor.attachmentPreview.text}</pre>}
                  {editor.attachmentPreview.kind === "audio" && <audio controls src={editor.attachmentPreview.url} />}
                  {editor.attachmentPreview.kind === "video" && <video controls src={editor.attachmentPreview.url} />}
                  {!editor.attachmentPreview.kind && <p>这个文件暂不支持在线预览，可以先下载查看。</p>}
                </div>
              </div>
            )}
            {expandedPreview && (
              <div className="calendar-preview-lightbox" onMouseDown={() => setExpandedPreview(null)}>
                <div className={`calendar-preview-lightbox-body is-${expandedPreview.kind}`} onMouseDown={(event) => event.stopPropagation()}>
                  <button className="icon-button" type="button" onClick={() => setExpandedPreview(null)}>×</button>
                  {expandedPreview.kind === "image" && <img src={expandedPreview.url} alt={expandedPreview.file.originalName} />}
                  {expandedPreview.kind === "pdf" && <iframe src={expandedPreview.url} title={expandedPreview.file.originalName} />}
                </div>
              </div>
            )}
            <div className="panel-actions">
              {editor.id && (
                <button className="ghost-danger" type="button" onClick={() => removeEvent(editor.id)}>
                  <Trash2 size={17} /> 删除
                </button>
              )}
              <button className="primary-action" type="button" onClick={saveEvent} disabled={status === "saving"}>
                {status === "saving" ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
                保存页面
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function LearningLibraryPage({
  items,
  view,
  setView,
  folderId,
  setFolderId,
  search,
  setSearch,
  sort,
  setSort,
  sortDir,
  setSortDir,
  reload,
  createFolder,
  uploadFiles,
  updateItem,
  openItem,
  downloadFile,
  editor,
  setEditor,
  preview,
  openPreview,
  closePreview,
  fileInputRef,
  folderInputRef,
  status,
  member,
}) {
  const storageUsed = member.storageUsedBytes || 0;
  const storageTotal = (member.storageTotalMb || 50) * 1024 * 1024;
  const storagePercent = Math.min(100, Math.round((storageUsed / Math.max(storageTotal, 1)) * 100));
  const [drivePage, setDrivePage] = useState(1);
  const drivePageSize = 20;
  const totalDrivePages = Math.max(1, Math.ceil(items.length / drivePageSize));
  const currentDrivePage = Math.min(drivePage, totalDrivePages);
  const visibleDriveItems = items.slice((currentDrivePage - 1) * drivePageSize, currentDrivePage * drivePageSize);

  useEffect(() => {
    setDrivePage(1);
  }, [view, folderId, search, sort, sortDir]);

  async function saveEditor() {
    if (!editor) return;
    const saved = await updateItem(editor, { name: editor.name, notes: editor.notes });
    if (saved) setEditor(saved);
  }

  return (
    <section className="drive-page">
      <aside className="drive-sidebar">
        <button className="drive-new-button" type="button" onClick={createFolder}>
          <FolderPlus size={20} /> 新建文件夹
        </button>
        {libraryViews.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} type="button" className={view === item.id ? "drive-view is-active" : "drive-view"} onClick={() => setView(item.id)}>
              <Icon size={17} /> {item.label}
            </button>
          );
        })}
        <div className="drive-storage">
          <div className="storage-bar">
            <span style={{ width: `${storagePercent}%` }} />
          </div>
          <p>已使用 {formatFileSize(storageUsed)}，共 {member.storageTotalMb || 50}MB</p>
        </div>
      </aside>

      <div className="drive-main">
        <div className="drive-topbar">
          <div className="drive-search">
            <Search size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && reload()}
              placeholder="在学习资料库中搜索"
            />
          </div>
          <div className="drive-actions">
            <button className="ghost-action" type="button" onClick={createFolder}>
              <FolderPlus size={17} /> 新建文件夹
            </button>
            <button className="primary-action" type="button" onClick={() => fileInputRef.current?.click()}>
              <UploadCloud size={17} /> 上传资料
            </button>
            <button className="ghost-action" type="button" onClick={() => folderInputRef.current?.click()}>
              <FolderOpen size={17} /> 上传文件夹
            </button>
            <input ref={fileInputRef} type="file" hidden multiple onChange={(event) => uploadFiles(event.target.files)} />
            <input ref={folderInputRef} type="file" hidden multiple webkitdirectory="" directory="" onChange={(event) => uploadFiles(event.target.files)} />
          </div>
        </div>

        <div className="drive-title-row">
          <div className="drive-title-line">
            <div>
              <span className="eyebrow">学习资料库</span>
              <h2>{libraryViews.find((item) => item.id === view)?.label || "我的云端硬盘"}</h2>
            </div>
            {folderId && (
              <button className="ghost-action is-compact" type="button" onClick={() => setFolderId(null)}>
                返回上一级
              </button>
            )}
          </div>
          {status === "loading" && <span className="muted-inline">正在同步...</span>}
        </div>

        {view !== "storage" && (
          <div className="drive-filter-row">
            <label>
              排序
              <select value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="name">名称</option>
                <option value="date">日期</option>
                <option value="size">大小</option>
              </select>
            </label>
            <label>
              方向
              <select value={sortDir} onChange={(event) => setSortDir(event.target.value)}>
                <option value="asc">升序</option>
                <option value="desc">降序</option>
              </select>
            </label>
            <button className="ghost-action" type="button" onClick={reload}>刷新</button>
          </div>
        )}

        {view === "storage" ? (
          <div className="storage-summary-card">
            <HardDrive size={34} />
            <h3>存储空间</h3>
            <p>当前已使用 {formatFileSize(storageUsed)}，总空间 {member.storageTotalMb || 50}MB。</p>
            <div className="storage-bar is-large">
              <span style={{ width: `${storagePercent}%` }} />
            </div>
          </div>
        ) : (
          <div className="drive-list">
            <div className="drive-list-head">
              <span>名称</span>
              <span>类型</span>
              <span>大小</span>
              <span>修改时间</span>
              <span>操作</span>
            </div>
            <div className="drive-list-scroll">
              {items.length === 0 && <div className="empty-state">这里还没有资料，可以先新建文件夹或上传学习材料。</div>}
              {visibleDriveItems.map((item) => {
                const Icon = fileIconFor(item);
                return (
                  <div key={item.id} className="drive-row">
                    <button type="button" className="drive-name" onClick={() => openItem(item)}>
                      <Icon size={20} /> <span>{item.name}</span>
                    </button>
                    <span>{fileTypeLabel(item)}</span>
                    <span>{item.type === "folder" ? "-" : formatFileSize(item.sizeBytes)}</span>
                    <span>{item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : "-"}</span>
                    <div className="drive-row-actions">
                      <button className="icon-button" type="button" onClick={() => updateItem(item, { isStarred: !item.isStarred })} title="星标">
                        <Star size={16} fill={item.isStarred ? "currentColor" : "none"} />
                      </button>
                      {previewKindFor(item) && (
                        <button className="ghost-action is-compact" type="button" onClick={() => openPreview(item)}>
                          预览
                        </button>
                      )}
                      {item.fileId && (
                        <button className="ghost-action is-compact" type="button" onClick={() => downloadFile(item)}>
                          下载
                        </button>
                      )}
                      <button
                        className="icon-button"
                        type="button"
                        onClick={async () => {
                          const saved = await updateItem(item, { isTrashed: view === "trash" ? false : true });
                          if (saved) {
                            if (editor?.id === item.id) setEditor(null);
                            if (preview?.item?.id === item.id) closePreview();
                            reload();
                          }
                        }}
                        title={view === "trash" ? "恢复" : "移入回收站"}
                      >
                        {view === "trash" ? <Clock3 size={16} /> : <Trash2 size={16} />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {items.length > drivePageSize && (
              <div className="drive-list-footer">
                <span>
                  第 {currentDrivePage} / {totalDrivePages} 页，共 {items.length} 个项目
                </span>
                <div>
                  <button className="ghost-action is-compact" type="button" onClick={() => setDrivePage((page) => Math.max(1, page - 1))} disabled={currentDrivePage <= 1}>
                    上一页
                  </button>
                  <button className="ghost-action is-compact" type="button" onClick={() => setDrivePage((page) => Math.min(totalDrivePages, page + 1))} disabled={currentDrivePage >= totalDrivePages}>
                    下一页
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {(preview || editor) && (() => {
        const activeItem = editor || preview?.item;
        const previewKind = preview?.kind || "";
        const canPreview = Boolean(preview && ["image", "pdf", "text", "audio", "video"].includes(previewKind));
        return (
          <div className={`library-workspace ${canPreview ? "has-preview" : "notes-only"}`}>
            <div className="panel-heading-row">
              <div>
                <span className="eyebrow">{canPreview ? "预览与整理" : "资料整理"}</span>
                <input value={activeItem.name} onChange={(event) => setEditor({ ...activeItem, name: event.target.value })} />
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  closePreview();
                  setEditor(null);
                }}
              >
                ×
              </button>
            </div>
            <div className="library-workspace-grid">
              <section className="library-preview-pane">
                <span className="field-title">资料预览</span>
                {canPreview ? (
                  <div className={`library-preview-body is-${previewKind}`}>
                    {previewKind === "image" && <img src={preview.url} alt={activeItem.name} />}
                    {previewKind === "pdf" && <iframe src={preview.url} title={activeItem.name} />}
                    {previewKind === "text" && <pre>{preview.text || activeItem.content || "这个文本文件暂时没有可显示内容。"}</pre>}
                    {previewKind === "audio" && <audio controls src={preview.url} />}
                    {previewKind === "video" && <video controls src={preview.url} />}
                  </div>
                ) : (
                  <div className="office-no-preview">
                    <FileText size={32} />
                    <strong>此类文件暂不提供在线预览</strong>
                    <p>Word、Excel、PPT 等复杂文件建议下载后查看或修改。原文件不会被改动，你可以在右侧记录摘要、重点和后续任务。</p>
                  </div>
                )}
              </section>
              <section className="library-notes-pane">
                <span className="field-title">学习笔记 / 备注 / 整理内容</span>
                <textarea
                  value={activeItem.notes || ""}
                  onChange={(event) => setEditor({ ...activeItem, notes: event.target.value })}
                  placeholder="在这里记录资料摘要、重点、疑问、使用方法或后续任务。原文件不会被改动。"
                />
              </section>
            </div>
            <div className="panel-actions">
              {activeItem.fileId && <button className="ghost-action" type="button" onClick={() => downloadFile(activeItem)}>下载原文件</button>}
              <button className="primary-action" type="button" onClick={saveEditor}>
                <Save size={17} /> 保存修改
              </button>
            </div>
          </div>
        );
      })()}
    </section>
  );
}

function LearningForumPage({ posts, activePostId, setActivePostId, draft, updateDraft, createPost, addReply, member, requireMemberAction }) {
  const canInteract = member.isLoggedIn && member.isPaid;
  const [activeForumTab, setActiveForumTab] = useState("all");
  const [composeOpen, setComposeOpen] = useState(false);
  const [forumPage, setForumPage] = useState(1);
  const viewerName = member.identifier || "";
  const forumTabs = [
    { id: "all", label: "全部留言" },
    { id: "others", label: "其他人的帖子" },
    { id: "mine", label: "我发的帖子" },
    { id: "moderator", label: "向版主提问" },
  ];
  const filteredPosts = posts.filter((post) => {
    if (activeForumTab === "others") return !viewerName || post.author !== viewerName;
    if (activeForumTab === "mine") return viewerName && post.author === viewerName;
    if (activeForumTab === "moderator") return post.type === "向版主提问";
    return true;
  });
  const forumPageSize = 15;
  const totalForumPages = Math.max(1, Math.ceil(filteredPosts.length / forumPageSize));
  const currentForumPage = Math.min(forumPage, totalForumPages);
  const visibleForumPosts = filteredPosts.slice((currentForumPage - 1) * forumPageSize, currentForumPage * forumPageSize);

  useEffect(() => {
    setForumPage(1);
  }, [activeForumTab, viewerName, posts.length]);

  function openCompose(type = draft.type) {
    if (!canInteract) {
      requireMemberAction("在学习社区发帖", null, "社区可以公开浏览，但发帖、留言和向版主提问需要会员权限。");
      return;
    }
    updateDraft("type", type);
    setComposeOpen(true);
  }

  return (
    <section className="stack forum-page">
      <section className="forum-feed-layout">
        <main className="forum-board">
          <div className="panel forum-board-toolbar">
            <div>
              <span className="eyebrow">留言版块</span>
              <h2>学习问题与心得交流</h2>
            </div>
            <button type="button" className="primary-action forum-new-post-button" onClick={() => openCompose(activeForumTab === "moderator" ? "向版主提问" : "学习问题")}>
              <Plus size={17} />
              发帖
            </button>
          </div>

          <div className="forum-board-tabs" role="tablist" aria-label="学习社区分类">
            {forumTabs.map((tab) => (
              <button key={tab.id} type="button" className={activeForumTab === tab.id ? "is-active" : ""} onClick={() => setActiveForumTab(tab.id)}>
                {tab.label}
              </button>
            ))}
          </div>

          {composeOpen && (
            <article className="panel forum-compose-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">会员发帖</span>
                  <h2>{draft.type === "向版主提问" ? "向版主提出一个具体学习问题" : "分享学习问题、心得或打卡记录"}</h2>
                </div>
                <button type="button" className="ghost-action" onClick={() => setComposeOpen(false)}>
                  收起
                </button>
              </div>
              <div className="forum-compose-grid">
                <label>
                  <span>帖子类型</span>
                  <select value={draft.type} onChange={(event) => updateDraft("type", event.target.value)}>
                    {["学习问题", "学习心得", "向版主提问", "资料交流", "计划打卡"].map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>标题</span>
                  <input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder="例如：数学错题总是反复错怎么办？" />
                </label>
                <label className="wide-field">
                  <span>内容</span>
                  <textarea value={draft.content} onChange={(event) => updateDraft("content", event.target.value)} placeholder="写清楚你的学习问题、具体场景、已经尝试过的方法，或者想分享的心得。" />
                </label>
              </div>
              <div className="forum-action-row">
                <button type="button" className="primary-action" onClick={createPost}>
                  <Send size={17} />
                  发布帖子
                </button>
              </div>
            </article>
          )}

          <div className="forum-thread-list">
            {filteredPosts.length === 0 && (
              <article className="panel forum-empty-state">
                <strong>{activeForumTab === "mine" ? "你还没有发布帖子" : "这个分类下暂时没有帖子"}</strong>
                <p>{activeForumTab === "mine" ? "开通会员后，可以把自己的学习问题、学习心得和向版主提问都保存在这里。" : "可以切换到其他分类查看，或点击发帖创建新的讨论。"}</p>
                <button type="button" className="primary-action" onClick={() => openCompose(activeForumTab === "moderator" ? "向版主提问" : "学习问题")}>
                  <Plus size={17} />
                  发帖
                </button>
              </article>
            )}

            {visibleForumPosts.map((post) => (
              <article key={post.id} className={activePostId === post.id ? "panel forum-thread-card is-active" : "panel forum-thread-card"}>
                <button type="button" className="forum-thread-main" onClick={() => setActivePostId(post.id)}>
                  <div className="forum-thread-head">
                    <div>
                      <span className="forum-tag">{post.type}</span>
                      <h2>{post.title}</h2>
                      <p>{post.author} · {post.time} · {post.replies.length}条回复 · {post.likes}赞</p>
                    </div>
                    <UserRound size={24} />
                  </div>
                  <p className="forum-post-content">{post.content}</p>
                </button>

                <div className="reply-list">
                  {post.replies.map((reply) => (
                    <article key={reply.id} className={reply.role === "moderator" ? "reply-card is-moderator" : "reply-card"}>
                      <div>
                        <strong>{reply.author}</strong>
                        <span>{reply.role === "moderator" ? "版主回复" : "会员留言"} · {reply.time}</span>
                      </div>
                      <p>{reply.content}</p>
                    </article>
                  ))}
                </div>

                {activePostId === post.id && (
                  <div className="reply-compose">
                    <label>
                      <span>留言回复</span>
                      <textarea value={draft.reply} onChange={(event) => updateDraft("reply", event.target.value)} placeholder="会员可以在这里留言、追问版主，或补充自己的经验。" />
                    </label>
                    <button type="button" className="primary-action" onClick={addReply}>
                      <Send size={17} />
                      发表留言
                    </button>
                  </div>
                )}
              </article>
            ))}
            {filteredPosts.length > forumPageSize && (
              <div className="forum-pagination">
                <span>
                  第 {currentForumPage} / {totalForumPages} 页，共 {filteredPosts.length} 个帖子
                </span>
                <div>
                  <button className="ghost-action is-compact" type="button" onClick={() => setForumPage((page) => Math.max(1, page - 1))} disabled={currentForumPage <= 1}>
                    上一页
                  </button>
                  <button className="ghost-action is-compact" type="button" onClick={() => setForumPage((page) => Math.min(totalForumPages, page + 1))} disabled={currentForumPage >= totalForumPages}>
                    下一页
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>
      </section>
    </section>
  );
}

function MemberModal({
  member,
  authModal,
  authForm,
  setAuthForm,
  completeAuth,
  checkout,
  setCheckout,
  submitCheckoutPaid,
  closeAuthModal,
  memberPlans = defaultMemberPlans,
  tokenPackages = defaultTokenPackages,
}) {
  const loggedIn = member.isLoggedIn;
  const paid = member.isPaid;
  const selectedPlan = paid ? null : memberPlans.find((item) => item.id === checkout.planId);
  const selectedToken = tokenPackages.find((item) => item.id === checkout.tokenPackageId);
  const customAmount = Math.max(0, Number(checkout.customTokenAmount || 0));
  const customAmountInvalid = customAmount > 0 && customAmount < 50;
  const tokenPrice = selectedToken?.priceCny || customAmount || 0;
  const totalAmount = Number((Number(selectedPlan?.priceCny || 0) + tokenPrice).toFixed(2));
  const selectedTokenText = selectedToken
    ? `${selectedToken.tokens.toLocaleString("zh-CN")} Token`
    : customAmount > 0
      ? `自定义 ¥${customAmount} / ${Math.round(customAmount * 100).toLocaleString("zh-CN")} Token`
      : "未选择";
  return (
    <div className="member-modal-backdrop" role="dialog" aria-modal="true" aria-label="会员登录与开通">
      <section className="member-modal member-payment-modal">
        <div className="member-modal-head">
          <div>
            <span className="eyebrow">会员系统</span>
            <h2>{paid ? "会员与充值" : loggedIn ? "开通会员后继续使用" : "注册或登录后继续"}</h2>
            <p>{authModal.message}</p>
          </div>
          <button type="button" className="modal-close" onClick={closeAuthModal} aria-label="关闭会员弹窗">
            ×
          </button>
        </div>

        <div className="member-gate-summary">
          <LockKeyhole size={22} />
          <div>
                <strong>{authModal.actionName || "会员功能"}</strong>
                <p>未登录用户可以浏览页面；AI分析、个人档案保存、错题题库、资料下载需要登录并开通会员。</p>
          </div>
        </div>

        {!loggedIn && (
          <div className="auth-form">
            <div className="auth-mode-tabs" role="tablist" aria-label="登录注册方式">
              <button type="button" className={authForm.mode === "register" ? "is-active" : ""} onClick={() => setAuthForm((prev) => ({ ...prev, mode: "register" }))}>
                注册
              </button>
              <button type="button" className={authForm.mode === "login" ? "is-active" : ""} onClick={() => setAuthForm((prev) => ({ ...prev, mode: "login" }))}>
                登录
              </button>
            </div>

            {authForm.mode === "register" && (
              <label>
                <span>学生姓名或昵称</span>
                <input
                  value={authForm.displayName}
                  onChange={(event) => setAuthForm((prev) => ({ ...prev, displayName: event.target.value }))}
                  placeholder="例如：张同学"
                />
              </label>
            )}

            <label>
              <span>用户名</span>
              <input
                value={authForm.username}
                onChange={(event) => setAuthForm((prev) => ({ ...prev, username: event.target.value }))}
                placeholder="请设置一个容易记住的用户名"
              />
            </label>
            <label>
              <span>密码</span>
              <input
                type="password"
                value={authForm.password}
                onChange={(event) => setAuthForm((prev) => ({ ...prev, password: event.target.value }))}
                placeholder="至少6位"
              />
            </label>
            {authForm.mode === "register" && (
              <label>
                <span>确认密码</span>
                <input
                  type="password"
                  value={authForm.confirmPassword}
                  onChange={(event) => setAuthForm((prev) => ({ ...prev, confirmPassword: event.target.value }))}
                  placeholder="再次输入密码"
                />
              </label>
            )}
            <button type="button" className="primary-action full-width" onClick={completeAuth}>
              <LogIn size={17} />
              {authForm.mode === "register" ? "注册并登录" : "登录账号"}
            </button>
          </div>
        )}

        {loggedIn && (
          <div className="member-account-panel">
            <div className={paid ? "account-status is-paid" : "account-status"}>
              {paid ? <ShieldCheck size={22} /> : <Crown size={22} />}
              <div>
                <strong>{paid ? `${member.plan || "正式会员"}已开通` : "账号已登录，尚未开通会员"}</strong>
                <p>{member.provider} · {member.identifier}{paid && member.daysRemaining !== null ? ` · 剩余${Math.max(member.daysRemaining, 0)}天` : ""}</p>
              </div>
            </div>

            <div className="checkout-section">
              <div className="checkout-heading">
                <div>
                  <span className="eyebrow">第一步</span>
                  <h3>选择会员方案和Token额度</h3>
                </div>
                <strong>合计：¥{totalAmount || 0}</strong>
              </div>

              {!paid && (
                <div className="plan-grid selectable-grid">
                  {memberPlans.map((plan) => (
                    <button
                      key={plan.id}
                      type="button"
                      className={checkout.planId === plan.id ? "plan-card selectable-card is-selected" : "plan-card selectable-card"}
                      onClick={() => setCheckout((prev) => ({ ...prev, planId: prev.planId === plan.id ? "" : plan.id, showQr: false, message: "" }))}
                    >
                      <strong>{plan.name}</strong>
                      <b>{plan.price}</b>
                      <p>{plan.description}</p>
                    </button>
                  ))}
                </div>
              )}

              <section className="token-order-panel">
                <div>
                  <span className="eyebrow">Token充值</span>
                  <h3>用于AI分析、错题训练和知识图生成</h3>
                </div>
                <div className="token-package-grid">
                  {tokenPackages.map((pack) => (
                    <button
                      key={pack.id}
                      type="button"
                      className={checkout.tokenPackageId === pack.id ? "token-package-button is-selected" : "token-package-button"}
                      onClick={() =>
                        setCheckout((prev) => ({
                          ...prev,
                          tokenPackageId: prev.tokenPackageId === pack.id ? "" : pack.id,
                          customTokenAmount: "",
                          showQr: false,
                          message: "",
                        }))
                      }
                    >
                      <strong>{pack.label}</strong>
                      <span>{pack.tokens.toLocaleString("zh-CN")} Token</span>
                    </button>
                  ))}
                </div>
                <div className="custom-token-row">
                  <input
                    type="number"
                    min="50"
                    value={checkout.customTokenAmount}
                    onChange={(event) =>
                      setCheckout((prev) => ({ ...prev, customTokenAmount: event.target.value, tokenPackageId: "", showQr: false, message: "" }))
                    }
                    placeholder="自定义充值金额（最低50元）"
                  />
                  <button type="button" className="ghost-action" onClick={() => setCheckout((prev) => ({ ...prev, tokenPackageId: "", showQr: false }))}>
                    自定义金额
                  </button>
                </div>
              </section>

              <div className="checkout-summary">
                <span>会员：{selectedPlan?.name || (paid ? "已开通会员" : "未选择")}</span>
                <span>Token：{selectedTokenText}</span>
                <strong>应付金额：¥{totalAmount || 0}</strong>
                <button
                  type="button"
                  className="primary-action"
                  disabled={totalAmount <= 0 || customAmountInvalid}
                  onClick={() => {
                    if (customAmountInvalid) {
                      setCheckout((prev) => ({ ...prev, message: "自定义充值金额最低为50元。" }));
                      return;
                    }
                    setCheckout((prev) => ({ ...prev, showQr: true, message: "" }));
                  }}
                >
                  <CreditCard size={17} />
                  确认金额并显示收款码
                </button>
              </div>
            </div>

            <div className="membership-rule-panel">
              <article>
                <span>存储空间</span>
                <strong>免费 {storagePlans.free.storageMb}MB · VIP {storagePlans.vip.storageGb}GB</strong>
                <p>扩容包支持 {storagePlans.expansion.map((item) => item.storageGb).join("GB / ")}GB，用于长期保存试卷、错题、语音、知识图和PDF报告。</p>
              </article>
              <article>
                <span>会员权益</span>
                <strong>学习档案 · AI分析 · 资料下载</strong>
                <p>会员可以保存个人学习档案，使用AI分析、错题训练、知识图生成和学习资料下载等能力。</p>
              </article>
            </div>

            {checkout.showQr && (
            <div className="payment-layout">
              <section className="payment-qr-panel">
                <div>
                  <span className="eyebrow">第二步</span>
                  <h3>扫码付款，付款后等待管理员确认</h3>
                  <p>付款后点击下方按钮，并扫描右侧管理员二维码，告知管理员支付情况；管理员确认后会员及Token额度会更新。</p>
                </div>
                <div className="payment-qr-grid">
                  <article>
                    <img src="/assets/payment/alipay.jpg" alt="支付宝收款码" />
                    <strong>支付宝</strong>
                  </article>
                  <article>
                    <img src="/assets/payment/wechat-pay.jpg" alt="微信支付收款码" />
                    <strong>微信支付</strong>
                  </article>
                </div>
                <button type="button" className="primary-action full-width" onClick={submitCheckoutPaid}>
                  我已付款，提交确认申请
                </button>
                <p className="payment-reminder">提交后会生成待确认记录，管理员确认后才会显示为已入账。</p>
              </section>

              <section className="payment-contact-panel">
                <div>
                  <span className="eyebrow">第三步</span>
                  <h3>联系管理员确认</h3>
                  <p>请扫描二维码加管理员微信，说明支付的情况，后台会修改您的会员信息。</p>
                </div>
                <img src="/assets/payment/admin-wechat.jpg" alt="管理员微信二维码" />
              </section>

              <section className="checkout-confirm-panel">
                <span className="eyebrow">付款信息</span>
                <h3>本次选择</h3>
                <p>会员：{selectedPlan?.name || (paid ? "已开通会员" : "未选择")}</p>
                <p>Token：{selectedTokenText}</p>
                <strong>合计：¥{totalAmount || 0}</strong>
                {checkout.message && <p className="account-notice">{checkout.message}</p>}
              </section>
            </div>
            )}
            {!checkout.showQr && checkout.message && <p className="account-notice">{checkout.message}</p>}
          </div>
        )}
      </section>
    </div>
  );
}

function MemberCenterPage({ member, state, setState, refresh, updateProfile, updatePassword, openPayment }) {
  const data = state.data || {};
  const downloads = data.downloads || [];
  const tokenRecords = data.tokenRecords || [];
  const orders = data.orders || [];
  return (
    <section className="stack">
      <div className="hero-band compact">
        <div>
          <span className="eyebrow">会员中心</span>
          <h2>管理个人资料、下载记录和Token使用记录</h2>
          <p>这里保存学生账号信息、会员状态、资料下载记录和AI功能使用记录，方便后续回看和继续使用。</p>
        </div>
        <button type="button" className="primary-action" onClick={openPayment}>
          <CreditCard size={17} />
          开通 / 充值
        </button>
      </div>

      <div className="member-center-grid">
        <article className="panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">个人信息</span>
              <h2>{member.identifier || "未登录账号"}</h2>
            </div>
            <button type="button" className="ghost-action" onClick={refresh}>
              刷新
            </button>
          </div>
          <div className="member-form-grid">
            <label>
              <span>学生姓名或昵称</span>
              <input value={state.displayName} onChange={(event) => setState((prev) => ({ ...prev, displayName: event.target.value }))} />
            </label>
            <button type="button" className="primary-action" onClick={updateProfile}>
              保存资料
            </button>
            <label>
              <span>原密码</span>
              <input type="password" value={state.oldPassword} onChange={(event) => setState((prev) => ({ ...prev, oldPassword: event.target.value }))} />
            </label>
            <label>
              <span>新密码</span>
              <input type="password" value={state.newPassword} onChange={(event) => setState((prev) => ({ ...prev, newPassword: event.target.value }))} />
            </label>
            <button type="button" className="ghost-action" onClick={updatePassword}>
              修改密码
            </button>
          </div>
          {state.message && <p className="account-notice">{state.message}</p>}
        </article>

        <article className="panel">
          <span className="eyebrow">会员状态</span>
          <div className="member-status-grid">
            <strong>{member.isPaid ? member.plan || "正式会员" : "尚未开通会员"}</strong>
            {member.membershipExpiresAt && (
              <span>{member.isPaid ? `到期时间：${new Date(member.membershipExpiresAt).toLocaleDateString("zh-CN")}（剩余${Math.max(member.daysRemaining || 0, 0)}天）` : `会员已到期：${new Date(member.membershipExpiresAt).toLocaleDateString("zh-CN")}`}</span>
            )}
            <span>Token余额：{member.ltBalance || 0}</span>
            <span>存储空间：{member.storageTotalMb || 50}MB</span>
          </div>
        </article>
      </div>

      <div className="records-grid">
        <RecordList title="PDF与资料下载记录" empty="还没有下载记录。" items={downloads.map((item) => ({
          id: item.id,
          title: item.title,
          meta: item.payload?.filename || "下载记录",
          time: item.created_at,
        }))} />
        <RecordList title="Token使用记录" empty="还没有Token记录。" items={tokenRecords.map((item) => ({
          id: item.id,
          title: item.note || item.type,
          meta: `${item.amount > 0 ? "+" : ""}${item.amount} Token`,
          time: item.created_at,
        }))} />
        <RecordList title="会员与充值申请" empty="还没有申请记录。" items={orders.map((item) => ({
          id: item.id,
          title: item.title,
          meta: `${orderStatusLabel(item.status)} · ${orderTypeLabel(item.order_type)} · ¥${Number(item.amount_cny || 0).toFixed(2)}${item.paid_at ? ` · 确认：${new Date(item.paid_at).toLocaleString("zh-CN")}` : ""}${item.meta?.adminNote ? ` · 备注：${item.meta.adminNote}` : ""}`,
          time: item.created_at,
        }))} />
      </div>
    </section>
  );
}

function RecordList({ title, items, empty }) {
  return (
    <article className="panel record-list-panel">
      <h2>{title}</h2>
      <div className="record-list-scroll">
        {items.length === 0 && <p className="muted-text">{empty}</p>}
        {items.map((item) => (
          <div className="record-row" key={item.id}>
            <strong>{item.title}</strong>
            <span>{item.meta}</span>
            <small>{item.time ? new Date(item.time).toLocaleString("zh-CN") : ""}</small>
          </div>
        ))}
      </div>
    </article>
  );
}

function AdminPanelPage({
  state,
  setState,
  loginAdmin,
  loadUsers,
  loadOrders,
  confirmOrder,
  cancelOrder,
  activateMembership,
  rechargeToken,
  plans,
  tokenPackages,
}) {
  const pendingOrders = (state.orders || []).filter((order) => order.status === "pending");
  const recentOrders = (state.orders || []).filter((order) => order.status !== "pending").slice(0, 10);

  function orderAmountText(order) {
    return `¥${Number(order.amount_cny || 0).toFixed(2)}`;
  }

  function orderDetailText(order) {
    const meta = order.meta || {};
    if (order.order_type === "lt_recharge") {
      return `${Number(meta.learningTokens || 0).toLocaleString("zh-CN")} Token`;
    }
    if (order.order_type === "membership") {
      return `${meta.durationDays || ""}天会员`;
    }
    return orderTypeLabel(order.order_type);
  }

  return (
    <section className="stack">
      <div className="hero-band compact admin-hero">
        <div>
          <span className="eyebrow">管理员平台</span>
          <h2>管理员专用入口</h2>
          <p>这里只允许管理员登录。普通会员不能使用此页面。</p>
        </div>
      </div>
      {!state.isLoggedIn && (
        <article className="panel admin-login-panel">
          <label>
            <span>管理员账号</span>
            <input value={state.username} onChange={(event) => setState((prev) => ({ ...prev, username: event.target.value }))} />
          </label>
          <label>
            <span>管理员密码</span>
            <input type="password" value={state.password} onChange={(event) => setState((prev) => ({ ...prev, password: event.target.value }))} />
          </label>
          <button type="button" className="primary-action" onClick={loginAdmin}>登录管理员中心</button>
          {state.message && <p className="account-notice">{state.message}</p>}
        </article>
      )}
      {state.isLoggedIn && (
        <article className="panel admin-order-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">待确认付款申请</span>
              <h2>学生提交后，在这里确认入账</h2>
            </div>
            <button type="button" className="ghost-action" onClick={loadOrders}>刷新申请</button>
          </div>
          <label className="admin-note-field">
            <span>管理员备注</span>
            <input
              value={state.orderNote}
              onChange={(event) => setState((prev) => ({ ...prev, orderNote: event.target.value }))}
              placeholder="可选：例如微信已确认、支付宝已确认"
            />
          </label>
          <div className="admin-order-list">
            {pendingOrders.length === 0 && <p className="muted-text">暂时没有待确认申请。</p>}
            {pendingOrders.map((order) => (
              <article className="admin-order-card" key={order.id}>
                <div>
                  <span className="status-pill pending">{orderStatusLabel(order.status)}</span>
                  <h3>{order.title}</h3>
                  <p>{order.identifier} · {order.student_name || order.display_name || "未填写姓名"}</p>
                </div>
                <div className="admin-order-meta">
                  <strong>{orderAmountText(order)}</strong>
                  <span>{orderTypeLabel(order.order_type)} · {orderDetailText(order)}</span>
                  <small>{order.created_at ? new Date(order.created_at).toLocaleString("zh-CN") : ""}</small>
                </div>
                <div className="admin-order-actions">
                  <button type="button" className="primary-action" onClick={() => confirmOrder(order.id)}>确认入账</button>
                  <button type="button" className="ghost-action" onClick={() => cancelOrder(order.id)}>取消</button>
                </div>
              </article>
            ))}
          </div>
          {recentOrders.length > 0 && (
            <div className="admin-recent-orders">
              <h3>最近已处理</h3>
              {recentOrders.map((order) => (
                <div className="admin-recent-row" key={order.id}>
                  <span className={`status-pill ${order.status}`}>{orderStatusLabel(order.status)}</span>
                  <strong>{order.title}</strong>
                  <span>{order.identifier}</span>
                  <span>{orderAmountText(order)}</span>
                  <small>{order.paid_at ? new Date(order.paid_at).toLocaleString("zh-CN") : new Date(order.updated_at || order.created_at).toLocaleString("zh-CN")}</small>
                </div>
              ))}
            </div>
          )}
        </article>
      )}

      {state.isLoggedIn && (
      <article className="panel admin-control-panel">
        <label>
          <span>学生用户名</span>
          <input value={state.identifier} onChange={(event) => setState((prev) => ({ ...prev, identifier: event.target.value }))} placeholder="输入学生用户名" />
        </label>
        <label>
          <span>会员方案</span>
          <select value={state.planId} onChange={(event) => setState((prev) => ({ ...prev, planId: event.target.value }))}>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>会员开始日期</span>
          <input type="date" value={state.membershipStartDate} onChange={(event) => setState((prev) => ({ ...prev, membershipStartDate: event.target.value }))} />
        </label>
        <label>
          <span>实际收款金额</span>
          <input type="number" value={state.paidAmount} onChange={(event) => setState((prev) => ({ ...prev, paidAmount: event.target.value }))} placeholder="例如：100" />
        </label>
        <label>
          <span>增加Token</span>
          <input type="number" value={state.tokenAmount} onChange={(event) => setState((prev) => ({ ...prev, tokenAmount: event.target.value }))} />
        </label>
        <label>
          <span>常用Token包</span>
          <select
            value=""
            onChange={(event) => {
              const pack = tokenPackages.find((item) => item.id === event.target.value);
              if (pack) {
                setState((prev) => ({
                  ...prev,
                  tokenAmount: String(pack.tokens || pack.learningTokens || 0),
                  paidAmount: String(pack.priceCny || ""),
                }));
              }
            }}
          >
            <option value="">选择后自动填入</option>
            {tokenPackages.map((pack) => (
              <option key={pack.id} value={pack.id}>
                {pack.label || pack.title} · {(pack.tokens || pack.learningTokens || 0).toLocaleString("zh-CN")} Token
              </option>
            ))}
          </select>
        </label>
        <div className="admin-actions">
          <button type="button" className="ghost-action" onClick={loadUsers}>刷新用户</button>
          <button type="button" className="primary-action" onClick={activateMembership}>开通会员</button>
          <button type="button" className="primary-action" onClick={rechargeToken}>增加Token</button>
        </div>
        {state.message && <p className="account-notice">{state.message}</p>}
      </article>
      )}

      {state.isLoggedIn && (
      <article className="panel admin-user-table">
        <h2>用户列表</h2>
        <div className="admin-table-head">
          <span>用户名</span>
          <span>姓名</span>
          <span>会员</span>
          <span>Token</span>
          <span>到期时间</span>
        </div>
        {state.users.map((user) => (
          <button key={user.id} type="button" className="admin-table-row" onClick={() => setState((prev) => ({ ...prev, identifier: user.identifier }))}>
            <span>{user.identifier}</span>
            <span>{user.student_name || user.display_name || "-"}</span>
            <span>{user.membership_status || "free"} · {user.plan_name || "免费用户"}</span>
            <span>{user.balance || 0}</span>
            <span>{user.expires_at ? new Date(user.expires_at).toLocaleDateString("zh-CN") : "-"}</span>
          </button>
        ))}
      </article>
      )}
    </section>
  );
}

function QuestionnairePage({
  answers,
  questionnaireSteps,
  currentStep,
  progress,
  completion,
  lastSaved,
  submitted,
  setCurrentStep,
  updateAnswer,
  toggleMulti,
  saveDraft,
  submitQuestionnaire,
}) {
  const step = questionnaireSteps[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === questionnaireSteps.length - 1;

  return (
    <section className="stack">
      <div className="hero-band compact">
        <div>
          <span className="eyebrow">学情问卷</span>
          <h2>先把学习情况说清楚</h2>
          <p>这份问卷用来了解学生的基础、课堂、作业、错题、复习、学习环境和科目问题。它不是评价学生好坏，而是帮助我们找到真正影响学习的环节。</p>
          <p>建议按步骤填写：先完成核心问题，再展开薄弱科目。保存后的内容会进入个人档案，后面用于生成学情画像、学习策略和学习计划。</p>
        </div>
        <div className="progress-card">
          <strong>{completion}%</strong>
          <span>整体完成度</span>
        </div>
      </div>

      <div className="wizard-layout">
        <aside className="step-list">
          {questionnaireSteps.map((item, index) => (
            <button key={item.id} className={currentStep === index ? "step-item is-active" : "step-item"} onClick={() => setCurrentStep(index)}>
              <span>{index + 1}</span>
              <strong>{item.title}</strong>
            </button>
          ))}
        </aside>

        <section className="panel wizard-panel">
          <div className="wizard-head">
            <div>
              <span className="eyebrow">第 {currentStep + 1} 步 / 共 {questionnaireSteps.length} 步</span>
              <h2>{step.title}</h2>
              <p>{step.description}</p>
            </div>
            <div className="save-state">
              <Save size={16} />
              {lastSaved}
            </div>
          </div>

          {step.sensitive && <div className="soft-note">这些问题只用于帮助你理解状态，不是为了批评你。你可以真实填写。</div>}

          <div className="progress-track" aria-label="问卷进度">
            <i style={{ "--value": `${progress}%` }} />
          </div>

          <div className="question-page-grid questionnaire-single-column">
            <div className="question-stack">
              {step.questions.map((question) => (
                <QuestionField
                  key={question.id}
                  question={question}
                  value={answers[question.id]}
                  updateAnswer={updateAnswer}
                  toggleMulti={toggleMulti}
                />
              ))}
            </div>
          </div>

          <div className="wizard-actions">
            <button className="secondary-action" onClick={() => setCurrentStep(Math.max(0, currentStep - 1))} disabled={isFirst}>
              <ChevronLeft size={18} />
              上一步
            </button>
            <button className="secondary-action" onClick={saveDraft}>
              <Save size={18} />
              保存草稿
            </button>
            {isLast ? (
              <div className="submit-with-hint">
                <button className="primary-action" onClick={submitQuestionnaire}>
                  <Send size={18} />
                  {submitted ? "重新提交问卷" : "提交问卷"}
                </button>
                <span>提交后会自动保存进个人学情档案，供后续画像和学习策略使用。</span>
              </div>
            ) : (
              <button className="primary-action" onClick={() => setCurrentStep(Math.min(questionnaireSteps.length - 1, currentStep + 1))}>
                下一步
                <ChevronRight size={18} />
              </button>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function QuestionField({ question, value, updateAnswer, toggleMulti }) {
  if (question.type === "scoreTable") {
    return <ScoreTable question={question} value={value || {}} updateAnswer={updateAnswer} />;
  }
  if (question.type === "scoreMatrix") {
    return <ScoreMatrix question={question} value={value || {}} updateAnswer={updateAnswer} />;
  }
  if (question.type === "yesNoGrid") {
    return <YesNoGrid question={question} value={value || {}} updateAnswer={updateAnswer} />;
  }

  return (
    <div className="question-field">
      <div className="question-label">
        <strong>{question.label}</strong>
        {question.required && <span>必填</span>}
      </div>

      {question.type === "text" && (
        <input value={value || ""} placeholder={question.placeholder || "请输入"} onChange={(event) => updateAnswer(question, event.target.value)} />
      )}

      {question.type === "textarea" && (
        <textarea value={value || ""} placeholder={question.placeholder || "请用自己的话写下来"} onChange={(event) => updateAnswer(question, event.target.value)} />
      )}

      {question.type === "single" && (
        <div className="option-grid">
          {question.options.map((option) => (
            <button key={option} className={value === option ? "option-chip is-selected" : "option-chip"} onClick={() => updateAnswer(question, option)}>
              {option}
            </button>
          ))}
        </div>
      )}

      {question.type === "multi" && (
        <div className="option-grid">
          {question.options.map((option) => (
            <button
              key={option}
              className={Array.isArray(value) && value.includes(option) ? "option-chip is-selected" : "option-chip"}
              onClick={() => toggleMulti(question, option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}

      {question.type === "scale" && (
        <div className="scale-field">
          <input type="range" min="1" max="10" value={value || 5} onChange={(event) => updateAnswer(question, Number(event.target.value))} />
          <div>
            <span>{question.minLabel}</span>
            <strong>{value || 5} 分</strong>
            <span>{question.maxLabel}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ScoreTable({ question, value, updateAnswer }) {
  function setSubject(subject, field, nextValue) {
    updateAnswer(question, { ...value, [subject]: { ...(value[subject] || {}), [field]: nextValue } });
  }
  return (
    <div className="question-field">
      <div className="question-label">
        <strong>{question.label}</strong>
      </div>
      <div className="score-table">
        <div className="score-table-head">
          <span>科目</span>
          <span>实际分数</span>
          <span>试卷总分</span>
        </div>
        {question.subjects.map((subject) => (
          <div className="score-table-row" key={subject}>
            <strong>{subject}</strong>
            <input value={value[subject]?.score || ""} placeholder="如 130" onChange={(event) => setSubject(subject, "score", event.target.value)} />
            <input value={value[subject]?.total || ""} placeholder="如 150" onChange={(event) => setSubject(subject, "total", event.target.value)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ScoreMatrix({ question, value, updateAnswer }) {
  function setRow(row, score) {
    updateAnswer(question, { ...value, [row]: Number(score) });
  }
  return (
    <div className="question-field">
      <div className="question-label">
        <strong>{question.label}</strong>
      </div>
      <div className="matrix-list">
        {question.rows.map((row) => (
          <div className="matrix-row" key={row}>
            <span>{row}</span>
            <input type="range" min="0" max="10" value={value[row] ?? 0} onChange={(event) => setRow(row, event.target.value)} />
            <b>{value[row] ?? 0}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function YesNoGrid({ question, value, updateAnswer }) {
  function setRow(row, answer) {
    updateAnswer(question, { ...value, [row]: answer });
  }
  return (
    <div className="question-field">
      <div className="question-label">
        <strong>{question.label}</strong>
      </div>
      <div className="yesno-list">
        {question.rows.map((row) => (
          <div className="yesno-row" key={row}>
            <span>{row}</span>
            <div>
              {["是", "否"].map((answer) => (
                <button key={answer} className={value[row] === answer ? "mini-choice is-selected" : "mini-choice"} onClick={() => setRow(row, answer)}>
                  {answer}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModernStatementPage({
  statementText,
  setStatementText,
  saveStatement,
  statementSubject,
  setStatementSubject,
  statementScene,
  setStatementScene,
  statementIntensity,
  setStatementIntensity,
  guidedAnswers,
  setGuidedAnswers,
  recordingState,
  startRecording,
  stopRecording,
  uploadAudio,
  audioUrl,
  records,
}) {
  const [activeStatementTab, setActiveStatementTab] = useState("entry");

  function updateGuide(question, value) {
    setGuidedAnswers((prev) => ({ ...prev, [question]: value }));
  }

  function appendCombination() {
    const existing = statementText.trim();
    const nextIndex = existing ? existing.split(/\n(?=\d+\.)/).length + 1 : 1;
    const selectedSubject = statementSubject || "未选主题";
    const selectedScene = statementScene || "未选场景";
    const line = `${nextIndex}. ${selectedSubject}+${selectedScene}：`;
    setStatementText(existing ? `${existing}\n${line}` : line);
  }

  return (
    <section className="stack">
      <div className="hero-band compact statement-hero">
        <div>
          <span className="eyebrow">学情陈述</span>
          <h2>先让学生把问题说完整，再进入个人学习档案</h2>
          <p>学生可以选择科目和发生场景，形成“组合序号 + 文字陈述”的记录；也可以使用麦克风或上传语音，后续交给AI结合问卷做整体分析。</p>
        </div>
        <MessageStat records={records.length} />
      </div>

      <div className="statement-subtabs" role="tablist" aria-label="学情陈述分区">
        {[
          ["entry", "主动陈述"],
          ["archive", "陈述档案"],
        ].map(([id, label]) => (
          <button key={id} type="button" className={activeStatementTab === id ? "is-active" : ""} onClick={() => setActiveStatementTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {activeStatementTab === "entry" && (
        <>
          <div className="statement-layout statement-focus-layout">
            <section className="panel statement-input-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">主动陈述</span>
                  <h2>选择问题组合，生成编号后填写</h2>
                </div>
                <FileText size={24} />
              </div>

              <div className="statement-meta-grid">
                <div>
                  <strong>相关主题</strong>
                  <div className="compact-options">
                    {statementSubjects.map((item) => (
                      <button key={item} className={statementSubject === item ? "mini-choice is-selected" : "mini-choice"} onClick={() => setStatementSubject((current) => (current === item ? "" : item))}>
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <strong>发生场景</strong>
                  <div className="compact-options">
                    {statementScenes.map((item) => (
                      <button key={item} className={statementScene === item ? "mini-choice is-selected" : "mini-choice"} onClick={() => setStatementScene((current) => (current === item ? "" : item))}>
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <button type="button" className="ghost-action combination-add" onClick={appendCombination}>
                <Plus size={17} />
                添加为一个问题组合
              </button>

              <div className="impact-slider">
                <div>
                  <strong>影响程度</strong>
                  <span>{statementIntensity}/10</span>
                </div>
                <input type="range" min="1" max="10" value={statementIntensity} onChange={(event) => setStatementIntensity(Number(event.target.value))} />
              </div>

              <label className="statement-long-box">
                <span>学生问题陈述</span>
                <textarea
                  value={statementText}
                  onChange={(event) => setStatementText(event.target.value)}
                  placeholder="例如：1. 数学+作业：我上课能听懂，但是独立做综合题会卡住……"
                />
              </label>

              <div className="action-row">
                <button className="primary-action" onClick={saveStatement}>
                  <Save size={18} />
                  保存
                </button>
              </div>
            </section>

            <section className="panel voice-side-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">语音陈述</span>
                  <h2>录音或上传，先保存到个人档案</h2>
                </div>
                <FileAudio size={24} />
              </div>
              <div className="voice-panel-body">
                <article className="voice-record-card">
                  <div className="voice-card-icon">
                    <Mic size={22} />
                  </div>
                  <div>
                    <strong>麦克风录音</strong>
                    <p>适合学生直接说出学习困扰，录音会进入陈述档案。</p>
                  </div>
                  {recordingState === "recording" ? (
                    <button className="danger-action voice-button" onClick={stopRecording}>
                      <PauseCircle size={20} />
                      结束录音
                    </button>
                  ) : (
                    <button className="primary-action voice-button" onClick={startRecording}>
                      <Mic size={20} />
                      开始录音
                    </button>
                  )}
                </article>
                <label className="voice-upload-card">
                  <div className="voice-card-icon">
                    <UploadCloud size={22} />
                  </div>
                  <div>
                    <strong>上传已有语音</strong>
                    <p>支持学生上传提前录好的音频，后续会整理进个人学情档案。</p>
                  </div>
                  <span>选择音频文件</span>
                  <input type="file" accept="audio/*" onChange={uploadAudio} />
                </label>
                {recordingState === "blocked" && (
                  <p className="warning-text">
                    <AlertCircle size={16} />
                    浏览器没有获得麦克风权限，请允许后重试。
                  </p>
                )}
                {audioUrl && (
                  <audio controls src={audioUrl}>
                    <track kind="captions" />
                  </audio>
                )}
              </div>
            </section>
          </div>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">引导式追问</span>
                <h2>如果同学不知道如何反思自己的学习问题，可以按照以下思路进行。</h2>
              </div>
              <ClipboardList size={24} />
            </div>
            <div className="guide-accordion">
              {statementGuideQuestions.map((question, index) => (
                <details key={question} className="guide-item" open={index === 0}>
                  <summary>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{question}</strong>
                    <em>{guidedAnswers[question] ? "已填写" : "可选"}</em>
                  </summary>
                  <textarea value={guidedAnswers[question] || ""} onChange={(event) => updateGuide(question, event.target.value)} placeholder="可以简单写，也可以先留空。" />
                </details>
              ))}
            </div>
          </section>
        </>
      )}

      {activeStatementTab === "archive" && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">个人档案记录</span>
              <h2>学生陈述历史</h2>
            </div>
            <BookOpen size={24} />
          </div>
          <div className="record-list record-list-wide">
            {records.map((record) => (
              <article key={record.id}>
                <div className="record-topline">
                  <span>{record.type} · {record.time}</span>
                  {record.intensity && <b>{record.intensity}/10</b>}
                </div>
                <h3>{record.title}</h3>
                {record.tags && (
                  <div className="record-tags">
                    {record.tags.map((tag) => (
                      <em key={tag}>{tag}</em>
                    ))}
                  </div>
                )}
                <p>{record.content}</p>
                {record.audioUrl && (
                  <audio controls src={record.audioUrl}>
                    <track kind="captions" />
                  </audio>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

function MessageStat({ records }) {
  return (
    <div className="progress-card">
      <strong>{records}</strong>
      <span>档案记录</span>
    </div>
  );
}

function ModernProfilePage({ answers, records, aiInsight, aiStatus, submitted, completion, printPage, generateProfileAnalysis }) {
  const studentName = answers.name || "这位同学";
  const [selfAssessment, setSelfAssessment] = useState({});
  const [selfPortrait, setSelfPortrait] = useState("");

  function updateSelfAssessment(title, field, value) {
    setSelfAssessment((prev) => ({
      ...prev,
      [title]: {
        ...(prev[title] || { score: 5, note: "" }),
        [field]: value,
      },
    }));
  }

  return (
    <section className="stack">
      <div className="hero-band compact">
        <div>
          <span className="eyebrow">学情画像</span>
          <h2>先给出整体学习分析，再展开每个画像项目</h2>
          <p>报告同时面向学生和家长：先看整体判断，再查看成绩、方法、习惯、动机、情绪精力等细分维度。</p>
        </div>
        <div className="progress-card">
          <strong>{submitted ? "已提交" : `${completion}%`}</strong>
          <span>问卷状态</span>
        </div>
      </div>

      <section className="panel report-panel">
        <div className="report-title profile-simple-title">
          <div>
            <span className="eyebrow">学生与家长共读版</span>
            <h2>{studentName}的学情画像报告</h2>
          </div>
          <button className="ghost-action" onClick={() => printPage("下载学情画像报告PDF", "学情画像报告可以打印或另存为PDF，需要登录并开通会员后使用。")}>
            <Download size={18} />
            下载报告PDF
          </button>
        </div>

        <section className="profile-unified-analysis">
          <div className="profile-unified-head">
            <div>
              <span className="eyebrow">AI统一分析画像</span>
              <h2>整合问卷、陈述和错题专项，形成完整学习判断</h2>
            </div>
            <button className="primary-action" onClick={generateProfileAnalysis} disabled={aiStatus === "loading"}>
              {aiStatus === "loading" ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
              {aiStatus === "loading" ? "AI正在分析" : "AI统一分析画像"}
            </button>
          </div>
          <div className="profile-unified-body">
            <h3>{aiInsight?.core || "点击“AI统一分析画像”后，这里会显示学生学习问题的整体判断。"}</h3>
            <p>{aiInsight?.archiveConclusion || "AI会统一阅读前面的学情问卷、学情陈述和错题专项，综合判断学生的基础、方法、执行、习惯、动机和情绪精力等情况。"}</p>
            {aiInsight?.summary && <p>{aiInsight.summary}</p>}
            {aiInsight?.reasons?.length > 0 && (
              <ul className="profile-unified-list">
                {aiInsight.reasons.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            <p className="profile-source-note">当前档案来源：学情陈述 {records.length} 条，问卷完成度 {completion}%，错题专项会随着上传和训练持续补充。</p>
          </div>
        </section>

        <div className="profile-accordion">
          {profileSections.map((section) => (
            <details className="profile-detail" key={section.title} id={`profile-${section.index}`}>
              <summary>
                <div className="profile-summary-main">
                  <span>{section.index}</span>
                  <div>
                    <strong>{section.title}</strong>
                    <p>{section.finding}</p>
                  </div>
                </div>
                <div className="profile-score">
                  <b>{section.score.toFixed(1)} / 10</b>
                  <i style={{ "--value": `${section.score * 10}%` }} />
                </div>
              </summary>
              <div className="profile-detail-body">
                <div>
                  <h3>测评问题</h3>
                  <p>{section.question}</p>
                </div>
                <div>
                  <h3>{section.title}的解释</h3>
                  <p>{section.explanation}</p>
                </div>
                <div>
                  <h3>判断依据</h3>
                  <p>{section.evidence}</p>
                </div>
                <div>
                  <h3>支持建议</h3>
                  <p>{section.suggestion}</p>
                </div>
                <div className="student-self-eval">
                  <h3>学生自我评估</h3>
                  <label>
                    <span>我给自己这一项打分</span>
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={selfAssessment[section.title]?.score || 5}
                      onChange={(event) => updateSelfAssessment(section.title, "score", Number(event.target.value))}
                    />
                    <b>{selfAssessment[section.title]?.score || 5} / 10</b>
                  </label>
                  <textarea
                    value={selfAssessment[section.title]?.note || ""}
                    onChange={(event) => updateSelfAssessment(section.title, "note", event.target.value)}
                    placeholder="学生可以写：我觉得这一项准不准？我自己的真实感受是什么？"
                  />
                </div>
              </div>
            </details>
          ))}
        </div>

        <section className="student-portrait-box">
          <div>
            <span className="eyebrow">学生自我画像</span>
            <h3>我眼中的自己</h3>
            <p>学生可以写下自己对学习状态、优势、困难和希望改变之处的理解。</p>
          </div>
          <textarea value={selfPortrait} onChange={(event) => setSelfPortrait(event.target.value)} placeholder="例如：我觉得自己不是不想学，而是不知道怎么开始；我希望先把数学错题和晚上计划执行做好。" />
        </section>
      </section>
    </section>
  );
}

function StrategyDesignPage({
  activeSubject,
  setActiveSubject,
  workspaces,
  answers,
  aiInsight,
  strategyAiStatus,
  updateStrategyText,
  updateStrategyTask,
  updateMaterialUsage,
  updateCustomMaterial,
  addCustomMaterial,
  addStrategyTask,
  acceptStrategySuggestion,
  rejectStrategySuggestion,
  runStrategyAi,
}) {
  const workspace = workspaces[activeSubject];
  const subjectData = subjectStrategyData[activeSubject];
  const studentName = answers.name || "这位同学";

  return (
    <section className="stack strategy-page">
      <div className="hero-band compact strategy-hero">
        <div>
          <span className="eyebrow">策略与任务</span>
          <h2>先确定这个科目应该怎么学，再拆成资料使用和具体任务</h2>
          <p>
            这一页以学情画像为基础，由AI给出科目策略和学习任务建议。学生可以自己写资料使用细节，也可以让AI帮忙修改，最后形成可执行的科目学习方案。
          </p>
        </div>
        <div className="strategy-status">
          <strong>{activeSubject}</strong>
          <span>{strategyAiStatus || "等待AI建议"}</span>
        </div>
      </div>

      <section className="panel subject-switch-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">科目选择</span>
            <h2>选择一个科目，进入单独的策略设计页面</h2>
          </div>
          <BookOpen size={24} />
        </div>
        <div className="subject-tabs" role="tablist" aria-label="科目选择">
          {strategySubjects.map((subject) => (
            <button
              key={subject}
              type="button"
              className={activeSubject === subject ? "subject-tab is-active" : "subject-tab"}
              onClick={() => setActiveSubject(subject)}
            >
              {subject}
            </button>
          ))}
        </div>
      </section>

      <section className="strategy-grid">
        <article className="panel strategy-editor-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">1. 科目学习策略</span>
              <h2>{activeSubject}应该怎么学习？</h2>
            </div>
            <Sparkles size={24} />
          </div>

          <div className="strategy-explain">
            <strong>策略判断</strong>
            <p>{subjectData.diagnosis}</p>
          </div>

          <div className="strategy-advice-box">
            <div className="strategy-advice-head">
              <div>
                <span className="eyebrow">AI策略建议</span>
                <strong>{workspace.acceptedStrategy ? "已接受当前AI建议" : "等待确认的AI建议"}</strong>
              </div>
              <button type="button" className="primary-action" onClick={() => runStrategyAi("strategy", "generate")}>
                <Sparkles size={17} />
                生成AI策略建议
              </button>
            </div>
            <p>{workspace.strategySuggestion}</p>
            <div className="ai-action-row">
              <button type="button" className="ghost-action" onClick={acceptStrategySuggestion}>
                <CheckCircle2 size={17} />
                接受建议
              </button>
              <button type="button" className="ghost-action" onClick={rejectStrategySuggestion}>
                不接受建议
              </button>
              <button type="button" className="ghost-action" onClick={() => runStrategyAi("strategy", "generate")}>
                <WandSparkles size={17} />
                重新生成
              </button>
            </div>
          </div>

          <label className="strategy-student-box">
            <span>我认为的科目学习策略</span>
            <textarea
              className="strategy-textarea"
              value={workspace.studentStrategy}
              onChange={(event) => updateStrategyText(event.target.value, "studentStrategy")}
              placeholder="学生可以写：我觉得这个科目应该先补什么、每天怎么做、哪些方法适合我。"
              aria-label={`${activeSubject}学生自己的学习策略`}
            />
          </label>
        </article>

        <aside className="panel material-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">推荐资料</span>
              <h2>本学科常用资料</h2>
            </div>
            <FileText size={24} />
          </div>
          <h3 className="material-subtitle">AI推荐资料</h3>
          <div className="material-list">
            {workspace.materials.map((material) => (
              <article className="material-card" key={material.id}>
                <strong>{material.name}</strong>
                <p>{material.description}</p>
                <label>
                  <span>这本资料的作用</span>
                  <textarea
                    value={material.aiUseNote || material.description}
                    onChange={(event) => updateMaterialUsage(material.id, "aiUseNote", event.target.value)}
                  />
                </label>
                <label>
                  <span>学生资料使用细节</span>
                  <textarea
                    placeholder="例如：我准备用这本资料做哪一章、什么时间做、每次做多少、做完怎样检查。"
                    value={material.usage}
                    onChange={(event) => updateMaterialUsage(material.id, "usage", event.target.value)}
                  />
                </label>
              </article>
            ))}
          </div>
          <div className="custom-material-section">
            <div className="custom-material-head">
              <h3 className="material-subtitle">我认为需要的学习资料</h3>
              <button type="button" className="ghost-action" onClick={addCustomMaterial}>
                <Plus size={16} />
                添加资料
              </button>
            </div>
            <div className="material-list">
              {workspace.customMaterials.map((material, index) => (
                <article className="material-card" key={material.id}>
                  <label>
                    <span>资料名称 {index + 1}</span>
                    <input
                      value={material.name}
                      onChange={(event) => updateCustomMaterial(material.id, "name", event.target.value)}
                      placeholder="例如：我的错题本、老师发的专题卷、课外阅读材料"
                    />
                  </label>
                  <label>
                    <span>资料作用</span>
                    <textarea
                      value={material.purpose}
                      onChange={(event) => updateCustomMaterial(material.id, "purpose", event.target.value)}
                      placeholder="写清楚这份资料主要帮你解决什么问题。"
                    />
                  </label>
                  <label>
                    <span>使用细节</span>
                    <textarea
                      value={material.usage}
                      onChange={(event) => updateCustomMaterial(material.id, "usage", event.target.value)}
                      placeholder="写清楚什么时候用、每次用多少、完成后怎么检查。"
                    />
                  </label>
                </article>
              ))}
            </div>
          </div>
          <div className="strategy-explain">
            <strong>设计原则</strong>
            <p>任务必须写清楚时间、资料、步骤和完成标准。学生可以用自己的话补充，AI再帮助优化成更可执行的表达。</p>
          </div>
        </aside>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">2. 学习任务设计</span>
            <h2>把策略拆成学生能执行的任务</h2>
          </div>
          <div className="ai-action-row">
            <button type="button" className="ghost-action" onClick={() => runStrategyAi("task", "suggest")}>
              <Sparkles size={17} />
              AI学习任务建议
            </button>
            <button type="button" className="primary-action" onClick={addStrategyTask}>
              <ClipboardList size={17} />
              添加任务
            </button>
          </div>
        </div>

        <div className="task-card-grid">
          {workspace.tasks.map((task, index) => (
            <article className="task-card" key={task.id}>
              <div className="task-card-head">
                <span>任务 {index + 1}</span>
                <input value={task.title} onChange={(event) => updateStrategyTask(task.id, "title", event.target.value)} aria-label="任务标题" />
              </div>

              <label>
                <span>对应问题</span>
                <textarea value={task.problem} onChange={(event) => updateStrategyTask(task.id, "problem", event.target.value)} />
              </label>
              <label>
                <span>什么时间做</span>
                <input value={task.time} onChange={(event) => updateStrategyTask(task.id, "time", event.target.value)} />
              </label>
              <label>
                <span>使用资料</span>
                <input value={task.material} onChange={(event) => updateStrategyTask(task.id, "material", event.target.value)} />
              </label>
              <label>
                <span>任务细节描述</span>
                <textarea value={task.detail} onChange={(event) => updateStrategyTask(task.id, "detail", event.target.value)} />
              </label>
              <label>
                <span>完成标准</span>
                <textarea value={task.standard} onChange={(event) => updateStrategyTask(task.id, "standard", event.target.value)} />
              </label>
              <label>
                <span>学生自己的表达</span>
                <textarea
                  placeholder="学生可以写：我觉得自己最需要先做什么、什么时候更容易完成、希望老师怎样提醒。"
                  value={task.studentNote}
                  onChange={(event) => updateStrategyTask(task.id, "studentNote", event.target.value)}
                />
              </label>

              <div className="ai-action-row compact-actions">
                <button type="button" className="ghost-action" onClick={() => runStrategyAi("task", "revise", task.id)}>
                  <Save size={16} />
                  AI帮我修改
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

    </section>
  );
}

function StudyPlanPage({
  planRows,
  updatePlanCell,
  addPlanRow,
  runPlanAi,
  planAiStatus,
  removePlanRow,
  planNote,
  setPlanNote,
  methodFocusRows,
  habitFocusRows,
  updateFocusRow,
  updateFocusScore,
  printPage,
  downloadProtectedFile,
}) {
  const [activeStudySection, setActiveStudySection] = useState("plan");
  return (
    <section className="stack study-plan-page">
      <div className="hero-band compact plan-hero">
        <div>
          <span className="eyebrow">学习计划</span>
          <h2>把每一天的时间、任务和备注直接写进周计划表</h2>
          <p>
            计划表参考学习计划本的结构：横排是星期，每个格子里竖着填写时间、任务和备注。时间用选择器，减少手写混乱，也方便后面让AI读取并优化计划。
          </p>
        </div>
        <div className="strategy-status">
          <strong>{planRows.length}</strong>
          <span>计划时间行</span>
        </div>
      </div>

      <div className="study-section-tabs" role="tablist" aria-label="学习计划页面分区">
        <button type="button" className={activeStudySection === "plan" ? "is-active" : ""} onClick={() => setActiveStudySection("plan")}>
          学习计划
        </button>
        <button type="button" className={activeStudySection === "reflection" ? "is-active" : ""} onClick={() => setActiveStudySection("reflection")}>
          学习反思与讨论
        </button>
      </div>

      {activeStudySection === "plan" && (
        <div className="print-plan-package">
          <section className="panel plan-print-page">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">1. 学习计划表</span>
                <h2>每个星期下面都有时间、任务、备注</h2>
              </div>
              <div className="ai-action-row no-print">
                <button type="button" className="ghost-action" onClick={() => printPage("下载学习计划PDF", "学习计划表和方法习惯训练表可以打印或另存为PDF，需要登录并开通会员后使用。")}>
                  <FileDown size={17} />
                  下载学习计划PDF
                </button>
                <button type="button" className="primary-action plan-ai-action" onClick={runPlanAi} disabled={planAiStatus === "loading"}>
                  {planAiStatus === "loading" ? <Loader2 className="spin" size={17} /> : <WandSparkles size={17} />}
                  {planAiStatus === "loading" ? "AI正在制定" : "AI辅助制定学习计划"}
                </button>
                <button type="button" className="primary-action" onClick={addPlanRow}>
                  <Plus size={17} />
                  添加时间行
                </button>
              </div>
            </div>

            <label className="plan-note">
              <span>本周计划说明</span>
              <textarea value={planNote} onChange={(event) => setPlanNote(event.target.value)} />
            </label>

            <div className="weekly-plan-scroll">
              <table className="weekly-plan-table">
                <thead>
                  <tr>
                    {weekDays.map((day) => (
                      <th key={day}>{day}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {planRows.map((row) => (
                    <tr key={row.id}>
                      {weekDays.map((day) => (
                        <td key={day}>
                          <PlanCellTimeRange
                            start={row.cells[day].start}
                            end={row.cells[day].end}
                            onStartChange={(value) => updatePlanCell(row.id, day, "start", value)}
                            onEndChange={(value) => updatePlanCell(row.id, day, "end", value)}
                          />
                          <textarea
                            className="no-print"
                            placeholder="任务"
                            value={row.cells[day].task}
                            onChange={(event) => updatePlanCell(row.id, day, "task", event.target.value)}
                          />
                          <span className="print-value plan-print-task">{row.cells[day].task || "任务"}</span>
                          <input className="no-print" placeholder="备注" value={row.cells[day].note} onChange={(event) => updatePlanCell(row.id, day, "note", event.target.value)} />
                          <span className="print-value plan-print-note">{row.cells[day].note || "备注"}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {planRows.length > 1 && (
              <div className="plan-row-actions no-print">
                <button type="button" className="ghost-action" onClick={() => removePlanRow(planRows[planRows.length - 1].id)}>
                  <Trash2 size={17} />
                  删除最后一行
                </button>
              </div>
            )}
          </section>

          <section className="panel plan-print-page">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">2. 本周重点训练</span>
                <h2>选择1-3个学习方法和习惯培养目标</h2>
              </div>
              <WandSparkles size={24} />
            </div>
            <FocusTrainingTable
              title="本周重点训练的学习方法"
              kind="method"
              rows={methodFocusRows}
              options={methodTrainingOptions}
              updateFocusRow={updateFocusRow}
              updateFocusScore={updateFocusScore}
            />
            <FocusTrainingTable
              title="本周重点培养的学习习惯"
              kind="habit"
              rows={habitFocusRows}
              options={habitTrainingOptions}
              updateFocusRow={updateFocusRow}
              updateFocusScore={updateFocusScore}
            />
          </section>
        </div>
      )}

      {activeStudySection === "reflection" && <ReflectionDiscussionSection downloadProtectedFile={downloadProtectedFile} />}
    </section>
  );
}

function isCustomFocusItem(item) {
  return item === "自定义训练" || item === "自定义习惯";
}

function FocusTrainingTable({ title, kind, rows, options, updateFocusRow, updateFocusScore }) {
  const printableIndexById = new Map();
  rows.filter((row) => row.enabled).forEach((row, index) => printableIndexById.set(row.id, index + 1));

  return (
    <div className="focus-training-block">
      <h3>{title}</h3>
      <div className="focus-training-table-wrap">
        <table className="focus-training-table">
          <thead>
            <tr>
              <th>
                <span className="no-print">启用</span>
                <span className="print-only">序号</span>
              </th>
              <th>训练项目</th>
              <th>自定义说明</th>
              {["星期一", "星期二", "星期三", "星期四", "星期五"].map((day) => (
                <th key={day}>{day}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id} className={!row.enabled ? "focus-row-disabled" : ""}>
                <td>
                  <input className="no-print" type="checkbox" checked={row.enabled} onChange={(event) => updateFocusRow(kind, row.id, "enabled", event.target.checked)} />
                  <span className="print-row-number print-only">{printableIndexById.get(row.id) || ""}</span>
                </td>
                <td>
                  <select className="no-print" value={row.item} onChange={(event) => updateFocusRow(kind, row.id, "item", event.target.value)}>
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  {isCustomFocusItem(row.item) && (
                    <input
                      className="focus-custom-title no-print"
                      value={row.customTitle || ""}
                      onChange={(event) => updateFocusRow(kind, row.id, "customTitle", event.target.value)}
                      placeholder="写下自定义训练标题"
                    />
                  )}
                  <span className="print-value focus-print-item">{isCustomFocusItem(row.item) && row.customTitle ? row.customTitle : row.item}</span>
                </td>
                <td>
                  <textarea
                    className="no-print"
                    placeholder={index === 0 ? "写清楚这个方法或习惯具体怎么做。" : "可选：继续添加第2/3项。"}
                    value={row.custom}
                    onChange={(event) => updateFocusRow(kind, row.id, "custom", event.target.value)}
                  />
                  <span className="print-value focus-print-note">{row.custom || " "}</span>
                </td>
                {["星期一", "星期二", "星期三", "星期四", "星期五"].map((day) => (
                  <td key={day}>
                    <select className="no-print" value={row.scores[day]} onChange={(event) => updateFocusScore(kind, row.id, day, event.target.value)} disabled={!row.enabled}>
                      {scoreOptions.map((score) => (
                        <option key={score || "empty"} value={score}>
                          {score || "-"}
                        </option>
                      ))}
                    </select>
                    <span className="print-value focus-print-score">{row.scores[day] || "-"}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReflectionDiscussionSection({ downloadProtectedFile }) {
  return (
    <div className="reflection-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">每日反思表</span>
            <h2>每天用十分制记录学习执行、课堂效果和时间安排</h2>
          </div>
          <FileText size={24} />
        </div>
        <div className="reflection-table-wrap">
          <table className="reflection-table">
            <thead>
              <tr>
                <th>反思项目</th>
                {["星期一", "星期二", "星期三", "星期四", "星期五"].map((day) => (
                  <th key={day}>{day}</th>
                ))}
                <th>记录与解决办法</th>
              </tr>
            </thead>
            <tbody>
              {dailyReflectionRows.map((row) => (
                <tr key={row}>
                  <td>{row}</td>
                  {["星期一", "星期二", "星期三", "星期四", "星期五"].map((day) => (
                    <td key={day}>
                      <select aria-label={`${row}${day}评分`}>
                        {scoreOptions.map((score) => (
                          <option value={score} key={score || "empty"}>
                            {score || "-"}
                          </option>
                        ))}
                      </select>
                    </td>
                  ))}
                  <td>
                    <textarea placeholder="写下今天的问题、改善点、解决办法或值得保留的经验。" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">每周讨论表</span>
            <h2>整理本周问题、状态评分和学习计划优化方向</h2>
          </div>
          <BookOpen size={24} />
        </div>
        <article className="discussion-card weekly-state-card">
          <h3>状态评分</h3>
          {weeklyStateRows.map((row) => (
            <label className="score-line" key={row}>
              <span>{row}</span>
              <select>
                {scoreOptions.map((score) => (
                  <option value={score} key={score || "empty"}>
                    {score || "-"}
                  </option>
                ))}
              </select>
              <input placeholder="备注" />
            </label>
          ))}
        </article>
        <div className="reflection-table-wrap">
          <table className="reflection-table weekly-discussion-table">
            <thead>
              <tr>
                <th>讨论步骤</th>
                <th>记录内容</th>
              </tr>
            </thead>
            <tbody>
              {weeklyDiscussionRows.map((row, index) => (
                <tr key={row}>
                  <td>第{index + 1}步：{row}</td>
                  <td>
                    <textarea placeholder="根据本周实际情况填写。" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <article className="discussion-card problem-discussion-card">
          <h3>问题讨论</h3>
          {weeklyProblemRows.map((row) => (
            <label key={row}>
              <span>{row}</span>
              <textarea placeholder="可以写课堂知识、学习行为、同学老师家庭关系、环境等问题。" />
            </label>
          ))}
        </article>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">下载打印</span>
            <h2>每日反思表和每周讨论表 Word 版本</h2>
          </div>
          <Download size={24} />
        </div>
        <div className="download-card-grid">
          <button type="button" className="download-card" onClick={() => downloadProtectedFile("/downloads/daily-reflection.docx", "每日反思表.docx", "下载每日反思表")}>
            <FileDown size={24} />
            <strong>每日反思表</strong>
            <p>可下载打印后每日手写记录。</p>
          </button>
          <button type="button" className="download-card" onClick={() => downloadProtectedFile("/downloads/weekly-discussion.docx", "每周讨论表.docx", "下载每周讨论表")}>
            <FileDown size={24} />
            <strong>每周讨论表</strong>
            <p>可下载打印后用于每周复盘讨论。</p>
          </button>
        </div>
      </section>
    </div>
  );
}

function MistakeSpecialPage({
  mistakes,
  mistakeDraft,
  mistakeWorkspaceTab,
  setMistakeWorkspaceTab,
  mistakePrompt,
  setMistakePrompt,
  mistakeTaskType,
  applyMistakeQuickTask,
  mistakeResult,
  selectedArchiveMistakeIds,
  mistakeArchiveSubject,
  setMistakeArchiveSubject,
  updateMistakeDraft,
  handleMistakeFile,
  removeMistakeUpload,
  runMistakeWorkspaceAi,
  selectedMistakeId,
  setSelectedMistakeId,
  mistakeAiStatus,
  toggleArchiveMistake,
  selectAllArchiveMistakes,
  downloadMistakeWordDoc,
  downloadSelectedMistakesPdf,
}) {
  const selected = mistakes.find((item) => item.id === selectedMistakeId) || mistakes[0];
  const uniqueMistakes = [];
  const seenMistakes = new Set();
  mistakes.forEach((mistake) => {
    const key = `${mistake.subject}|${mistake.title}|${mistake.fileName}`;
    if (!seenMistakes.has(key)) {
      seenMistakes.add(key);
      uniqueMistakes.push(mistake);
    }
  });
  const visibleMistakes =
    mistakeArchiveSubject === "全部" ? uniqueMistakes : uniqueMistakes.filter((item) => item.subject === mistakeArchiveSubject);
  const selectedArchiveItems = visibleMistakes.filter((item) => selectedArchiveMistakeIds.includes(item.id));

  return (
    <section className="stack mistake-workspace">
      <div className="mistake-tabs">
        <button type="button" className={mistakeWorkspaceTab === "ai" ? "is-active" : ""} onClick={() => setMistakeWorkspaceTab("ai")}>
          AI错题处理
        </button>
        <button type="button" className={mistakeWorkspaceTab === "archive" ? "is-active" : ""} onClick={() => setMistakeWorkspaceTab("archive")}>
          错题档案
          <span>{uniqueMistakes.length}</span>
        </button>
      </div>

      {mistakeWorkspaceTab === "ai" ? (
        <section className="mistake-ai-stage">
          <div className="mistake-chat-shell">
            <div className="mistake-upload-strip">
              {(mistakeDraft.files || []).length ? (
                mistakeDraft.files.map((item) => (
                  <article key={item.id}>
                    {item.previewUrl ? <img src={item.previewUrl} alt={item.name} /> : <FileText size={20} />}
                    <div>
                      <strong>{item.name}</strong>
                      <span>{Math.max(1, Math.round(item.size / 1024))} KB</span>
                    </div>
                    <button type="button" onClick={() => removeMistakeUpload(item.id)} aria-label="移除文件">
                      <Trash2 size={15} />
                    </button>
                  </article>
                ))
              ) : (
                <p>可以上传图片、PDF、Word、Excel，也可以只输入问题。</p>
              )}
            </div>

            <div className="mistake-meta-row">
              <label>
                <span>科目</span>
                <select value={mistakeDraft.subject} onChange={(event) => updateMistakeDraft("subject", event.target.value)}>
                  {mistakeSubjects.map((subject) => (
                    <option key={subject} value={subject}>
                      {subject}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>标题</span>
                <input value={mistakeDraft.title} onChange={(event) => updateMistakeDraft("title", event.target.value)} />
              </label>
            </div>

            <div className="mistake-prompt-box">
              <label className="mistake-plus-button">
                <Plus size={22} />
                <input
                  type="file"
                  multiple
                  accept="image/*,.pdf,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                  onChange={handleMistakeFile}
                />
              </label>
              <textarea
                value={mistakePrompt}
                onChange={(event) => setMistakePrompt(event.target.value)}
                placeholder="有问题，尽管问。也可以先点下面的快捷任务，再补充自己的要求。"
              />
              <button type="button" className="mistake-send-button" onClick={runMistakeWorkspaceAi} disabled={mistakeAiStatus === "loading"}>
                {mistakeAiStatus === "loading" ? <Loader2 className="spin" size={20} /> : <Send size={20} />}
              </button>
            </div>

            <div className="mistake-quick-actions">
              {Object.entries(mistakeQuickTasks).map(([key, task]) => (
                <button
                  key={key}
                  type="button"
                  className={mistakeTaskType === key ? "is-active" : ""}
                  onClick={() => applyMistakeQuickTask(key)}
                >
                  <Sparkles size={16} />
                  {task.label}
                </button>
              ))}
            </div>
          </div>

          <article className="mistake-result-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">AI输出</span>
                <h2>{mistakeResult?.title || "分析完成后，这里会生成干净完整的学习报告"}</h2>
              </div>
              <button type="button" className="ghost-action" onClick={downloadMistakeWordDoc} disabled={!mistakeResult}>
                <FileDown size={17} />
                下载Word
              </button>
            </div>
            {mistakeResult ? (
              <MistakeReportView report={mistakeResult} />
            ) : (
              <div className="mistake-empty-result">
                <Sparkles size={28} />
                <p>上传材料后，点击快捷任务，确认发送。AI会把结果整理成适合学生阅读的报告，并自动沉淀到错题档案。</p>
              </div>
            )}
          </article>
        </section>
      ) : (
        <section className="mistake-archive-stage">
          <article className="panel mistake-archive-toolbar">
            <div>
              <span className="eyebrow">个人错题库</span>
              <h2>选择错题，打包成PDF下载</h2>
            </div>
            <div className="mistake-archive-actions">
              <select value={mistakeArchiveSubject} onChange={(event) => setMistakeArchiveSubject(event.target.value)}>
                <option value="全部">全部科目</option>
                {mistakeSubjects.map((subject) => (
                  <option key={subject} value={subject}>
                    {subject}
                  </option>
                ))}
              </select>
              <button type="button" className="ghost-action" onClick={() => selectAllArchiveMistakes(visibleMistakes)}>
                <CheckCircle2 size={17} />
                全选
              </button>
              <button type="button" className="primary-action" onClick={() => downloadSelectedMistakesPdf(visibleMistakes)}>
                <FileDown size={17} />
                下载PDF
              </button>
            </div>
          </article>

          <div className="mistake-archive-layout">
            <div className="mistake-archive-list">
              {visibleMistakes.map((mistake) => (
                <article
                  key={mistake.id}
                  className={selectedMistakeId === mistake.id ? "mistake-archive-card is-active" : "mistake-archive-card"}
                >
                  <input
                    type="checkbox"
                    checked={selectedArchiveMistakeIds.includes(mistake.id)}
                    onChange={() => toggleArchiveMistake(mistake.id)}
                    aria-label={`选择${mistake.title}`}
                  />
                  <button type="button" onClick={() => setSelectedMistakeId(mistake.id)}>
                    <span>{mistake.subject} · {mistake.date}</span>
                    <strong>{mistake.title}</strong>
                    <p>{mistake.reason}</p>
                  </button>
                </article>
              ))}
            </div>
            <article className="panel mistake-archive-detail">
              {selected ? (
                <>
                  <span className="eyebrow">错题详情</span>
                  <h2>{selected.title}</h2>
                  <p><strong>科目：</strong>{selected.subject}</p>
                  <p><strong>来源：</strong>{selected.source}</p>
                  <p><strong>错因：</strong>{selected.reason}</p>
                  <p><strong>方法：</strong>{selected.method}</p>
                  {selected.knowledgePoints?.length ? <p><strong>知识点：</strong>{selected.knowledgePoints.join("、")}</p> : null}
                  {selected.suggestion ? <p><strong>训练建议：</strong>{selected.suggestion}</p> : null}
                  <p className="section-helper">已选择 {selectedArchiveItems.length} 道错题用于打包下载。</p>
                </>
              ) : (
                <div className="mistake-empty-result">
                  <Library size={28} />
                  <p>错题档案为空。先在AI错题处理页上传材料并完成分析。</p>
                </div>
              )}
            </article>
          </div>
        </section>
      )}
    </section>
  );
}

function MistakeReportView({ report }) {
  const sections = Array.isArray(report.sections) ? report.sections : [];
  const extracted = Array.isArray(report.extracted_questions) ? report.extracted_questions : [];
  const similar = Array.isArray(report.similar_questions) ? report.similar_questions : [];
  const suggestions = Array.isArray(report.training_suggestions)
    ? report.training_suggestions
    : Array.isArray(report.analysis?.training_suggestions)
      ? report.analysis.training_suggestions
      : [];

  return (
    <div className="mistake-report-view">
      {report.summary && <p className="mistake-report-summary">{report.summary}</p>}
      {sections.map((section, index) => (
        <section key={`${section.title}-${index}`}>
          <h3>{section.title}</h3>
          <p>{section.content}</p>
        </section>
      ))}
      {extracted.length > 0 && (
        <section>
          <h3>错题清单</h3>
          <div className="mistake-report-list">
            {extracted.map((item, index) => (
              <article key={item.id || index}>
                <strong>{index + 1}. {item.title}</strong>
                {item.question_content && <p>{item.question_content}</p>}
                <p>知识点：{Array.isArray(item.knowledge_points) ? item.knowledge_points.join("、") : item.knowledge_points || "待确认"}</p>
                <p>错因：{item.error_type || "待确认"}</p>
                <p>方法缺口：{item.method_gap || "待确认"}</p>
              </article>
            ))}
          </div>
        </section>
      )}
      {similar.length > 0 && (
        <section>
          <h3>同类训练题</h3>
          <div className="mistake-report-list">
            {similar.map((item, index) => (
              <article key={index}>
                <strong>{item.title || `训练题 ${index + 1}`}</strong>
                <p>{item.question}</p>
                {item.answer && <p>答案：{item.answer}</p>}
                {item.solution_steps && <p>解析：{Array.isArray(item.solution_steps) ? item.solution_steps.join("；") : item.solution_steps}</p>}
              </article>
            ))}
          </div>
        </section>
      )}
      {suggestions.length > 0 && (
        <section>
          <h3>后续训练建议</h3>
          <ul>
            {suggestions.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}

function renderMistakeReportHtml(report) {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const sections = Array.isArray(report.sections) ? report.sections : [];
  const extracted = Array.isArray(report.extracted_questions) ? report.extracted_questions : [];
  const similar = Array.isArray(report.similar_questions) ? report.similar_questions : [];
  return `
    <h1>${escape(report.title || "错题专项分析")}</h1>
    <p>${escape(report.summary || "")}</p>
    ${sections.map((section) => `<h2>${escape(section.title)}</h2><p>${escape(section.content)}</p>`).join("")}
    ${extracted.length ? `<h2>错题清单</h2>${extracted.map((item, index) => `<h3>${index + 1}. ${escape(item.title)}</h3><p>${escape(item.question_content || "")}</p><p>知识点：${escape(Array.isArray(item.knowledge_points) ? item.knowledge_points.join("、") : item.knowledge_points || "")}</p><p>错因：${escape(item.error_type || "")}</p><p>方法缺口：${escape(item.method_gap || "")}</p>`).join("")}` : ""}
    ${similar.length ? `<h2>同类训练题</h2>${similar.map((item, index) => `<h3>${escape(item.title || `训练题 ${index + 1}`)}</h3><p>${escape(item.question || "")}</p><p>答案：${escape(item.answer || "")}</p><p>解析：${escape(Array.isArray(item.solution_steps) ? item.solution_steps.join("；") : item.solution_steps || "")}</p>`).join("")}` : ""}
  `;
}
function downloadNoteSvg(note) {
  const blob = new Blob([note.svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${note.title || "知识图"}.svg`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function ModernKnowledgeNotePage({
  knowledgeQuestion,
  setKnowledgeQuestion,
  knowledgeNote,
  generateKnowledgeNote,
  downloadKnowledgeImage,
  status,
  useTemplate,
  setUseTemplate,
  promptTemplate,
  setPromptTemplate,
}) {
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(knowledgeNote.svg)}`;
  return (
    <section className="stack knowledge-page">
      <section className="panel knowledge-control-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">知识问题</span>
            <h2>输入一个想理解的知识点</h2>
          </div>
          <ImageIcon size={24} />
        </div>
        <div className="knowledge-input-row">
          <div className="knowledge-prompt-stack">
            <textarea
              className="knowledge-topic-input"
              value={knowledgeQuestion}
              onChange={(event) => setKnowledgeQuestion(event.target.value)}
              placeholder="例如：动物细胞结构、光合作用、二次函数图像、牛顿第一定律……"
            />
            <div className={useTemplate ? "knowledge-template-panel is-active" : "knowledge-template-panel"}>
              <div className="knowledge-template-header">
                <div>
                  <span className="eyebrow">提示词模板</span>
                  <h3>专业知识图提示词模板</h3>
                </div>
                <span>{useTemplate ? "已套用到本次生成" : "可查看，可修改"}</span>
              </div>
              <textarea
                value={promptTemplate}
                onChange={(event) => setPromptTemplate(event.target.value)}
                placeholder="这里可以放入知识图提示词模板，点击套用后会和上方主题一起用于生成。"
              />
            </div>
          </div>
          <div className="knowledge-actions">
            <button type="button" className="primary-action knowledge-generate-action" onClick={generateKnowledgeNote} disabled={status === "loading"}>
              {status === "loading" ? <Loader2 className="spin" size={19} /> : <Sparkles size={19} />}
              {status === "loading" ? "AI正在生成" : "AI生成知识图"}
            </button>
            <button
              type="button"
              className={useTemplate ? "template-action is-active" : "template-action"}
              onClick={() => {
                setUseTemplate((prev) => {
                  if (!prev && !promptTemplate.trim()) setPromptTemplate(defaultKnowledgePromptTemplate);
                  return !prev;
                });
              }}
              aria-pressed={useTemplate}
            >
              <Sparkles size={18} />
              {useTemplate ? "已套用模板" : "套用知识图模板"}
            </button>
          </div>
        </div>
      </section>

      <section className="knowledge-layout">
        <article className="panel knowledge-preview-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">图片预览</span>
              <h2>{knowledgeNote.title}</h2>
            </div>
            <button type="button" className="preview-download-button" onClick={downloadKnowledgeImage}>
              <Download size={17} />
              下载图片
            </button>
          </div>
          <div className="knowledge-image-frame">
            <img src={svgUrl} alt={knowledgeNote.title} />
          </div>
        </article>

        <aside className="panel knowledge-points-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">知识点拆解</span>
              <h2>图中包含的核心内容</h2>
            </div>
            <BookOpen size={24} />
          </div>
          <p className="knowledge-subtitle">{knowledgeNote.subtitle}</p>
          <div className="knowledge-point-list">
            {knowledgeNote.points.map(([name, desc], index) => (
              <article key={name}>
                <span>{index + 1}</span>
                <div>
                  <strong>{name}</strong>
                  <p>{desc}</p>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </section>
  );
}

function FreeAskPage({ messages, input, setInput, files, handleFiles, removeFile, sendFreeAsk, status, modelChoice, setModelChoice }) {
  const quickPrompts = ["帮我分析一道数学题", "把细胞结构做成知识图", "黑洞为什么会形成", "我总是拖延怎么办"];
  const formatSize = (size) => (size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`);
  return (
    <section className="free-ask-page">
      <div className="free-ask-center">
        <h2>你今天在想些什么？</h2>
        <p className="free-ask-intro">可以问作业、知识点、学习方法，也可以问科学、生活、兴趣和任何突然想到的问题。上传图片或文件后，AI可以结合材料一起回答。</p>
        <div className="free-ask-thread">
          {messages.map((message) => (
            <article key={message.id} className={message.role === "user" ? "free-message is-user" : "free-message"}>
              <strong>{message.role === "user" ? "我" : "树子AI"}</strong>
              <p>{message.content}</p>
              {message.attachments?.length > 0 && (
                <div className="free-message-attachments">
                  {message.attachments.map((file) => (
                    <span key={file.id}>
                      {file.previewUrl ? <ImageIcon size={15} /> : <FileText size={15} />}
                      {file.name}
                    </span>
                  ))}
                </div>
              )}
              {message.note && (
                <div className="free-note-preview">
                  <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(message.note.svg)}`} alt={message.note.title} />
                  <button type="button" className="ghost-action" onClick={() => downloadNoteSvg(message.note)}>
                    <Download size={17} />
                    下载图片
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
        {files.length > 0 && (
          <div className="free-attachment-tray">
            {files.map((file) => (
              <div className="free-attachment-chip" key={file.id}>
                {file.previewUrl ? <img src={file.previewUrl} alt="" /> : <FileText size={16} />}
                <span>{file.name}</span>
                <em>{formatSize(file.size)}</em>
                <button type="button" onClick={() => removeFile(file.id)} aria-label={`移除${file.name}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="free-ask-input">
          <label className="free-attach-button" aria-label="上传文件或图片" title="上传文件或图片">
            <Plus size={20} />
            <input type="file" accept="image/*,.pdf,.doc,.docx,.txt" multiple onChange={handleFiles} />
          </label>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                if (status !== "loading") sendFreeAsk();
              }
            }}
            placeholder="输入问题，也可以先点左侧 + 上传图片或文件"
          />
          <select
            className="free-model-select"
            value={modelChoice}
            onChange={(event) => setModelChoice(event.target.value)}
            aria-label="选择AI模型"
          >
            {freeAskModelOptions.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button type="button" className="free-send" onClick={sendFreeAsk} aria-label="发送问题" disabled={status === "loading"} aria-busy={status === "loading"}>
            {status === "loading" ? <Loader2 className="spin" size={20} /> : <Send size={20} />}
          </button>
        </div>
        <div className="free-ask-prompts">
          {quickPrompts.map((prompt) => (
            <button key={prompt} type="button" onClick={() => setInput(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function PlanCellTimeRange({ start, end, onStartChange, onEndChange }) {
  return (
    <div className="plan-cell-time-range">
      <span className="no-print">时间</span>
      <strong className="print-value plan-print-time">{start} - {end}</strong>
      <div className="no-print">
        <CompactTimePicker value={start} onChange={onStartChange} />
        <em>至</em>
        <CompactTimePicker value={end} onChange={onEndChange} />
      </div>
    </div>
  );
}

function CompactTimePicker({ value, onChange }) {
  const [hour = "19", minute = "00"] = value.split(":");
  return (
    <div className="compact-time-picker">
      <select value={hour} onChange={(event) => onChange(`${event.target.value}:${minute}`)} aria-label="小时">
        {hourOptions.map((item) => (
          <option value={item} key={item}>
            {item}
          </option>
        ))}
      </select>
      <b>:</b>
      <select value={minute} onChange={(event) => onChange(`${hour}:${event.target.value}`)} aria-label="分钟">
        {minuteOptions.map((item) => (
          <option value={item} key={item}>
            {item}
          </option>
        ))}
      </select>
    </div>
  );
}

function calculateCompletion(answers, steps) {
  const allQuestions = steps.flatMap((step) => step.questions);
  const answered = allQuestions.filter((question) => {
    const value = answers[question.id];
    if (question.type === "scoreTable") return value && Object.keys(value).length > 0;
    if (question.type === "scoreMatrix" || question.type === "yesNoGrid") return value && Object.keys(value).length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== "";
  }).length;
  return Math.round((answered / allQuestions.length) * 100);
}

createRoot(document.getElementById("root")).render(<App />);
