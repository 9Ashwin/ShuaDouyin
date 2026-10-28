# 记忆与人格

## 引导

`dy onboarding show` 读引导状态。pending 或 unknown 时，自然地询问名字、性格语气、相处边界和用户希望记住的事实；尊重跳过或稍后。

已完成的人设不要重复询问或覆盖。用户确认后调用 `onboarding complete`，暂不设置可调用 `onboarding skip`。

## 改人格与人物档案

```bash
dy workspace get AGENTS.md
dy workspace set AGENTS.md --text-file <文件> --if-match <revision>
dy workspace history AGENTS.md
dy workspace restore AGENTS.md --revision <revision>
```

`MEMORY.md` 是生成的导航，不手工编辑。人格变化要有依据，并保留用户已定的设定。

## 写记忆

每轮对话或浏览结束，判断是否有值得长期保存的信息。不要写普通寒暄或整段聊天。

自行提炼事实：为每条给出 `text`、`sources`，按需提供 `keywords` 和 `profile_ref`，以 JSON 交给：

```bash
dy memory candidates --text-file <文件>
```

候选使用有界词法与两跳关系匹配，可能漏掉相关记忆，不代表语义相同。

根据事实和候选选择一条 `ADD`、`UPDATE`、`DELETE` 或 `NOOP`：

```bash
dy memory decide --text-file <文件>              # 预览
dy memory decide --text-file <文件> --apply --request-id <唯一ID>
```

更新与删除须带目标 ID、revision 和来源事实索引。删除会清理历史。

中断后先用 `memory decision-status --request-id <id>` 检查：已完成的相同请求可重放，prepared 状态需要先核对目标，不能自动重做。

## 来源与不确定性

用户亲口表达的内容用 `user:` 来源和 `user-stated` 记录；推测用 `inferred`，保留不确定性。

未经用户确认，不把单次观察升级成固定人格或用户事实。bot 自身兴趣、用户偏好、其他人事实与推测分开保存。

`memory candidates` 和 `memory decide` 返回的 `source_checks` 只验证来源归属；收据 `status_at_check` 是检查或决策时的快照，不证明事实或送达。

## 学习表达

学习梗时记下原句或简短描述、来源、使用语境、可能含义、适用对象和时间。

含义不清时待核实；多次不同来源支持后再形成可修正的表达偏好；过时或不合语境时不用。

详细策略见 `references/browse-and-grow.md`。

## 处理成长事件

逐条处理并保存需要保留的产物后，按顺序 `growth ack --event-id <事件ID>` 确认进度。

未处理、失败或中断时不要确认，后续可以继续。
