export const fixture = `<!doctype html>
<html><head><meta charset="utf-8"><title>Isolated Douyin fixture</title>
<style>body{font:16px sans-serif;margin:20px}video{display:block;width:300px;height:120px;background:#333}button{padding:8px;margin:4px}textarea{width:350px;height:50px}[contenteditable]{border:1px solid;width:350px;min-height:30px}[data-e2e="comment-item"]{padding:4px}#im{position:fixed;inset:0;background:white;padding:20px}#slides img{display:block;width:120px;height:80px;background:#888}</style></head><body>
<div class="tab-user_self"><a href="/user/self_123">我的</a></div>
<section id="player" data-e2e="feed-active-video" data-video-id="12345">
<div data-e2e="player-container" class="video_12345"><video muted></video></div>
<span data-e2e="video-desc">Fixture video</span><a href="/user/author_123">测试作者</a>
<!-- The live page no longer sets aria-pressed on these; it states the state in
     a marker. Both spellings end the same way, so a suffix match called an
     unliked work liked. This fixture keeps that shape. -->
<div data-e2e="video-player-digg" data-e2e-state="video-player-no-digged">点赞</div>
<button data-e2e="video-player-collect" aria-pressed="false">收藏</button>
<button data-e2e="video-player-comment">评论</button>
</section>
<!-- The feed arrows live beside the slides, not inside one, so they stay
     clickable on a live slide the way they do on the real page. -->
<button data-e2e="video-switch-next-arrow">下一条</button><button data-e2e="video-switch-prev-arrow">上一条</button>
<!-- The recommended feed also serves live streams. A live slide has its own
     element, no work id, and its only stable identity is the host's account. -->
<section id="live" data-e2e="feed-live" style="display:none">
<a id="live-link" href="/user/live_host_one"><span id="live-title">直播中</span></a>
</section>
<div data-e2e="comment-list" style="max-height:160px;overflow:auto">
<div data-e2e="comment-item" data-comment-id="10001"><a data-e2e="comment-author" href="/user/guest_456">路人</a><span data-e2e="comment-content">原始评论</span><button data-e2e="comment-reply">回复</button></div>
<!-- The live page carries no comment-content attribute and uses per-build
     wrapper classes, so this row mirrors that shape: id only from tooltip_,
     author inside an ALink, body as plain spans with a timestamp and a count. -->
<div data-e2e="comment-item"><div><span id="tooltip_10002"></span></div><div><a class="ALink-a" href="/user/author_456"><span>真实作者</span></a><span class="x9">这是没有标记属性的评论正文</span><span>3小时前·浙江</span><span>12</span><span>回复</span></div></div>
<!-- A voice comment carries a player and, when the platform made one, its own
     transcript. With no text and no image it used to be dropped from the list.
     The second one has a transcript, the first does not. -->
<div data-e2e="comment-item"><span id="tooltip_10005"></span><a class="ALink-a" href="/user/author_voice"><span>语音作者</span></a><div data-e2e="comment-voice" class="commentVoiceItem"><span>3''</span></div><span>5分钟前·北京</span><span>回复</span></div>
<div data-e2e="comment-item"><span id="tooltip_10006"></span><a class="ALink-a" href="/user/author_voice"><span>语音作者</span></a><div data-e2e="comment-voice" class="commentVoiceItem"><span>12''</span><span data-e2e="voice-transcript">这段我觉得很有味道</span></div><span>1天前·北京</span><span>回复</span></div>
<!-- Two shapes the live page produces that used to read wrong. The body holds
     an inline emoji as an <img alt>, which made it non-childless and so
     invisible to the body picker; the row's only remaining text was its
     timestamp. The second row's body is the single "1周前" string. -->
<div data-e2e="comment-item"><div><span id="tooltip_10004"></span></div><div><a class="ALink-a" href="/user/author_789"><span>第三作者</span></a><span class="x9"><span><span><span>夏天会收尾，青春和歌声不会<img draggable="false" alt="✨" src="//p-pc-weboff.byteimg.com/tos-cn-i-9r5gewecjs/twemoji/72x72/2728.png"></span></span></span></span><span>1周前·广东</span><span>7</span><span>回复</span></div></div>
</div>
<div class="comment-input-container" data-e2e="comment-composer"><textarea data-e2e="comment-input"></textarea><input type="file" data-e2e="comment-image-input" accept=".png,.jpg"><button data-e2e="comment-post">发布</button></div>
<div data-e2e="video-share-icon-container"><span class="s7K4YLGp">分享</span></div>
<div id="share" data-e2e="video-share-container" style="display:none">
<div class="row"><span>好友一</span><div class="send" data-userid="30001">分享</div></div>
<div class="row"><span>好友二</span><div class="send" data-userid="30002">分享</div></div>
<div class="row"><span>群一</span><span>12</span><div class="send" data-userid="30003">分享</div></div>
</div>
<button data-e2e="im-entry">私信</button>
<div id="im" data-e2e="im-dialog" style="display:none">
<div data-e2e="conversation-item" data-conversation-id="30001" data-conversation-type="direct"><span data-e2e="conversation-name">好友一</span></div>
<div data-e2e="chat-page" data-conversation-id="30001">
<div data-e2e="chat-header" data-conversation-id="30001" data-conversation-type="direct"><span data-e2e="chat-title">好友一</span><button data-e2e="im-close">关闭</button></div>
<div data-e2e="message-list"><div data-e2e="message-row" data-message-id="30001" data-direction="incoming"><div data-e2e="message-content"><span data-e2e="message-text">你好</span></div></div></div>
<div data-e2e="msg-input"><div contenteditable="true"></div><div class="MsgInputFileUploadim-saas-fileUploader"><input type="file" class="semi-upload-hidden-input" multiple accept=".png,.jpg,.gif"><button>图片</button></div><svg class="messageMsgInputiconAction" width="32" height="32" viewBox="0 0 32 32"><path d="M16 4a12 12 0 1 0 0 24 12 12 0 0 0 0-24"/></svg></div><button data-e2e="send-msg-btn">发送</button>
</div></div>
<div data-e2e="search-card" style="display:none"><a href="/video/12345">搜索结果甲</a></div>
<div data-e2e="search-card" style="display:none"><a href="/video/67890">搜索结果乙</a></div>
<div id="user-results" style="display:none">
<div data-e2e="user-card"><a href="/user/MS4wLjABAAAAauthor01">旅行作者甲</a><span data-e2e="user-signature">分享旅途</span></div>
<div data-e2e="user-card"><a href="/user/MS4wLjABAAAAauthor02">旅行作者乙</a><span data-e2e="user-signature">在路上</span></div>
<div data-e2e="user-card"><a href="/user/MS4wLjABAAAAauthor01">旅行作者甲</a></div>
<div data-e2e="user-card"><a href="/user/self_123">我自己</a></div>
</div>
<section data-e2e="user-info" style="display:none"><h1 data-e2e="user-title">作者</h1><span data-e2e="user-signature">简介</span><button data-e2e="follow-button">关注</button></section>
<section id="note" data-e2e="note-detail" style="display:none">
<span data-e2e="note-desc">Fixture image post</span><a href="/user/author_123">测试作者</a>
<button data-e2e="note-digg" aria-pressed="false" data-e2e-state="note-no-digged">点赞</button>
<button data-e2e="note-collect" aria-pressed="false" data-e2e-state="note-no-collect">收藏</button>
<button data-e2e="video-player-comment">评论</button>
<div class="swiper-pagination"><span class="bullet active">1</span><span class="bullet">2</span></div>
<div data-e2e="note-slide-controls"><button data-e2e="note-previous">上一张</button><div><span id="note-index">1</span><span>/</span><span>2</span></div><button data-e2e="note-next">下一张</button></div>
<div id="slides"><img alt="图一" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='80'%3E%3C/svg%3E"><img alt="图二" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='80'%3E%3C/svg%3E"></div>
</section>
<script>
window.sends=0; window.commentSends=0;
const q=s=>document.querySelector(s),qa=s=>[...document.querySelectorAll(s)];
const route=/^\\/video\\/(\\d+)/.exec(location.pathname);
// Work ID 70001 is an image post upstream; Douyin answers /video/<id> with a
// redirect to /note/<id>, so the fixture does the same.
const NOTE_IDS=new Set(['70001']);
function setVideo(id){q('#player').setAttribute('data-video-id',id);q('[data-e2e="player-container"]').className='video_'+id;history.replaceState({},'', '/video/'+id);}
if(route&&NOTE_IDS.has(route[1]))history.replaceState({},'', '/note/'+route[1]);
else if(route){setLive(null);setVideo(route[1]);}
if(location.pathname.startsWith('/search/')){
q('#player').style.display='none';
if(new URL(location.href).searchParams.get('type')==='user')q('#user-results').style.display='block';
else qa('[data-e2e="search-card"]').forEach(e=>e.style.display='block');
const host=document.createElement('div');host.id='search-filter-fixture';
const label=document.createElement('span');label.textContent='筛选';host.append(label);
const panel=document.createElement('div');panel.style.display='none';host.append(panel);label.onclick=()=>{panel.style.display=panel.style.display==='none'?'block':'none'};
const groups=[['排序依据','综合排序','最新发布','最多点赞'],['发布时间','不限','一天内','一周内','半年内'],['视频时长','不限','1分钟以下','1-5分钟','5分钟以上'],['搜索范围','不限','关注的人','最近看过','还未看过'],['内容形式','不限','视频','图文']];
groups.forEach((group,g)=>{const row=document.createElement('div');const title=document.createElement('div');title.textContent=group[0];row.append(title);group.slice(1).forEach((text,i)=>{const option=document.createElement('span');option.dataset.index1=String(g);option.dataset.index2=String(i);option.className='filter-option'+(i===0?' sDNqBVWH':'');option.textContent=text;option.style.display='inline-block';option.style.padding='5px';option.onclick=()=>{row.querySelectorAll('[data-index1]').forEach(x=>x.classList.remove('sDNqBVWH'));option.classList.add('sDNqBVWH')};row.append(option)});panel.append(row)});document.body.prepend(host);
}
if(location.pathname.startsWith('/user/')){q('#player').style.display='none';q('[data-e2e="user-info"]').style.display='block';}
// An image post hides the player and shows the note surface instead.
const note=/^\\/note\\/(\\d+)/.exec(location.pathname);
if(note){q('#player').style.display='none';q('#note').style.display='block';q('#note').dataset.noteId=note[1];}
for(const [selector,delta] of [['note-previous',-1],['note-next',1]])q('[data-e2e="'+selector+'"]').onclick=()=>{const el=q('#note-index');const index=Math.max(1,Math.min(2,Number(el.textContent)+delta));el.textContent=String(index);qa('#note .bullet').forEach((bullet,i)=>bullet.classList.toggle('active',i===index-1));};
function setLive(host){q('#player').style.display=host?'none':'block';q('#live').style.display=host?'block':'none';if(host)q('#live-link').setAttribute('href','/user/'+host);q('[data-e2e="video-switch-next-arrow"]').dataset.live=host?'1':'';}
q('[data-e2e="video-switch-next-arrow"]').onclick=()=>{
// A live slide swallows the first press, exactly as the real player does: the
// overlay claims the click and the feed only advances on the next one.
if(q('[data-e2e="video-switch-next-arrow"]').dataset.live){window.livePressIgnored=(window.livePressIgnored||0)+1;if(window.livePressIgnored===1)return;setLive(null);window.livePressIgnored=0;setVideo('67890');return;}
// A normal slide can also swallow one press: the click lands while the player is
// still settling and nothing moves. That is the case the retry exists for, and
// it must only fire when the page is provably still on the work it started from.
if(window.swallowOnce){window.swallowOnce=false;window.swallowed=(window.swallowed||0)+1;return;}
if(q('#player').getAttribute('data-video-id')==='67890'){setLive('live_host_two');return;}setLive(null);setVideo('67890');};
q('[data-e2e="video-switch-prev-arrow"]').onclick=()=>{setLive(null);setVideo('12345');};
for(const s of ['video-player-digg','video-player-collect','note-digg','note-collect'])q('[data-e2e="'+s+'"]').onclick=e=>{const b=e.currentTarget;
// Mirror the live page: toggle the marker between no-<action> and is-<action>,
// and keep aria-pressed in step for the note controls that still use it.
const kind=s.includes('digg')?'digged':'collect';
const on=(b.getAttribute('data-e2e-state')||'').endsWith('-is-'+kind);
b.setAttribute('data-e2e-state',(s.includes('note')?'note-':'video-player-')+(on?'no-'+kind:'is-'+kind));
b.setAttribute('aria-pressed',on?'false':'true');};
q('[data-e2e="comment-reply"]').onclick=()=>q('[data-e2e="comment-composer"]').setAttribute('data-reply-comment-id','10001');
window.commentImageUploads=0;window.commentImagePosts=0;q('[data-e2e="comment-image-input"]').onchange=e=>{if(!e.target.files.length)return;window.commentImageUploads++;const reader=new FileReader();reader.onload=()=>{const img=document.createElement('img');img.id='comment-image-preview-fixture';img.width=40;img.height=40;img.src=reader.result;q('[data-e2e="comment-composer"]').append(img)};reader.readAsDataURL(e.target.files[0])};
q('[data-e2e="comment-post"]').onclick=()=>{
const editor=q('textarea'),text=editor.value,preview=q('#comment-image-preview-fixture');if(!text&&!preview)return;if(preview){window.commentImagePosts++;preview.remove();q('[data-e2e="comment-image-input"]').value='';return;}window.commentSends++;
const row=document.createElement('div');row.setAttribute('data-e2e','comment-item');row.setAttribute('data-comment-id',String(20000+window.commentSends));row.setAttribute('data-is-self','true');row.setAttribute('data-send-status','sent');
const parent=q('[data-e2e="comment-composer"]').getAttribute('data-reply-comment-id');if(parent)row.setAttribute('data-parent-comment-id',parent);
const content=document.createElement('span');content.setAttribute('data-e2e','comment-content');content.textContent=text;row.append(content);q('[data-e2e="comment-list"]').append(row);editor.value='';
// Posting ends the reply state, so the next composer starts unbound.
q('[data-e2e="comment-composer"]').removeAttribute('data-reply-comment-id');};
q('[data-e2e="im-entry"]').onclick=()=>q('#im').style.display='block';
window.imageUploads=0;window.imageSends=0;q('input.semi-upload-hidden-input').onchange=e=>{if(!e.target.files.length)return;window.imageUploads++;const file=e.target.files[0],reader=new FileReader();reader.onload=()=>{const modal=document.createElement('div');modal.setAttribute('role','dialog');modal.style.cssText='position:fixed;top:100px;left:100px;background:white;z-index:9999;padding:20px';modal.innerHTML='<div class="MsgInputSendFileModalbox"><div class="MsgInputSendFileModalreceiver">发送给 好友一</div><img class="MsgInputSendFileModalitemIconInner"><div class="MsgInputSendFileModalitemContentTitle"></div><textarea></textarea><button class="MsgInputSendFileModalbtnSure">发送</button></div>';modal.querySelector('img').src=reader.result;modal.querySelector('.MsgInputSendFileModalitemContentTitle').textContent=file.name;modal.querySelector('button').onclick=()=>{window.imageSends++;modal.remove()};for(const el of [modal.querySelector('.MsgInputSendFileModalbox'),modal.querySelector('button')])Object.defineProperty(el,'__reactFiber$fixture',{value:{memoizedProps:{curConversation:{conversationId:'30001'}},return:null}});document.body.append(modal)};reader.readAsDataURL(file);};
q('[data-e2e="send-msg-btn"]').onclick=()=>{
const editor=q('[contenteditable]'),text=editor.innerText;if(!text)return;window.sends++;
const row=document.createElement('div');row.setAttribute('data-e2e','message-row');row.setAttribute('data-direction','outgoing');row.setAttribute('data-message-id',String(40000+window.sends));
const content=document.createElement('div');content.setAttribute('data-e2e','message-content');const span=document.createElement('span');span.setAttribute('data-e2e','message-text');span.textContent=text;content.append(span);row.append(content);q('[data-e2e="message-list"]').append(row);editor.innerText='';};
// The sticker panel is a modal over the composer, as on the live page: the
// smiley opens it, choosing a sticker sends it at once, and a press outside
// closes it. The grid is taller than the panel so a pick has to scroll first.
window.stickerSends=0;
document.addEventListener('click',(event)=>{if(!event.target.closest?.('.messageMsgInputiconAction'))return;
if(document.getElementById('sticker-panel'))return;
const panel=document.createElement('div');panel.id='sticker-panel';panel.className='componentsemojiemojiPanel';
panel.style.cssText='position:fixed;left:20px;top:20px;width:280px;height:90px;background:#222;z-index:9999';
const names=['续火花','比心','在干嘛','开心'];
names.forEach(name=>{const item=document.createElement('div');item.className='emojiEmojiItememojiItem';
item.style.cssText='display:inline-block;width:64px;height:80px';const desc=document.createElement('div');
desc.className='emojiEmojiItememojiItemDesc';desc.textContent=name;item.append(desc);
item.onclick=()=>{window.stickerSends++;const row=document.createElement('div');
row.setAttribute('data-e2e','message-row');row.setAttribute('data-direction','outgoing');
row.setAttribute('data-message-id',String(50000+window.stickerSends));
row.setAttribute('data-sent-at',new Date().toISOString());
const content=document.createElement('div');content.setAttribute('data-e2e','message-content');
const emoji=document.createElement('div');emoji.setAttribute('data-e2e','message-emoji');content.append(emoji);
row.append(content);q('[data-e2e="message-list"]').append(row);panel.remove();};
panel.append(item);});
document.body.append(panel);});
q('[data-e2e="follow-button"]').onclick=e=>e.currentTarget.textContent=e.currentTarget.textContent==='关注'?'已关注':'关注';
// The live share panel carries the recipient's account identity in React props
// (user.sec_uid) next to the send button's numeric data-userid. The fixture
// renders the same shape so the reader is exercised as-is, and records which
// recipient was actually clicked so a wrong-row click cannot pass the test.
const shareAccounts={30001:{uid:'30001',sec_uid:'MS4wLjABAAAAshare01'},30002:{uid:'30002',sec_uid:'MS4wLjABAAAAshare02'},30003:{uid:'30003',sec_uid:'MS4wLjABAAAAshare03'}};
window.forwardTargets=[];
qa('#share .row').forEach((row,index)=>{
const send=row.querySelector('.send');
Object.defineProperty(row,'__reactProps$'+index,{value:{children:{props:{user:shareAccounts[send.getAttribute('data-userid')]}}}});
send.onclick=()=>{
const userid=send.getAttribute('data-userid');
window.forwardSends=(window.forwardSends||0)+1;
window.forwardTargets.push(userid);
const message=document.createElement('div');message.setAttribute('data-e2e','message-row');message.setAttribute('data-direction','outgoing');message.setAttribute('data-message-id',String(50000+window.forwardSends));
const content=document.createElement('div');content.setAttribute('data-e2e','message-content');
const card=document.createElement('div');card.setAttribute('data-e2e','shared-video-card');
const link=document.createElement('a');link.setAttribute('href','/video/'+q('#player').getAttribute('data-video-id'));
const title=document.createElement('span');title.setAttribute('data-e2e','shared-video-title');title.textContent='分享的作品';
card.append(link,title);content.append(card);message.append(content);q('[data-e2e="message-list"]').append(message);
q('#share').style.display='none';};
});
// The live entry is hover-revealed, so mouse-enter opens the panel.
q('[data-e2e="video-share-icon-container"]').onmouseenter=()=>q('#share').style.display='block';
q('[data-e2e="video-share-icon-container"]').onclick=()=>q('#share').style.display='block';
// A direct chat renders its counterpart's sec_uid inside conversation props.
const contactRow=q('[data-e2e="im-dialog"] [data-e2e="conversation-item"]');
Object.defineProperty(contactRow,'__reactProps$0',{value:{children:{props:{conversation:{_toParticipantSecUserId:'MS4wLjABAAAAshare01'}}}}});
// The IM dialog is what chat close removes.
q('[data-e2e="im-close"]').onclick=()=>{q('#im').style.display='none';};
</script></body></html>`;
