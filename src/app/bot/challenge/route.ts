import { NextRequest, NextResponse } from "next/server";

/* /bot/challenge 独立验证页：原生重写为自包含 HTML（2026-11-10 张老师：
   「挺废流量的…大头 css 和 JS 压缩精简…必要时可以原生重写」）。
   旧版走 Next page＝背全站 React 外壳 + 全站 globals.css（过 WAF 后实测
   ~250KB/14 请求）；本版 route handler 直吐单文件：inline 精简 CSS +
   原生 JS + inline SVG 贴图，零外链请求。验证 API（/api/bot/challenge
   POST 开局 / PUT 走子）与 cookie 语义一行不动，体验对齐旧版弹窗：
   8×8 预生成盘（10 雷/3BV<4，初始已开 opening）、左键开格、右键/长按
   插旗、已开格双击 chord、换一局、踩雷重开、通关后跳 next。贴图路径
   1:1 取自 FlopSprites（GPL-3.0，与站内既有使用同源），只内联挑战盘
   需要的 symbol。 */

function page(next: string): string {
  /* SVG symbol 集（viewBox 0 0 168 168）：cell-normal 未开 / cell-press 凹面 /
     cell-number-1..8 / cell-flag-solid 旗 / face-flat·face-lose·face-win 笑脸三态。
     逐字节取自 src/components/FlopSprites.tsx（含 -solid 垫底扩展），勿手改。 */
  const svg = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<symbol id="cell-press" viewBox="0 0 168 168"><path d="M0 0v167.89h10V10h157.89V0H0z" fill="gray"/><path d="M10 10v150h150V10H10z" fill="silver"/></symbol>
<symbol id="cell-number-0" viewBox="0 0 168 168"><use href="#cell-press"/></symbol>
<symbol id="cell-number-1" viewBox="0 0 168 168"><use href="#cell-press"/><path d="M80 30v10H70v10H60v10H50v10h20v40H50v20h70v-20h-20V30H80z" fill="#00f"/></symbol>
<symbol id="cell-number-2" viewBox="0 0 168 168"><use href="#cell-press"/><path d="M40 30v10H30v20h30V50h40v20H80v10H60v10H40v10H30v30h100v-20H70v-10h20V90h20V80h10V70h10V40h-10V30H40z" fill="green"/></symbol>
<symbol id="cell-number-3" viewBox="0 0 168 168"><use href="#cell-press"/><path d="M30 30v20h70v20H60v20h40v20H30v20h90v-10h10V90h-10V70h10V40h-10V30H30z" fill="red"/></symbol>
<symbol id="cell-number-4" viewBox="0 0 168 168"><use href="#cell-press"/><path d="M50 30v20H40v20H30v20h60v40h30V90h10V70h-10V30H90v40H70V50h10V30H50z" fill="navy"/></symbol>
<symbol id="cell-number-5" viewBox="0 0 168 168"><use href="#cell-press"/><path d="M30 30v60h70v20H30v20h90v-10h10V80h-10V70H60V50h70V30H30z" fill="maroon"/></symbol>
<symbol id="cell-number-6" viewBox="0 0 168 168"><use href="#cell-press"/><path d="M40 30v10H30v80h10v10h80v-10h10V80h-10V70H60V50h60V30H40z" fill="teal"/><path d="M60 90v20h40V90H60z" fill="silver"/></symbol>
<symbol id="cell-number-7" viewBox="0 0 168 168"><use href="#cell-press"/><path d="M30 30v20h70v20H90v20H80v20H70v20h30v-20h10V90h10V70h10V30H30z"/></symbol>
<symbol id="cell-number-8" viewBox="0 0 168 168"><use href="#cell-press"/><path d="M40 30v10H30v30h10v20H30v30h10v10h80v-10h10V90h-10V70h10V40h-10V30H40z" fill="gray"/><path d="M60 50v20h40V50H60m0 40v20h40V90H60z" fill="silver"/></symbol>
<symbol id="cell-normal" viewBox="0 0 168 168"><path d="M0 0v150h10v-10h10V20h120V10h10V0H0z" fill="white"/><path d="M150 0v10h-10v10H20v120H10v10H0v10h10v-10h10v-10h120V20h10V10h10V0h-10z" fill="silver"/><path d="M150 10v10h-10v120H20v10H10v17.89h157.89V10h-10z" fill="gray"/></symbol>
<symbol id="cell-flag-solid" viewBox="0 0 168 168"><use href="#cell-press"/><use href="#cell-normal"/><path d="M70 30v10H50v10H40v10h10v10h20v10h20V30H70z" fill="red"/><path d="M80 80v20H60v10H40v20h80v-20h-20v-10H90V80H80z"/></symbol>
<symbol id="cell-mine-bomb" viewBox="0 0 168 168"><path d="M0 0v167.89h10V10h157.89V0H0z" fill="gray"/><path d="M10 10v150h150V10H10z" fill="red"/><path d="M80 20v20H60v10H50V40H40v10h10v10H40v20H20v10h20v20h10v10H40v10h10v-10h10v10h20v20h10v-20h20v-10h10v10h10v-10h-10v-10h10V90h20V80h-20V60h-10V50h10V40h-10v10h-10V40H90V20H80z"/><path d="M60 60v20h20V60H60z" fill="white"/></symbol>
<symbol id="face-flat" viewBox="40 40 180 180"><path d="M110 50v10H90v10H80v10H70v10H60v20H50v50h10v20h10v10h10v10h10v10h20v10h50v-10h20v-10h10v-10h10v-10h10v-20h10v-50h-10V90h-10V80h-10V70h-10V60h-20V50h-50z"/><path d="M110 60v10H90v10H80v10H70v20H60v50h10v20h10v10h10v10h20v10h50v-10h20v-10h10v-10h10v-20h10v-50h-10V90h-10V80h-10V70h-20V60h-50z" fill="#ff0"/><path d="M100 100v20h20v-20h-20m50 0v20h20v-20h-20m-60 50v10h10v10h10v10h50v-10h10v-10h10v-10h-10v10h-10v10h-50v-10h-10v-10H90z"/></symbol>
<symbol id="face-lose" viewBox="0 0 260 260"><path d="M0 0v250h10v10h250V10h-10V0H0z" fill="gray"/><path d="M250 0v10h10V0h-10z" fill="silver"/><path d="M10 10v230h10v-10h10V30h200V20h10V10H10z" fill="white"/><path d="M240 10v10h10V10h-10m-10 10v10h10V20h-10M30 30v200h200V30H30z" fill="silver"/><path d="M110 50v10H90v10H80v10H70v10H60v20H50v50h10v20h10v10h10v10h10v10h20v10h50v-10h20v-10h10v-10h10v-10h10v-20h10v-50h-10V90h-10V80h-10V70h-10V60h-20V50h-50z"/><path d="M110 60v10H90v10H80v10H70v20H60v50h10v20h10v10h10v10h20v10h50v-10h20v-10h10v-10h10v-20h10v-50h-10V90h-10V80h-10V70h-20V60h-50z" fill="#ff0"/><path d="M90 90v10h10v10H90v10h10v-10h10v10h10v-10h-10v-10h10V90h-10v10h-10v-10H90m60 0v10h10v10h-10v10h10v-10h10v10h10v-10h-10v-10h10V90h-10v10h-10v-10h-10m-40 60v10h-10v10H90v10h10v-10h10v-10h10v-10h50v10h10v10h10v-10h-10v-10h-10v-10h-50z"/><path d="M20 230v10h10v-10H20m-10 10v10h10v-10H10M0 250v10h10v-10H0z" fill="silver"/></symbol>
<symbol id="face-win" viewBox="0 0 260 260"><path d="M0 0v250h10v10h250V10h-10V0H0z" fill="gray"/><path d="M250 0v10h10V0h-10z" fill="silver"/><path d="M10 10v230h10v-10h10V30h200V20h10V10H10z" fill="white"/><path d="M240 10v10h10V10h-10m-10 10v10h10V20h-10M30 30v200h200V30H30z" fill="silver"/><path d="M110 50v10H90v10H80v10H70v10H60v20H50v50h10v20h10v10h10v10h10v10h20v10h50v-10h20v-10h10v-10h10v-10h10v-20h10v-50h-10V90h-10V80h-10V70h-10V60h-20V50h-50z"/><path d="M110 60v10H90v10H80v10H70v20H60v20h10v10H60v20h10v20h10v10h10v10h20v10h50v-10h20v-10h10v-10h10v-20h10v-20h-10v-10h10v-20h-10V90h-10V80h-10V70h-20V60h-50z" fill="#ff0"/><path d="M90 100v10H80v10H70v10h10v-10h10v10h10v10h20v-10h10v-20h10v20h10v10h20v-10h10v-10h10v10h10v-10h-10v-10h-10v-10H90z"/><path d="M90 130v10h10v-10H90m80 0v10h10v-10h-10z" fill="olive"/><path d="M100 160v10h10v10h50v-10h10v-10h-10v10h-50v-10h-10z"/><path d="M20 230v10h10v-10H20m-10 10v10h10v-10H10M0 250v10h10v-10H0z" fill="silver"/></symbol>
</svg>`;

  const css = `*{margin:0;padding:0;box-sizing:border-box}html,body{height:100%}
body{background:#11150f;font-family:"微软雅黑",Arial,"宋体";color:#d8d8cc;display:flex;align-items:center;justify-content:center;padding:16px}
.modal{position:relative;width:340px;max-width:100%;padding:22px 20px 18px;border:1px solid #6a6858;border-radius:10px;background:#2b2a24;text-align:center}
.modal h1{margin:0 24px 8px;color:#f0f0e6;font-size:18px;font-weight:500}
.face{display:flex;align-items:center;justify-content:center;gap:10px;width:222px;margin:0 auto 14px;padding:8px 0;background:silver;border:3px solid;border-color:#fff #7b7b7b #7b7b7b #fff;border-radius:0;color:#333;font-size:16px;font-weight:bold;cursor:pointer}
.face:hover{color:#000;background:#8ac21b linear-gradient(to bottom,#8ac21b,#6da116);border-color:#c4e88a #55801a #55801a #c4e88a}
.face:active{border-color:#55801a #c4e88a #c4e88a #55801a}
.face:disabled{cursor:default}
.face svg{flex:none}
.board{position:relative;width:max-content;margin:0 auto 14px;border:1px #49483e solid;border-top-color:#7f7f7f;border-left-color:#7f7f7f;border-right-color:#fff;border-bottom-color:#fff;border-width:2px;zoom:1.5;touch-action:manipulation;user-select:none;-webkit-user-select:none;background:#808080}
.board table{border-collapse:collapse}
.board td{width:16px;height:16px;padding:0;background:none;cursor:default}
.board .vec{display:block;position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
.board.won{outline:2px solid #639922}
.board.lost{outline:2px solid #a32d2d}
.status{color:#aaa99a;font-size:13px}
.error{color:#ff9b8f;font-size:13px}
.note{margin:0;color:#8f8e82;font-size:12px;line-height:1.7;text-align:center}
.note a{color:#a6e22e;text-decoration:none}
.note a:hover{color:#fdc61a}
.gold{color:#fdc61a}
.win{position:fixed;left:0;right:0;top:18%;text-align:center;color:#639922;font-size:30px;font-weight:bold;text-shadow:0 2px 6px rgba(0,0,0,.6);z-index:9}
@media(max-width:380px){.modal{padding-left:12px;padding-right:12px}}`;

  const js = `(function(){
"use strict";
var NEXT=${JSON.stringify(next)};
var boardEl=document.getElementById("board"),faceEl=document.getElementById("face"),faceSym=document.getElementById("faceSym"),
statusEl=document.getElementById("status"),errEl=document.getElementById("err"),winEl=document.getElementById("win"),
vec=document.getElementById("vec");
var token="",busy=false,B=null,longT=null,suppress=false,mineCell=-1,pressed={};
function sym(i){if(i===mineCell)return "#cell-mine-bomb";var c=B.cells[i];if(c.state===1)return "#cell-number-"+(c.num||0);if(c.state===2)return "#cell-flag-solid";return pressed[i]?"#cell-number-0":"#cell-normal"}
function render(){if(!B)return;var w=B.width,h=B.height,s="";
for(var y=0;y<h;y++){s+="<tr>";for(var x=0;x<w;x++){var i=y*w+x;
s+='<td aria-label="'+(y+1)+" 行 "+(x+1)+' 列" data-i="'+i+'"></td>'}s+="</tr>"}
boardEl.getElementsByTagName("tbody")[0].innerHTML=s;
var v='<rect x="0" y="0" width="100%" height="100%" fill="#808080"/>';for(var j=0;j<B.cells.length;j++)v+='<use data-i="'+j+'" href="'+sym(j)+'" x="'+(j%w)*16+'" y="'+((j/w)|0)*16+'" width="16" height="16"/>';
vec.setAttribute("viewBox","0 0 "+w*16+" "+h*16);
vec.innerHTML=v;
statusEl.style.display="none";
boardEl.classList.toggle("won",!!B.won);boardEl.classList.toggle("lost",!!B.lost);
faceSym.setAttribute("href",B.won?"#face-win":B.lost?"#face-lose":"#face-flat");
faceEl.style.width=(w*16+4)*1.5+"px"}
function repaint(){if(!B)return;var u=vec.getElementsByTagName("use");
for(var j=0;j<u.length;j++)u[j].setAttribute("href",sym(+u[j].dataset.i))}
function showErr(m){errEl.textContent=m||""}
/* 增量协议 v2（2026-11-10）：走子请求带 base（当前 64 格状态串），响应优先
   diff 形态；apply 兼容全量回落。省流量：每步 2.4KB → ~1.1KB。 */
function states(){var s="";for(var k=0;k<B.cells.length;k++)s+=B.cells[k].state;return s}
function apply(d){if(d.cells){B=d;return}
for(var k=0;k<d.diff.length;k++){var c=d.diff[k];B.cells[c.i]={state:c.s,num:c.n}}
B.won=d.won;B.lost=d.lost;B.moves=d.moves}
async function load(){busy=true;faceEl.disabled=true;showErr("");
try{var r=await fetch("/api/bot/challenge",{method:"POST",cache:"no-store"});
if(!r.ok)throw 0;var d=await r.json();token=d.token;B=d;mineCell=-1;render()}catch(e){showErr("开局失败，请重试")}finally{busy=false;faceEl.disabled=false}}async function act(a,i){if(!B||busy||B.won||B.lost)return;busy=true;showErr("");
try{var r=await fetch("/api/bot/challenge",{method:"PUT",headers:{"Content-Type":"application/json"},
body:JSON.stringify({token:token,action:a,cell:i,base:states()}),cache:"no-store"});
if(r.status===410){await load();return}
if(!r.ok)throw 0;var d=await r.json();token=d.token;apply(d);mineCell=typeof d.mineCell==="number"?d.mineCell:-1;render();
if(B.won){winEl.style.display="block";setTimeout(function(){location.replace(NEXT)},650)}}catch(e){showErr("操作失败，请重试")}finally{busy=false}}
boardEl.addEventListener("click",function(e){var t=e.target.closest("td");if(!t)return;
if(suppress){suppress=false;return}
var i=+t.dataset.i;if(B.cells[i].state===1)act("chord",i);else act("open",i)});
boardEl.addEventListener("contextmenu",function(e){e.preventDefault();var t=e.target.closest("td");if(t)act("flag",+t.dataset.i)});
/* 按压预览 + 拖拽跟踪（2026-11-10 张老师）：左键按住未开格＝单格下沉；
   按住已开数字格＝chord 预览（周围未开未插旗格下沉）。按住期间在数字格间
   移动光标，按压区域随落点重算（落点不是数字格则全部释放，经典扫雷口径）。 */
var drag=false;
function chordSet(i){var s={},w=B.width,x=i%w,y=(i/w)|0;
for(var dy=-1;dy<=1;dy++)for(var dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;
var nx=x+dx,ny=y+dy;if(nx<0||nx>=w||ny<0||ny>=B.height)continue;
var j=ny*w+nx;if(B.cells[j].state===0)s[j]=1}
return s}
function applyPress(p){var same=true,ka=Object.keys(pressed),kp=Object.keys(p);
if(ka.length!==kp.length)same=false;else for(var k=0;k<ka.length;k++)if(!p[ka[k]]){same=false;break}
if(same)return;pressed=p;repaint()}
boardEl.addEventListener("mousedown",function(e){if(e.button!==0)return;var t=e.target.closest("td");if(!t)return;var i=+t.dataset.i;
if(!B||B.won||B.lost||busy)return;
if(B.cells[i].state===0){drag=false;var p={};p[i]=1;applyPress(p);return}
if(B.cells[i].state===1){drag=true;applyPress(chordSet(i))}});
document.addEventListener("mousemove",function(e){if(!drag||!B)return;
var t=document.elementFromPoint(e.clientX,e.clientY);
var td=t&&t.closest?t.closest("#board td"):null;
if(!td){applyPress({});return}
var i=+td.dataset.i;
applyPress(B.cells[i].state===1?chordSet(i):{})});
document.addEventListener("mouseup",function(){drag=false;if(Object.keys(pressed).length){pressed={};repaint()}});
boardEl.addEventListener("touchstart",function(e){var t=e.target.closest("td");if(!t)return;var i=+t.dataset.i;
longT=setTimeout(function(){suppress=true;act("flag",i)},480)},{passive:true});
boardEl.addEventListener("touchend",function(){if(longT){clearTimeout(longT);longT=null}});
boardEl.addEventListener("touchcancel",function(){if(longT){clearTimeout(longT);longT=null}});
faceEl.addEventListener("click",load);
load()})();`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/images/favicon-mini.ico" sizes="16x16 32x32">
<title>扫雷验证 | 扫雷网 Saolei.wang</title>
<meta name="robots" content="noindex,nofollow">
<style>${css}</style>
</head>
<body>
${svg}
<div class="win" id="win" style="display:none">验证成功</div>
<section class="modal" role="dialog" aria-modal="true" aria-labelledby="t">
<h1 id="t">扫盘初级，证明你是真人</h1>
<button type="button" class="face" id="face" style="width:222px">
<svg viewBox="0 0 260 260" width="24" height="24" aria-hidden="true"><use id="faceSym" href="#face-flat"/></svg>
<span id="btnText">换一局</span>
</button>
<div class="board" id="board">
<table cellPadding="0" cellSpacing="0"><tbody></tbody></table>
<svg class="vec" id="vec" viewBox="0 0 128 128" preserveAspectRatio="none" aria-hidden="true"></svg>
</div>
<p class="status" id="status">正在取一张预生成盘面…</p>
<p class="error" id="err"></p>
<p class="note">完成后<span class="gold"> 2 </span>小时免验证，<a href="/account/login">登录</a>后不再出现此提示</p>
</section>
<script>${js}</script>
</body>
</html>`;
}

export async function GET(req: NextRequest) {
  /* next 只收站内相对地址（与旧版 page.tsx 同口径），防开放跳转 */
  const raw = req.nextUrl.searchParams.get("next") ?? "/video";
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/video";
  return new NextResponse(page(next), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
