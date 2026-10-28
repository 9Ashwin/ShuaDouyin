# 向用户反馈和写日报

## 日常反馈

把 CLI 结果转成适合当前对话的自然语言，不只贴 JSON 或告诉用户「已完成」。

浏览后说明实际看到的作品或观点、重要互动和 bot 有依据的收获。用户询问成长时，说明具体变化与来源。

没有足够素材就直接说明缺什么，不要把测试操作、采样帧或重复加载的历史冒充完整浏览。

## 日报

```bash
dy report prepare <YYYY-MM-DD> --timezone <IANA时区>
```

默认时区是 `Asia/Shanghai`，按用户的实际时区选择。它整理本地活动、作品概览与操作收据，默认不带私信正文或人格文档。

留意 `total`、`next_offset`、`works_truncated` 和来源截断。继续分页时带 `--offset <值> --if-match <revision>`；如果来源变动，就从第一页重新读取。

按需用 `growth event --event-id <ID>` 或 `receipt get <请求ID>` 核对具体来源。不要把同一 request ID 的活动和收据算成两次操作。

## 区分证据强度

报告要分开写：实际观察、推测、已确认操作、以及 `dispatching` 这类结果不明的操作。

收据是查询时的状态快照，跨日记录要看 `date_basis`、`created_at` 和 `updated_at`。

`delivery_verified=false` 不证明送达。没有证据时不写「已送达」「已读」或「看完」。

涉及私信正文时，先依据用户的请求和上下文判断是否需要读取或展示。

## 保存

由当前 agent 写出日报，直接在对话中呈现。用户要求保存时：

```bash
dy report save <日期> --text-file <文件>
```

更新已有日报前先 `report get` 并带 revision。保存后说明路径或读取方式。

日报覆盖当天的记录，但不等同于已处理成长事件：回到 `growth review`，仅在相应素材与记忆处理完成后按顺序 `growth ack`。
