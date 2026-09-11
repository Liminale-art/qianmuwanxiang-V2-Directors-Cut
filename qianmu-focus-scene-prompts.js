// PROMPT-PENDING-FOCUS-SCENE: revise in the unified prompt-writing unit, not in this UI iteration.
// Existing prompt text, unchanged; provider calls and cancellation use the current Qianmu API in the host.
export function pickFocusStockLines(source,count){
  const bank=[...source],result=[];
  while(result.length<count){if(!bank.length)bank.push(...source);result.push(bank.splice(Math.floor(Math.random()*bank.length),1)[0]);}
  return result;
}
export function focusScenePrompts({relationMeta,characterDescription,binding,count,subject}) {
  const systemPrompt = `你是“千幕专注场景”的角色短句编写器。你的唯一任务是让指定角色在专注计时中自然地提醒、陪伴或收束，不续写剧情，不扮演用户，不引用聊天正文。

【绝对边界】
1. 仅依据角色人设、用户手动选择的关系档、当前专注事项写台词；不得猜测正文情节、双方共同经历或未给出的关系进度。
2. 角色必须自然且不 OOC：措辞、礼貌程度、情绪表达与角色人设一致；不把“专注提示”写成客服模板。
3. 关系档为“${relationMeta.label}”：${relationMeta.rule}
4. 每句 12—42 个汉字，只说一句话，不写动作、旁白、引号、名字前缀、舞台说明或表情符号。
5. 不使用“作为AI”、任务分析、行数说明、思维链或标签。只输出严格 JSON：{"lines":["台词1","台词2"]}，数组数量必须为 ${count}。`;
  const userPrompt = `角色：${binding.speaker}
角色人设：${characterDescription}
专注事项：${String(subject || '完成一段专注').slice(0, 160)}
需要 ${count} 句彼此不重复的专注场景短句；最后一句用于完成时收束，其余用于长时专注中的低频陪伴。`;
  return {systemPrompt,userPrompt};
}
