# README artwork

Chinese artwork for the project README, generated with the built-in ImageGen
tool on 2026-10-31. Both READMEs use the same files.

| Asset | Purpose |
| --- | --- |
| `shuadouyin-hero.png` | Platform logo, project name and six capability groups |
| `shuadouyin-workflow.png` | Six-panel introduction to the caller-driven workflow |

## Visual contract

- Use the user-provided public Douyin header as the logo and color reference:
  a dark background, white text, and cyan / rose offsets.
- Put `ShuaDouyin` above the smaller Chinese name `刷抖音`.
- Use Chinese labels. Keep `ShuaDouyin`, `dy`, and `AI` where appropriate.
- The unnamed character represents the external agent. It is not a default
  persona or a model bundled with the CLI. Leave persona fields blank.
- Illustrate available capabilities without implying that account writes
  happened during this run. Keep the distinction between sampling and full
  viewing, authorization for interactions, and a receipt before dispatch.
- Use the Douyin mark to identify the platform. Do not copy the reference
  account's verification badge, profile details or engagement counts.
- Do not include real account screenshots, identities, private messages,
  workspace documents or captures.

## Evidence used

A read-only CLI session with `dy 0.4.0` supplied the browsing details:

- `feed sweep --count 4 --steps 8` returned four works and skipped three live
  slides.
- Opening a specific work before `video digest --limit 5` returned four
  sample positions at 00:42, 02:33, 04:24 and 06:15, plus five loaded comments.
  All four captures were visually inspected. The comic uses invented artwork,
  not the captured creator's likeness or comment text.
- `search` returned three works for the example query; `user search`
  returned three loaded profile results. Both are partial DOM samples.
- Local memory health and voice-check commands also ran. No persona or memory
  was changed for this artwork.
- The remaining feature groups were checked against the installed CLI schema
  and the project skill references. No comment, private message, follow,
  reaction or gift was sent. No active live-room behavior was verified.

The two images are feature illustrations, not screenshots or a claim that all
capabilities passed end-to-end validation.

## Final hero prompt

The edit used the previous generated layout as reference 1 and the
user-provided public Douyin header as reference 2. Neither reference image is
included in this directory.

```text
Use case: style-transfer / text-localization.
The user requires Chinese artwork with actual Douyin branding, using their supplied screenshot as the visual reference. Reference image 1 is the existing illustration to redesign. Reference image 2 is ONLY a branding/color reference: use its exact recognizable white musical-note Douyin logo with cyan left-offset and vivid pink/red right-offset, near-black / deep graphite background, white type, and vivid pink/red action accents. Do not reproduce the screenshot, account bio, follower counts, verification badge, buttons, or official-account text. The resulting art introduces an independent open-source tool, not an official account.
Completely replace the former warm ivory paper / retro risograph / yellow palette with a modern, high-contrast Douyin-inspired digital comic aesthetic: near-black #0B0B0F and graphite #161823 backgrounds, crisp white typography, electric cyan #25F4EE and vivid rose red #FE2C55 as the two vivid accents, very restrained chromatic offset edges, short diagonal rhythm marks, crisp cel shading, subtle glow only on key details. No beige, no parchment, no brown cozy room, no yellow labels, no grungy paper. Keep the art clean and premium, not neon overload. All text must be highly legible. All text Chinese except ShuaDouyin, the executable dy, and AI where specified. The generic screen-face agent stays unnamed, without animal features or a fixed personal identity.
Redesign the README hero into a wide landscape illustration, keeping its useful content and six-capability panorama but freely recompose it for strong visual hierarchy in the new style.
Title lockup in upper left: put a large, faithful Douyin musical-note logo from reference 2 immediately to the LEFT of the exact large wordmark "ShuaDouyin". Directly BELOW ShuaDouyin put the exact Chinese name "刷抖音", clearly smaller (about one third the English title height), as a separate subtitle line. Do NOT put 刷抖音 beside ShuaDouyin on the same line. This title hierarchy is critical.
Then below the title lockup, one readable Chinese tagline "让你的智能体，带着人格和记忆使用抖音。". Small understated pill at top right: "开源 · 本地工具".
Illustrated lower portion: on the left, the neutral unnamed white screen-face external agent at a sleek dark laptop labeled "> dy". Show it operating the CLI, not being embedded inside the CLI. The rest is a balanced arrangement of six capability vignettes interconnected with restrained cyan and rose lines. Six exact headings:
"浏览与搜索" — varied short-video cards and search lens;
"评论与互动" — speech bubbles, heart, bookmark and a pen poised over a draft;
"私信与分享" — two abstract profile icons, blank message and image cards;
"直播与弹幕" — generic stage display, live chat bubbles and unopened gift;
"关系与跟进" — linked profile cards and a calendar;
"人格与记忆" — blank profile sliders, notebook and receipt.
These illustrations should feel like sophisticated Douyin-colored feature storytelling, not a screenshot or dashboard. Preserve the wide readable composition; make the headline compelling and the logo clearly recognizable. Bottom exact text "本地工具 / 智能体驱动 / 有来源的记忆".
No English feature labels, cats, named mascot, private text, real people, usernames, real messages, official endorsement badge, or watermarks. Retain factual roles: the agent decides; dy is its local tool.
```

## Final comic prompt

The edit used the previous generated six-panel layout as reference 1 and the
same public header as reference 2.

```text
Use case: style-transfer / text-localization.
The user requires Chinese artwork with actual Douyin branding, using their supplied screenshot as the visual reference. Reference image 1 is the existing illustration to redesign. Reference image 2 is ONLY a branding/color reference: use its exact recognizable white musical-note Douyin logo with cyan left-offset and vivid pink/red right-offset, near-black / deep graphite background, white type, and vivid pink/red action accents. Do not reproduce the screenshot, account bio, follower counts, verification badge, buttons, or official-account text. The resulting art introduces an independent open-source tool, not an official account.
Completely replace the former warm ivory paper / retro risograph / yellow palette with a modern, high-contrast Douyin-inspired digital comic aesthetic: near-black #0B0B0F and graphite #161823 backgrounds, crisp white typography, electric cyan #25F4EE and vivid rose red #FE2C55 as the two vivid accents, very restrained chromatic offset edges, short diagonal rhythm marks, crisp cel shading, subtle glow only on key details. No beige, no parchment, no brown cozy room, no yellow labels, no grungy paper. Keep the art clean and premium, not neon overload. All text must be highly legible. All text Chinese except ShuaDouyin, the executable dy, and AI where specified. The generic screen-face agent stays unnamed, without animal features or a fixed personal identity.
Redesign the existing six-panel feature comic into the new dark Douyin palette. Keep the 3-column by 2-row panel layout, story, generic neutral agent, and room for readable Simplified Chinese. Replace all warm interiors with sleek minimalist charcoal spaces, use thin cyan/red panel accents, white speech bubbles or dark bubbles with white type as appropriate. Keep the comic personable and illustrative.
Header at the top: a faithful Douyin musical-note logo from reference 2 to the left of a title lockup. Exact English wordmark "ShuaDouyin" on top, exact smaller Chinese name "刷抖音" directly underneath, NOT beside it. Across the remaining header area exact Chinese headline "不止刷视频，让你的智能体用上抖音".
Six exact Chinese panel headings with no English:
"01  设定人格"
"02  搜索与浏览"
"03  读作品与评论"
"04  互动与分享"
"05  直播与弹幕"
"06  记忆与关系"
Panel 1: human hand and unnamed agent, three BLANK fields labeled "名字", "语气", "边界", laptop "> dy", speech "先认识你，再开始。".
Panel 2: agent with search lens and abstract varied video cards, search phrase "AI 编程", speech "刷推荐，也能带着问题找。".
Panel 3: exactly FOUR sampled frame thumbnails of an invented generic speaking figure; exact timestamps from left to right "00:42", "02:33", "04:24", "06:15"; exactly FIVE abstract comment bubbles. Evidence label "4 个采样点 · 5 条评论". Speech "采样，不等于看完。". Never copy real creator likeness or content.
Panel 4: two empty draft boxes labeled "公开评论（草稿）" and "私信（草稿）", heart, bookmark and share/image icons. Place a receipt before a send arrow. Receipt heading "操作收据" and small line "先记收据，再执行". Speech "评论、私信、分享，按你的授权。". No successful-send claim.
Panel 5: stylized generic live room, chat bubbles, red "直播中" tag, unopened gift. Small gift tag says "送礼前确认" and "名称 + 价格". Speech "看弹幕，发言；送礼先确认。". No purchase success state.
Panel 6: local files, relationship cards and receipts with labels "记忆", "关系", "收据", speech "记住有来源的事，下次接着聊。".
Footer exact note "功能示意漫画 · 浏览采样来自实测 · 写入动作需授权".
Critical: beautiful sophisticated dark digital comic, consistent Douyin cyan/rose palette, exact Chinese spelling and actual logo, generic configurable identity. No retro paper, warm yellow, English panel subtitles, named bot, private data, copied screenshot, or official verification icon.
```

