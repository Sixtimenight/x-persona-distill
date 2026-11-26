# x-persona-distill

把任意 X（Twitter）博主的真实回复与原贴（默认采集 1,000+ 条，跨时间窗口）做量化统计与观点聚类，自动蒸馏成 **`xrb-persona-v1`** 标准语气包 JSON，可直接一键导入 **流速批量回帖 (`x-reply-batch`)** 插件。

## 目录结构

```text
x-persona-distill/
├── SKILL.md                           # Agent Skill 指令文件
├── scripts/
│   └── fetch_and_analyze.mjs          # 基于 twitter-cli 的分页采集 + 量化统计脚本
└── examples/
    └── sample-batch.xrb-persona.json  # xrb-persona-v1 批量格式示例
```

## 前置条件

- Node.js 18+
- 已安装并登录 [`twitter-cli`](https://github.com/jackwener/twitter-cli)（执行 `twitter status` 显示已登录即可）

## 安装 Skill

把本仓库克隆到你的 AI Agent 的 `skills` 目录即可：

```bash
# Antigravity / Codex / 通用工作区
git clone https://github.com/Sixtimenight/x-persona-distill.git .agents/skills/x-persona-distill

# Claude Code
git clone https://github.com/Sixtimenight/x-persona-distill.git ~/.claude/skills/x-persona-distill
```

## 使用方式

### 1. 直接跟 AI 说（推荐）

装好 Skill 后，直接在对话里说：
- 单人：`用 x-persona-distill 提炼 @某博主 的语气包`
- 批量：`用 x-persona-distill 批量提炼 @博主A @博主B @博主C 的语气包`

Agent 会自动调用 `scripts/fetch_and_analyze.mjs` 爬取 1,000+ 条语料、做量化分析，并输出可直接导入插件的 `.xrb-persona.json`。

### 2. 手动运行采集统计脚本

```bash
node scripts/fetch_and_analyze.mjs <TwitterHandle> --target 1100 --out-dir ./personas
```

运行后会在 `./personas/` 下生成：
- `<handle>-corpus.json`：去重后的非转推语料（回复 + 原贴）
- `<handle>-report.txt`：句长分位数、标点习惯、emoji 频率 Top 25、高赞原贴、长回复与跨时间抽样

## 导入到「流速批量回帖」插件（v1.17.0+）

1. 打开 X 页面上的插件面板，点击 **「学语气」**。
2. 在弹窗顶部的 **「语气包」** 区域：
   - 点 **「导入文件」**：可单选单个 `.json`、**一次多选多个 `.json`**，或导入一个包含多人的批量包。
   - 或点 **「粘贴 JSON」**：直接粘贴 AI 输出的 JSON（自动兼容 Markdown 代码块）。
3. 导入后会自动保存并生成顶部标签，**点击博主名字即可一键切换**整套中文风格、英文风格、长期记忆与按词触发规则。
4. 点 **「导出当前」** 可把自己微调好的风格导出为 `.xrb-persona.json` 备份或分享。

## `xrb-persona-v1` 格式规范

支持 **单人对象**、**批量合集 `{ "schema": "xrb-persona-v1", "personas": [...] }`** 或 **顶层 JSON 数组 `[...]`**：

```json
{
  "schema": "xrb-persona-v1",
  "name": "博主显示名",
  "handle": "TwitterHandle",
  "sourceCount": 1200,
  "updatedAt": "2026-11-26",
  "zhStyle": "中文风格、句长节奏、标点/emoji、口头禅与禁忌",
  "enStyle": "英文风格（可选，留空为默认）",
  "memory": "长期记忆（每行一条）",
  "keywordRules": [
    {
      "keywords": ["触发词1", "触发词2"],
      "points": "命中触发词时要自然带出的观点"
    }
  ]
}
```
