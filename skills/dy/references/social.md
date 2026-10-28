# 社交关系

把「看过、聊过」变成能回答「这个人现在处于哪一步、下一步该做什么」的记录。这一层是可选的：只刷内容不接触人时用不到它。

## 先定义要找什么人

```bash
dy social goal --text "想认识做独立游戏开发的人" --goal-preset friend
dy social goal --text "找有代运营需求的商家" --goal-preset lead --daily-limit 3
```

`--goal-preset` 选阶段词表：

| 预设 | 阶段 |
| --- | --- |
| `friend`（默认） | discovered → met → talking → connected → resting |
| `lead` | lead → contacted → qualified → won → lost |

也可以 `--stages "a,b,c,d"` 自己定义。**阶段词表属于目标，不属于代码**——这正是从「社交」扩到「获客」不用改代码的原因：换一套词，同一套命令就变成了销售漏斗。

`--daily-limit` 是每个目标的每日触达上限。`social.pause` 停手但保留观察，`social.resume` 恢复，`social.goalpause <id>` 停用某个目标。

## 从已读内容里找线索

`--sources` 指向一个 JSON **文件**，里面每一段文字都得是你已经读到、能标出来源的：

```bash
cat > /tmp/sources.json <<'JSON'
[
  {"person": "MS4wLjABAAA…", "name": "示例用户", "where": "评论区",
   "source": "comment:7698346212324830650", "text": "有没有靠谱的编曲老师推荐"}
]
JSON
dy social signal --sources /tmp/sources.json
```

`signal` 只在**调用方提供的文本**里找明确的表达：提问、需求、比较。它不发请求、不扩权限、不读平台。返回的每条都带原文和置信度，`scope` 字段写明这只看你给的东西。

判出来的三种 `kind`：

- `asking` — 直接要推荐、要联系方式、问价格（0.7）：`求推荐`、`哪里买`、`多少钱`、`想找`
- `intent` — 说明了需求但还没开口问（0.5）：`打算做`、`需要`、`预算`、`合作`
- `research` — 在评估，可能只是在看（0.2）：`好用吗`、`值不值`、`哪个好`、`怎么样`

`research` 也列出来，因为它说明这个人已经在市场里；但它**不是**线索，不要按线索计数。

「已经买了」「不感兴趣」这类否定说法会被排除，不会因为命中关键词就被算成机会。

**一句话里命中了词，不等于这是个客户。** 返回里会明确写着这一点。

```bash
dy social discover --goal <id> --limit 10
```

`discover` 把信号变成候选，每条带理由。理由是给人看的，不是给代码做决定的——最终要不要接触由调用方判断。

## 记录关系

```bash
dy social stage <person> --stage talking --note "聊了两次编曲"
dy social relation <person>          # 一张卡 + 最近互动
dy social list
dy social followup <person> --topic "问他新专辑进度" --due 2026-11-02
dy social due                        # 今天谁该联系，为什么
dy social done <person>
dy social forget <person> --reason "聊不来"
```

`<person>` 用稳定 ID（`sec_uid`），不用昵称。

**阶段自动推进有上限。** 代码只能把关系推断到词表的某个位置为止，再往后必须由调用方明确 `social stage` 写进去。理由很简单：一个人跟你熟不熟，是他自己的事，不是消息条数能证明的。

## 结果与归因

```bash
dy social outcome <person> --outcome won --goal <id> --signal <信号>
dy social outcomes
```

`outcome` 记录「这个人最后怎么样了」，并挂在某个目标下。`outcomes` 按目标汇总：触达了多少人、多少人推进了、多少人结束了。这是获客方向唯一有意义的中间指标——发出去多少条不是。

## 审计

```bash
dy social log --since 2026-10-01
```

`log` 是这个 agent 看过什么、做了什么、提议了什么，最新在前。它读本地事件，不读页面。

## 边界

- 不认识的账号，不要凭一次浏览就发私信。
- 每日上限是给自己定的，不是给平台定的；用完就是今天的额度用完了。
- `social forget` 是「放着」不是删除历史——事件还在 `social log` 里。
