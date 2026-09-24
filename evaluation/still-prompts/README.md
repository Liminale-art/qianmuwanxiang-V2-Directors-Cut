# 静帧提示词：维护端离线评估语料

这是 R2-07 的验证准备，不是正式模型质量验收。所有正文、人设和世界信息均为本项目编写的虚构 SFW 资料；工具不读取 ST 用户库，不读取密钥，不发网络请求，也不提交生图。此目录、脚本和测试不进入插件发行白名单。

## 目的与边界

复用正在运行的 `buildStoryboardPlanContractRequest` 与 `completeStoryboardFocusedExtraction`：完整选层捕获 → 叙事取景/状态引用 → 程序校验 → 提示表达 → 原静帧合同。不是另写一套“看起来通过”的校验器。普通两调用与共享最多三次模型修复分别计数，缺少下一条记录只返回待录入请求，不记成模型故障。

当前 11 个用例覆盖厨房三镜/六镜、双人接触、跨层变化、回忆分支、不明身份、空镜、流式就绪/等待、长选层、叙事中类似指令的文本。每个用例有单独人工审阅清单。`tests/helpers/still-evaluation-fixture.mjs` 是校验器测试用的手写结构示例，**不是模型输出，也不是唯一正确的分镜答案**。

厨房六镜保留原始六镜目标。当前生产提取合同最多四镜，报告为 `unsupported_shot_range`，不发出被静默缩成四镜的请求、不接受替代回放、不计入模型失败。后续先审计镜头台数量、两阶段合同、镜组/流式额度和保存恢复的完整限制，再处理这一实现缺口；本工具不改变用户的默认值、并发或收费范围。

## 使用

在项目根目录执行：

```powershell
node scripts/still-prompt-eval.mjs
node scripts/still-prompt-eval.mjs --case kitchen-three
node scripts/still-prompt-eval.mjs --case kitchen-three --responses <本地评估记录.json>
```

第一条仅盘点可接受的合同范围。第二条输出 `nextRequest`：真实系统/用户消息、schema、阶段、修复标记、maxTokens 和请求摘要，内容仅为合成语料。第三条用已取得的本地记录逐次回放，直至得到下一请求、最终结构结果或明确合同失败。真实模型测试仍需另外授权；这个脚本不具备请求地址、Key 或自动发送参数。

创建空记录的接口为 `emptyTranscript(caseId)`（从 `scripts/still-prompt-eval.mjs` 导入）。记录必须保留它返回的 `schema`、`corpusRevision`、`caseId`、`caseDigest` 和 `responses`。每次把当前 `nextRequest.requestDigest` 与对应模型返回的完整原文追加到 `responses`：

```json
{
  "requestDigest": "当前请求的64位摘要",
  "raw": "模型返回原文，包括其实际代码围栏或格式错误",
  "usage": {"inputTokens": 1200, "outputTokens": 600, "totalTokens": 1800},
  "latencyMs": 3500
}
```

`usage`、`latencyMs` 均可省略；没有计量值时保持未知，不估算为零。提供的计量值只被标记为“外部记录、未经独立核验”；cost 始终未知。不要手修模型原文来提高首答通过率；修复应使用工具返回的下一修复请求，保留此前全部记录。请求摘要绑定本次提示内容、合同、阶段、修复标记和输出预算；不接受换语料、错顺序、过期提示、多余返回或隐藏调用。摘要是可复现的配对依据，不是模型供应商证明或防伪签名。

本地文件最大 4 MiB，最多五条返回，单条原文最大 1 MiB。更大的记录明确拒绝而非截断；生产合同自身的输出/修复上限仍照常执行。工具不写结果文件、不扫描目录、不自动收录聊天。CLI 成功/等待返回码为 0，合同失败或当前不支持为 2，输入/工具错误为 1；默认盘点命令返回 0 并明确列出所有缺口，不是质量通过信号。

## 如何读结果

- `awaiting_response`：尚缺当前请求的记录；不是调用失败。`nextRequest.repair=true` 表示前一答已未通过，尚未消耗该次修复的外部记录。
- `structurally_valid`：真实合同和来源引用可接受，**不代表语义、叙事质量或画质合格**。错误但结构合法的提示仍可能得到这一状态，必须人工审阅。
- `contract_failed`：实际生产合同已拒绝，报告原诊断阶段。空白/过大返回不自动尝试修复；共享修复次数耗尽即停止。
- `unsupported_shot_range`：现有实现无法表达要求，不归咎于模型。

`firstPass` 区分 true/false/未知；代码围栏等纯语法规整不算额外模型修复，原规整项目保留在 `result.stages`。调用数只统计消费的记录，缺失的下一答不算已调用。源状态保存仅为内存合成宿主计数，流式仍按真实合同延后，既不写 ST 文件，也不证明跨端存储已验。

## 真实验收仍待

授权后以不同能力档的实际提取模型，对同一语料和冻结提示版本分别记录原答、修复、真实 tokens、耗时与费用；人工独立审阅各用例清单。统计须区分格式/引用失误与语义失误，保留零图/等待的合理结果，不能用解析率代替叙事质量。还需补正式渠道兼容与真实生成的构图、人物、互动和比例效果，不从这组 SFW 合成样本推断全部题材质量。

报告中的 `semanticReview=not_reviewed`、`realModelQuality=not_established` 和 `releaseQualified=false` 不因手写夹具通过而改变。正式提示词定稿、两云工作流质量与许可、真实 ST/手机/跨端验收及 R2-08 四闸门仍未完成。
