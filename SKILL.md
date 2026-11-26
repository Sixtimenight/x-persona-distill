---
name: x-persona-distill
description: 从 X (Twitter) 博主的真实回复与原贴中采集 ~1000+ 条语料，做量化统计与观点聚类，蒸馏生成符合 x-reply-batch 插件 `xrb-persona-v1` 标准的单条或批量语气包 JSON（可直接一键导入插件「学语气 → 语气包」）。当用户要求学习/模仿/提炼某个或多个 X 博主的语气、生成语气包 JSON、批量提炼推特人设时使用。
---

# X Persona Distill（推特语气包提炼 Skill）

把任意 1 个或多个 X (`@handle`) 博主的真实发言（默认目标 ~1,000+ 条，跨时间窗口覆盖回复与原贴）蒸馏为 `x-reply-batch` 插件可直接导入的 `xrb-persona-v1` JSON 文件。

## 标准输出格式：`xrb-persona-v1`

插件在「学语气 → 语气包」支持 **导入文件（可多选）** 和 **粘贴 JSON**，兼容三种形态：

### 1. 单人语气包（`.xrb-persona.json`）

```json
{
  "schema": "xrb-persona-v1",
  "name": "博主显示名",
  "handle": "TwitterHandle",
  "sourceCount": 1200,
  "updatedAt": "2026-11-26",
  "zhStyle": "中文自定义风格（人设、句长中位数、标点/emoji习惯、高频称呼与口头禅、表达禁忌）",
  "enStyle": "英文自定义风格（如博主常发英文则填写，否则留空字符串）",
  "memory": "长期记忆（身份、背景、固定信条与日常状态，每行一条）",
  "keywordRules": [
    {
      "keywords": ["触发词1", "触发词2", "触发词3"],
      "points": "命中任意触发词时要自然带出的真实观点与立场"
    }
  ]
}
```

### 2. 批量语气包（多人合集 `.xrb-persona.json`）

```json
{
  "schema": "xrb-persona-v1",
  "personas": [
    {
      "name": "博主A",
      "handle": "HandleA",
      "sourceCount": 1100,
      "updatedAt": "2026-11-26",
      "zhStyle": "...",
      "enStyle": "",
      "memory": "...",
      "keywordRules": [
        { "keywords": ["词1", "词2"], "points": "..." }
      ]
    },
    {
      "name": "博主B",
      "handle": "HandleB",
      "sourceCount": 1050,
      "updatedAt": "2026-11-26",
      "zhStyle": "...",
      "enStyle": "...",
      "memory": "...",
      "keywordRules": []
    }
  ]
}
```

> 插件同样兼容顶层纯数组 `[ { ... }, { ... } ]`，也兼容 `customZhStyle` / `styleHints` / `topicsText` / `topicRules` 等别名；重复导入同 `handle` 或同 `name` 的语气包会自动覆盖更新，不会产生重复项。

---

## 执行流程

### Step 1：采集并量化分析语料

使用本 Skill 同目录下的脚本 `scripts/fetch_and_analyze.mjs`（底层调用 `twitter-cli`，自动处理 Windows 非 ASCII 用户名下的 `CURL_CA_BUNDLE` 证书路径问题，自动用 `max_id` + 多个历史日期窗口分页，去重并过滤纯转推）：

```bash
node <skill_dir>/scripts/fetch_and_analyze.mjs <handle> --target 1100 --out-dir ./personas
```

批量提炼多个博主时，可依次对每个 `<handle>` 运行该脚本（每个目标 1,000+ 条约需 1～2 分钟）。

脚本会产出两份中间文件：
- `<out-dir>/<handle>-corpus.json`：去重后的原始非转推语料（回复 + 原贴）
- `<out-dir>/<handle>-report.txt`：量化统计报告（句长分位数、句号/波浪号/换行比例、emoji 频率 Top 25、高赞原贴、高赞长回复、跨时间段随机回复抽样）

### Step 2：读取报告并深度蒸馏

读取 `<handle>-report.txt`（必要时抽查 `<handle>-corpus.json` 中的高频实体/长回复），按以下标准提炼：

1. **`zhStyle`（中文风格，核心）**
   - 依据真实统计数据写明**句长区间与中位数**（例如“常规 4～15 字，中位数约 7 字”）。
   - 写明**标点与排版习惯**（是否打句号、是否用波浪号/省略号/空格断句）。
   - 写明**emoji 出现比例与真实 Top 常用表情及场景映射**。
   - 列出真实高频**称呼词、口头禅、句首/句尾模板、谐音梗**。
   - 写明**禁忌**（避免 AI 腔、客服套话、强行分点说教等）。
2. **`enStyle`（英文风格）**
   - 若该博主英文推文/回复占比 >= 10%，按同样方法提炼英文风格；否则留 `""`。
3. **`memory`（长期记忆）**
   - 从 Bio 与高频自述中提炼 2～5 条稳定人设/背景/信条，不要把偶发事件塞进长期记忆。
4. **`keywordRules`（按词触发观点，建议 5～10 条）**
   - 只提炼在语料中**反复出现、态度鲜明**的话题（产品、公司、人物、行业现象、平台机制等）。
   - 每条给 3～8 个高命中触发词（中英文/俗称/缩写一起覆盖），`points` 用简洁口语概括其真实立场与常用梗。

### Step 3：写入 `xrb-persona-v1` JSON 并校验

- 单人输出保存为 `<out-dir>/<handle>.xrb-persona.json`。
- 多人批量输出额外合并保存为 `<out-dir>/batch-<YYYY-MM-DD>.xrb-persona.json`（`{ "schema": "xrb-persona-v1", "personas": [...] }`）。
- 校验 JSON 可被 `JSON.parse` 正常解析且无空规则后，把 JSON 内容和文件路径提供给用户，提示在插件 **「学语气 → 导入文件 / 粘贴 JSON」** 直接导入即可。
