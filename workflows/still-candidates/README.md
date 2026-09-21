# 千幕静帧维护候选（非正式内置）

四份实际 API 图分别面向 Comfy Cloud / RunningHub 的动漫插画与艺术化 CG。它们是 R2-07 的维护候选，不是已验证产品：不进入插件菜单、不写用户设置、不进入安装包，也不能作为免试运行或自动准入的凭据。尚未进行真实云生成、质量评审或发行许可核定。

## 当前内容与选择理由

- Comfy Cloud 动漫：Anima Base v1，分离的扩散模型、文本编码器和 VAE，9 个节点。官方模板提供此加载方式；千幕重写成固定 API 图，只暴露提示、排除词、种子和宽高，不带官方示例人物或临时分支。
- RunningHub 动漫：平台公开的 Anima Base v1 checkpoint 封装，7 个节点。与前者分别维护，不能推断其权重、VAE、编码器或表现完全等同；平台实际加载及封装来源仍待核查，不自动回退到其他模型。
- 两个平台的 CG：分别保存 SDXL Base 1.0 的 7 节点版本，固定艺术化 3D / 影视与游戏渲染方向词。它只是可检验的起点，不因结构简单或可运行就锁定为最终模型。真实输出若偏日常摄影、身份或接触不稳、细节不足，需更换候选后重验。
- 每份有独立平台身份、候选版本、节点/模型依赖、5 组常用宽高像素、固定采样参数、费用能力边界及公开来源。费用金额未知，不将云 GPU 调用写成免费。
- 当前仅无参考图文生图、SFW；没有角色身份锁、参考图、多人分区、视频或动态能力。不能将此子范围视为全部角色/参考需求完成，更不能向用户显示不存在的开关。

公开模型页只是来源线索，不是当前账户的模型目录证明。曾查到名称含 V3.1 的 Animagine 页面实际展示 v30 文件，因此没有按页面标题猜一个 v31 文件。最终必须以真实平台查询/执行证据为准。

## 免费离线检查

从仓库根目录运行（只读取候选 JSON，零网络、零提交）：

```sh
node scripts/comfy-still-candidates.mjs
node --test tests/comfy-still-candidates.test.mjs
```

检查会将 4 × 5 个尺寸送入现有工作流绑定、静帧数量审计及云请求准备器；输出固定摘要和每个执行图摘要。它不调用云平台、不安装依赖、不生成样例图、不证明模型真实可用。

如维护者在另获授权后需要导入现有工作流库，可将下述命令的标准输出作为 JSON 导入内容；名称自带“待验证”，仍走原手动确认，不改变普通用户配置：

```sh
node scripts/comfy-still-candidates.mjs --export comfy-cloud-anime
```

其余 ID 为 `comfy-cloud-cg`、`runninghub-anime`、`runninghub-cg`。没有提交、登录、安装或自动升级选项。不要把候选 JSON 当画布 JSON；`document.workflow` 是 API 图，导出是千幕现有工作流库格式。

## 转为正式内置前必须完成

1. 使用维护专用账户核对指定平台的实际版本、模型文件/权重身份、所有节点和输入；不由用户补安装未知节点。Anima 封装版须额外确认模型/CLIP/VAE输出都有效。记录平台环境、候选摘要、依赖身份，不能只记录名字。
2. 先确认允许的测试数据与费用预算，再试跑。至少覆盖计划发行的宽高、单人/双人互动、环境与物件，并检查正确输入传递、真实种子、只有一个输出、回执与完整收片、原任务恢复。失败停止，不重投收费或替换路线。无需一次性执行全部付费矩阵，按授权范围分批记录。
3. 单独评审叙事画面：人物和动作接触归属、构图、色彩/光线、动漫与艺术化CG风格。短词、复杂多人、长提示的质量不足不能靠“接口成功”签收；必要时调整模型或图并重新建立版本证据。
4. 核对平台计费类型、实际使用额度与许可；此处不分发模型权重。Anima当前模型卡列非商业许可，封装来源与平台使用许可需另核；SDXL采用自身模型许可。上游模板的 MIT 不等于模型权重无条件可用。
5. 将通过维护验收的不可变图和测试范围接入正式内置目录、默认选择及后端可信校验；普通用户不必先手动试跑补上维护验收。改节点、模型、尺寸支持、参考模式或运行档位必须重新核定对应范围，历史任务保留原配方。
6. 验证真实ST、窄屏/PC、安装包、跨端、迁移与失败提示，才可计入 R2-08。当前候选、离线测试及导出功能都不计真实验收。

## 来源与许可记录

维护查阅日：2026-09-22。图结构参考 Comfy Org 官方基础节点及模板说明，自行编写千幕槽位、节点标识和画风层；没有复制第三方社区创作词、人物、画面或图片。官方模板参考固定至 `371a7b7171bbd11e9cc92ef615ba5ad223d7e5b4`，MIT 声明见同目录 `UPSTREAM_LICENSE.txt`；模型来源和许可复核提示各自在 JSON 中记录。

- [官方 Anima 模板](https://github.com/Comfy-Org/workflow_templates/blob/371a7b7171bbd11e9cc92ef615ba5ad223d7e5b4/templates/image_anima_base_v1.json)
- [官方 SDXL 模板](https://github.com/Comfy-Org/workflow_templates/blob/371a7b7171bbd11e9cc92ef615ba5ad223d7e5b4/templates/image_sdxl_simple.json)
- [Anima 模型卡](https://huggingface.co/circlestone-labs/Anima)
- [SDXL Base 1.0 模型卡](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0)
- [RunningHub Anima 封装](https://www.runninghub.ai/model/public/2056984566501568513)
- [RunningHub SDXL Base 1.0](https://www.runninghub.ai/model/public/1876879344525365250)

这些链接仅供维护者查阅，代码不在运行时访问或下载它们。
