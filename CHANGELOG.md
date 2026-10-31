# Changelog

## 0.4.0 — 2026-10-31

### 新增

- `chat recall` — 撤回自己发的一条私信。平台窗口是 3 分钟；超时后菜单里还有「撤回」但服务端会拒，所以它读响应而不是猜时间。没有二次确认，因此要 `--request-id`。
- `chat inbox` — 谁在等我回。未读徽标不可靠（打开会话就清），所以按「最后一句是不是对方说的」判断，并把对方分享的作品 id 放进 `shared_works`。
- `browse checkpoint` — 每批一条：走了哪条路、看到什么、每个交付条件是什么状态、下一步去哪里。进度从这些记录推导，不采信调用方的自述。
- `browse start --text-file` — 一轮要交付什么、按什么标准判、什么时候停。写一次不能改，改条件就是换一轮。
- `browse end --outcome` — `completed` 要求 checkpoint 真的达标，否则拒绝；`partial` 是诚实的交付。
- `persona show` — 按段读取人格，每段带 `complete`。`context show` 从头截断，人格的「身份与声音」在后面，预算不够时会静静切掉。
- `auth grant` / `auth revoke` / `auth grants` — 记住某个人可以做什么，带期限、每日上限和撤销记录。不是开关。

### 改进

- `page facts --selector` 只返回问到的标记：4440 → 618 字节。
- `chat read` 不再复述上一条读到的消息内容：8832 → 4215 字节。
- `comment list` 去掉每行重复的作品 id 和恒为 false 的布尔：2689 → 1849 字节。
- `video digest` 不传 `--frames` 时按时长采样。之前两个默认值叠起来，让它从来没生效过。
- 每个页面命令的返回会带 `persona` 字段，提醒这一轮还没读人格、读的是旧版本、或从没读过。
- 三个预设各带一组同一事实的对照示例，说明这个声音在四种场景下怎么说话。

### 修复

- `chat read` 只读视口内的消息。真实群 13 条只返回 7 条，**漏掉的全是别人说的**。
- `chat inbox` 把「新到旧」的数组当成「旧到新」，`awaiting_reply` 一直是反的。
- 分享卡的作品 id 读不出来：`parsedContent` 是 getter，而 `own()` 故意拒绝 accessor。
- `comment list` 和 `comment replies` 的关联信息移到结果顶层，不再每行重复。

### 移除

- `src/operations/actions.ts` — 提案/批准模型，从未被任何命令或模块引用。它的每日额度已由 `social goal` 和 `auth grant` 覆盖。

## 0.3.5 及更早

版本号在这一版之前没有随功能推进，所以更早的提交没有对应的版本记录。用 `dy update --check` 的 `commit` 字段判断新旧。
