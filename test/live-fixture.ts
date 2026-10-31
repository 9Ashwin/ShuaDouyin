// A live room is a different site from the works feed, so it cannot be a route
// inside the main fixture: the readers check the origin, not a path.
//
// The shapes here are the ones the readers were written against and then broke
// on: a wrapper and an inner element carrying the same line, a gift line whose
// text repeats the price twice, a join line with no author separator, and a
// picture that is a canvas with nothing readable in it.
export const liveFixture = (state: "live" | "ended" = "live") => `<!doctype html>
<html><head><meta charset="utf-8"><title>示例主播的抖音直播间</title>
<style>
body{font:16px sans-serif;margin:0}
.canvas-holder{width:640px;height:360px;background:#222;color:#fff}
[class*="webcast-chatroom___item"]{padding:4px;margin:2px 0;background:#f0f0f0;width:300px}
[class*="webcast-chatroom___item-wrapper"]{background:#ddd}
</style></head><body>
<canvas class="canvas-holder" width="640" height="360"></canvas>
<div class="webcast-chatroom___chatroom-header">在线观众 1284</div>
<div class="webcast-chatroom___items">
<!-- A wrapper around the same line. The reader drops anything whose class
     carries item-wrapper, because otherwise one message reads as two rows. -->
<div class="webcast-chatroom___item-wrapper">
<div class="webcast-chatroom___item">观众甲：主播这个走位是怎么练的</div>
</div>
<!-- A gift line: same shape the panel writes, with the price stated twice. -->
<div class="webcast-chatroom___item">观众乙：送出了 人气票 × 1</div>
<!-- A join line has no author separator, so the author is only in the prose. -->
<div class="webcast-chatroom___item">用户8775116667676 来了</div>
<!-- A system line the room renders on its own. -->
<div class="webcast-chatroom___item">系统提示：欢迎来到直播间</div>
<!-- The same line again, as the room repeats it after a reconnect. -->
<div class="webcast-chatroom___item">观众甲：主播这个走位是怎么练的</div>
</div>
<!-- The gift panel: each entry states "<price>钻<name><price>钻赠送". The
     name sits between the two prices, which is the whole reason parseGiftLabel
     exists. -->
<div class="webcast-chatroom___gifts">
<div style="width:120px;height:60px;padding:8px">1钻人气票1钻赠送</div>
<div style="width:120px;height:60px;padding:8px">99钻Thuglife99钻赠送</div>
<div style="width:120px;height:60px;padding:8px">更多查看</div>
</div>
<!-- Slate, not a textarea. The hidden copy is what the real room keeps around;
     the reader skips it by size, so the fixture keeps both. -->
<div data-slate-editor="true" style="width:0;height:0;overflow:hidden"></div>
<div data-slate-editor="true" style="width:360px;height:40px;border:1px solid #999;padding:6px" contenteditable="true"></div>
${state === "ended" ? '<div class="ended">直播已结束</div>' : ""}
<script>
window.liveSays=0;
const editor=document.querySelectorAll('[data-slate-editor="true"]')[1];
// Sending a danmaku appends a row with the signed-in name, which the fixture
// gives a stable shape so a send can be read back.
editor.addEventListener("keydown",(event)=>{
if(event.key!=="Enter")return;
const text=editor.innerText.trim();if(!text)return;
window.liveSays++;
const row=document.createElement("div");
row.className="webcast-chatroom___item";
row.textContent="观众甲："+text;
document.querySelector(".webcast-chatroom___items").append(row);
editor.innerText="";
});
</script></body></html>`;
