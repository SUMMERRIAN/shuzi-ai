# 树子AI智能体与PostgreSQL档案设计

## 核心逻辑

树子AI不是单次问答工具，而是围绕学生长期学习档案运行的学习教练系统。

1. 先了解学生：通过学情问卷、学情陈述、语音陈述、试卷分析、错题上传收集信息。
2. 建立学生档案：每个学生拥有独立 `student_id`，所有数据写入 PostgreSQL。
3. 形成学情画像：AI在学情画像页统一整合问卷、陈述、试卷、错题、计划执行、每日反思和每周讨论。
4. 制定策略与任务：AI根据画像为每个科目提出学习策略、学习任务、资料使用方式和完成标准。
5. 制定学习计划：AI根据策略任务和空闲时间生成计划，并选择方法训练和习惯培养目标。
6. 持续更新画像：学习计划、每日反思、每周讨论、错题训练和试卷分析会不断反哺学生档案。

## 智能体名称

`树子AI学习教练智能体`

使命：围绕学生长期学习档案，先了解学生，再形成学情画像，再辅助制定科目策略、学习任务、学习计划、方法习惯训练和错题训练。

## PostgreSQL核心表

- `users`：账号、邮箱、手机号、会员状态。
- `students`：学生基本信息、年级、学校、目标、绑定家长。
- `student_intake_questionnaires`：学情问卷原始答案和版本。
- `student_statements`：文字陈述、组合问题、影响程度、场景标签。
- `statement_audio_files`：语音文件、转写文本、入库状态。
- `paper_uploads`：试卷、错题、作业图片或PDF。
- `paper_analysis_reports`：试卷AI分析、知识漏洞、方法缺口。
- `student_learning_profiles`：学情画像报告、维度评分、证据、版本。
- `subject_strategies`：科目学习策略。
- `learning_tasks`：具体学习任务、资料、步骤、完成标准。
- `weekly_study_plans`：周学习计划。
- `method_habit_training`：方法训练和习惯培养评分表。
- `daily_reflections`：每日反思。
- `weekly_discussions`：每周讨论。
- `mistake_files`：错题文件。
- `mistake_questions`：错题题干、错因、知识点、解析。
- `generated_practice`：AI生成同类题、答案和训练结果。
- `knowledge_notes`：知识笔记、知识图、下载记录。
- `ai_run_logs`：每次AI调用的任务类型、提示词、输入摘要、输出、模型和时间。

## 会员、存储与LT计费规则

### 存储空间

- 免费用户：50MB。
- VIP会员：3GB。
- 扩容包：20GB、50GB。

存储空间用于保存试卷图片、错题图片、PDF、语音、知识图、学习计划和AI报告。正式版需要在上传前检查用户剩余空间，超过限制时提示升级会员或购买扩容包。

### LT充值与API成本关系

用户前台只看到 `Learning Token（LT）`，不显示 OpenAI token。

建议固定：

- `1 LT = 0.01元人民币`
- `100 LT = 1元人民币`
- 运营汇率暂按 `1 USD = 6.82 CNY`
- 充值费用与真实API消耗费用保持 `4.2倍`

后台扣费公式：

```text
LT消耗 = API真实美元成本 × 6.82 × 4.2 × 100
```

示例：

```text
一次AI调用真实成本 = $0.03
LT消耗 = 0.03 × 6.82 × 4.2 × 100 ≈ 86 LT
```

### LT充值包

| 充值金额 | 获得LT | 约覆盖真实API成本（人民币） | 约覆盖真实API成本（美元） |
|---:|---:|---:|---:|
| ¥9.9 | 990 LT | ¥2.36 | $0.35 |
| ¥29.9 | 2,990 LT | ¥7.12 | $1.04 |
| ¥59.9 | 5,990 LT | ¥14.26 | $2.09 |
| ¥99 | 9,900 LT | ¥23.57 | $3.46 |
| ¥199 | 19,900 LT | ¥47.38 | $6.95 |

这里没有设置大额赠送，因为你要求充值费用与真实API消耗费用维持4.2倍。如果后续要做促销，可以单独发放“赠送LT”，并在后台标记为营销成本。

## AI任务边界

### 学情画像

只做统一分析：整合学生档案，输出核心问题、证据、维度评分、成因、追问问题和下一步优先级。

不能直接生成完整周计划，不能生成相似题，不能输出知识图片。

### 策略与任务

只根据学情画像为某个科目生成学习策略、学习任务、资料使用建议和完成标准。

不能重新做整体画像，不能安排具体周历时间。

### 学习计划

只根据已确认策略任务和学生空闲时间生成周计划，并选择1-3个方法或习惯训练目标。

不能重新诊断学情，不能分析具体错题图片。

### 试卷分析

只识别试卷、错题或作业材料，分析错题内容、题型、知识漏洞、解题方法缺口、步骤问题和训练建议。

不能替代学情画像总报告，不能制定完整学习计划。

### 错题专项

只围绕已入库错题生成同类题、错因复盘、答案解析和复测安排。

### 知识笔记

只把学生提出的知识问题整理成严谨知识讲解和可下载知识图。

### AI自由问

回答学生即时学习问题。涉及画像、策略、计划、错题或知识图时，要使用对应任务边界，不绕过会员权限。

## 正式后端接口建议

- `POST /api/students/:id/questionnaires`
- `POST /api/students/:id/statements`
- `POST /api/students/:id/statement-audio`
- `POST /api/students/:id/papers`
- `POST /api/students/:id/papers/analyze`
- `POST /api/students/:id/profile/generate`
- `POST /api/students/:id/strategies/generate`
- `POST /api/students/:id/plans/generate`
- `POST /api/students/:id/mistakes`
- `POST /api/students/:id/mistakes/generate-practice`
- `POST /api/students/:id/knowledge-notes/generate`
- `GET /api/students/:id/archive`

正式版不要在前端保存 OpenAI API Key。前端只调用后端接口，由后端完成权限校验、读取PostgreSQL档案、拼装智能体提示词、调用OpenAI、保存AI输出。
