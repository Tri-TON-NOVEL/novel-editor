// Scene-graph model and time-indexed compositor. No DOM controls live here.
export let WIDTH=1280,HEIGHT=720; export const FPS=30;
export function setCanvasResolution(w,h){WIDTH=w;HEIGHT=h;}
export const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const id=()=>`n-${crypto.randomUUID?.()||Math.random().toString(36).slice(2)}`;
export function node(type,overrides={}){
  return {id:id(),type,name:{video:'動画',image:'画像',online:'YouTube参照',audio:'音声',text:'テキスト',shape:'図形',cutout:'切り抜き'}[type]||'レイヤー',sourceId:null,
    start:0,duration:5,inPoint:0,speed:1,x:180,y:110,w:660,h:370,baseW:660,baseH:370,rotation:0,opacity:1,visible:true,mute:false,
    text:'新しいテキスト',font:58,color:'#ffffff',mask:null,sourceRect:null,children:[],collapsed:false,
    animation:{enter:'none',enterDuration:.8,emphasis:'none',emphasisAt:1,emphasisDuration:.7,intensity:1,frequency:8,exit:'none',exitDuration:.8},...overrides};
}
export function findNode(nodes,id,parent=null){for(const n of nodes){if(n.id===id)return{node:n,parent,list:nodes};const got=findNode(n.children,id,n);if(got)return got}return null}
export function walk(nodes,fn,depth=0,parent=null){for(const n of nodes){fn(n,depth,parent);walk(n.children,fn,depth+1,n)}}
export function removeNode(nodes,id){for(let i=0;i<nodes.length;i++){if(nodes[i].id===id)return nodes.splice(i,1)[0];const got=removeNode(nodes[i].children,id);if(got)return got}return null}
// Deep copy: pieces, hidden ranges, animation and crop must not be shared with the original.
export function cloneNode(original){const remap=(n)=>({...structuredClone({...n,children:[]}),id:id(),name:n.name+' コピー',children:n.children.map(remap)});return remap(original)}
export function duration(nodes){let max=10;for(const n of nodes)max=Math.max(max,n.start+n.duration);return max}

function applyNode(matrix,n){return matrix.translate(n.x+n.w/2,n.y+n.h/2).rotate(n.rotation).translate(-n.w/2,-n.h/2).scale(n.w/n.baseW,n.h/n.baseH)}
export const matrixForNode=applyNode;
// The entry whose player a video/cutout entry uses: climb while the child is linked to its parent's source time.
const playerKey=e=>e.node.id+'|'+e.sourceId;
function linkedRoot(e){while(e.parent&&e.node.editLinked!==false&&e.node.sourceId===e.parent.node.sourceId&&['video','cutout'].includes(e.node.type)&&['video','cutout'].includes(e.parent.node.type))e=e.parent;return e}
function animationAt(n,time){const cfg=n.animation||{},ease=p=>1-Math.pow(1-clamp(p,0,1),3);
  const entering=cfg.enter&&cfg.enter!=='none'&&time<Math.max(.1,cfg.enterDuration||.8);
  const leaving=cfg.exit&&cfg.exit!=='none'&&n.duration-time<Math.max(.1,cfg.exitDuration||.8);
  const type=leaving?cfg.exit:(entering?cfg.enter:'none');
  const progress=leaving?ease(clamp((n.duration-time)/Math.max(.1,cfg.exitDuration||.8),0,1)):
    entering?ease(clamp(time/Math.max(.1,cfg.enterDuration||.8),0,1)):1;
  const missing=1-progress;let dx=0,dy=0,scale=1,rotation=0,opacity=1;
  if(type==='fade')opacity=progress;
  if(type==='slide-left')dx=(leaving?1:-1)*n.baseW*missing;
  if(type==='slide-right')dx=(leaving?-1:1)*n.baseW*missing;
  if(type==='slide-up')dy=(leaving?1:-1)*n.baseH*missing;
  if(type==='zoom')scale=.35+.65*progress;
  if(type==='spin')rotation=(leaving?-1:1)*360*missing;
  if(type==='pop'){scale=progress<1?.35+.65*ease(progress):1;opacity=progress}
  const emphStart=cfg.emphasisAt??1,emphDuration=Math.max(.1,cfg.emphasisDuration||.7);
  if(cfg.emphasis&&cfg.emphasis!=='none'&&time>=emphStart&&time<emphStart+emphDuration){const phase=(time-emphStart)/emphDuration,wave=Math.sin(phase*Math.PI),strength=clamp(cfg.intensity||1,.1,3),frequency=clamp(cfg.frequency||8,1,30);
    if(cfg.emphasis==='pulse')scale*=1+.23*wave*strength;
    if(cfg.emphasis==='shake')dx+=Math.sin(phase*emphDuration*frequency*Math.PI*2)*wave*n.baseW*.035*strength;
    if(cfg.emphasis==='swing')rotation+=Math.sin(phase*Math.PI*4)*wave*14*strength;
    if(cfg.emphasis==='rotate')rotation+=360*Math.max(1,Math.round(strength))*(phase*phase*(3-2*phase));
    if(cfg.emphasis==='vibrate'){
      dx+=Math.sin(phase*emphDuration*frequency*Math.PI*2)*wave*n.baseW*.025*strength;
      dy+=Math.cos(phase*emphDuration*frequency*Math.PI*2)*wave*n.baseH*.035*strength;
    }
  }
  return{dx,dy,scale,rotation,opacity};
}
function animatedNodeMatrix(matrix,n,time){const base=applyNode(matrix,n),a=animationAt(n,time);
  return {matrix:base.translate(a.dx,a.dy).translate(n.baseW/2,n.baseH/2).rotate(a.rotation).scale(a.scale).translate(-n.baseW/2,-n.baseH/2),opacity:a.opacity};
}
function traceMask(ctx,mask,w,h){if(!mask?.points?.length)return false;const p=mask.points.map(p=>({x:p.x*w,y:p.y*h}));if(p.length<2)return false;ctx.beginPath();if(['rect','ellipse','circle'].includes(mask.type)){
  const a=p[0],b=p[1];let x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),ww=Math.abs(b.x-a.x),hh=Math.abs(b.y-a.y);
  if(mask.type==='rect')ctx.rect(x,y,ww,hh);
  else if(mask.type==='ellipse')ctx.ellipse(x+ww/2,y+hh/2,Math.max(.001,ww/2),Math.max(.001,hh/2),0,0,Math.PI*2);
  else{const r=Math.max(.001,Math.min(ww,hh)/2);ctx.arc((a.x+b.x)/2,(a.y+b.y)/2,r,0,Math.PI*2)}
}else if(p.length>=3){ctx.moveTo(p[0].x,p[0].y);for(const q of p.slice(1))ctx.lineTo(q.x,q.y);ctx.closePath()}else return false;return true}

export class SceneRenderer{
  constructor(canvas,assets){this.canvas=canvas;this.ctx=canvas.getContext('2d',{alpha:false});this.assets=assets;this.players=new Map();this.lastTime=0;this.busy=Promise.resolve();this.hitEntries=[]}
  invalidate(){for(const player of this.players.values()){player.pause();player.removeAttribute('src');player.load()}this.players.clear()}
  // key: which <video> to use. Linked cutouts show the same moment of the same file as their parent, so they
  // share the parent's player (one decoder per video instead of one per cutout). sourceId: the file shown now —
  // a segment can carry its own (PowerPoint slides in one layer, pieces moved in from another layer).
  getPlayer(n,key=n.id,sourceId=n.sourceId){if(!sourceId)return null;const asset=this.assets.get(sourceId);if(!asset?.url)return null;if(n.type==='image')return asset.image;
    if(!this.players.has(key)){const el=document.createElement(n.type==='audio'?'audio':'video');el.src=asset.url;el.preload='auto';el.playsInline=true;el.muted=true;this.players.set(key,el)}return this.players.get(key)}
  entries(nodes,t){const all=[];
    // Every linked cutout resolves the same source timestamp as its parent at this timeline instant.
    // This also works when the cutout is created after the parent has already been cut or moved.
    const rec=(list,relativeTime,baseMatrix,visible,parentOpacity,parentEntry=null)=>{
      for(const n of [...list].reverse()){
        const local=relativeTime-n.start;
        const linked=!!(parentEntry&&n.editLinked!==false&&n.sourceId===parentEntry.node.sourceId&&['video','cutout'].includes(n.type));
        const inWindow=linked ? (relativeTime>=n.start && local<n.duration) : (local>=0&&local<n.duration);
        if(!visible||!n.visible||!inWindow)continue;
        if(!linked&&n.segments?.length&&!n.segments.some(s=>local>=s.start&&local<s.start+s.duration))continue;
        if(!linked&&(n.cutRanges||[]).some(([s,e])=>local>=s&&local<e))continue;
        const segment=(n.segments||[]).find(s=>local>=s.start&&local<s.start+s.duration);
        const sourceTime=linked?parentEntry.sourceTime:(segment?segment.inPoint+(local-segment.start)*n.speed:n.inPoint+local*n.speed);
        const sourceId=linked?parentEntry.sourceId:(segment?.sourceId||n.sourceId);
        const {matrix:m,opacity}=animatedNodeMatrix(baseMatrix,n,local),alpha=parentOpacity*opacity*n.opacity;
        const entry={node:n,time:local,matrix:m,alpha,sourceTime,sourceId,parent:parentEntry};all.push(entry);
        rec(n.children,local,m,true,alpha,entry)
      }
    };rec(nodes,t,new DOMMatrix(),true,1);return all}
  // live: preview playback rate while playing (0 when paused or exporting). While playing, each video runs on its
  // own and is only re-seeked when it drifts more than 0.3 s; seeking every frame overloads slower devices (iPad).
  // Paused or exporting, every frame is seeked exactly as before.
  async prepare(entries,live=0){const roots=new Map();for(const e of entries)if(['video','cutout'].includes(e.node.type)){const r=linkedRoot(e),key=playerKey(r);if(!roots.has(key))roots.set(key,r)}
    if(live)for(const [key,v] of this.players)if(!roots.has(key)&&!v.paused)v.pause();
    await Promise.all([...roots].map(async([key,e])=>{
    const v=this.getPlayer(e.node,key,e.sourceId),a=this.assets.get(e.sourceId);if(!v||!a)return;
    const sourceTime=e.sourceTime;
    const target=clamp(sourceTime,0,Math.max(0,(a.duration||1)-.025));
    if(live){if(v.readyState<1)return;const rate=clamp((e.node.speed||1)*live,.0625,16);if(Math.abs(v.playbackRate-rate)>1e-3)v.playbackRate=rate;
      if(!v.seeking&&(Math.abs(v.currentTime-target)>.3||v.ended))v.currentTime=target;if(v.paused)v.play().catch(()=>{});return}
    if(!v.paused)v.pause();
    if(v.readyState<1){await new Promise(resolve=>{const done=()=>{v.removeEventListener('loadedmetadata',done);v.removeEventListener('error',done);resolve()};v.addEventListener('loadedmetadata',done,{once:true});v.addEventListener('error',done,{once:true});setTimeout(done,3000)})}
    if(Math.abs(v.currentTime-target)<.017&&v.readyState>=2)return;
    await new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;v.removeEventListener('seeked',finish);v.removeEventListener('error',finish);resolve()};v.addEventListener('seeked',finish,{once:true});v.addEventListener('error',finish,{once:true});try{v.currentTime=target}catch{finish()}setTimeout(finish,1800)})
  }))}
  // guides: editor-only overlays (clip regions). Export calls render() without it.
  paint(entries,highlightId=null,draft=null,guides=false){const c=this.ctx;c.setTransform(1,0,0,1,0,0);c.fillStyle='#070b14';c.fillRect(0,0,WIDTH,HEIGHT);this.hitEntries=[];
    for(const e of entries){const n=e.node;if(n.type==='audio')continue;const m=e.matrix;c.save();c.setTransform(m.a,m.b,m.c,m.d,m.e,m.f);c.globalAlpha=e.alpha;
      if(traceMask(c,n.mask,n.baseW,n.baseH))c.clip();
      if(n.type==='text'){c.fillStyle=n.color;c.font=`700 ${n.font}px system-ui,"Noto Sans JP",sans-serif`;c.textBaseline='top';n.text.split('\n').forEach((line,i)=>c.fillText(line,0,i*n.font*1.23))}
      else if(n.type==='shape'){const w=n.baseW,h=n.baseH,k=n.shapeKind||'rect';c.fillStyle=n.color;c.strokeStyle=n.color;c.lineWidth=Math.max(4,Math.min(w,h)*.025);c.beginPath();if(k==='circle'||k==='ellipse'){c.ellipse(w/2,h/2,k==='circle'?Math.min(w,h)/2:w/2,k==='circle'?Math.min(w,h)/2:h/2,0,0,Math.PI*2);c.fill()}else if(k==='star'){for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,r=(i%2?.22:.48)*Math.min(w,h),x=w/2+Math.cos(a)*r,y=h/2+Math.sin(a)*r;i?c.lineTo(x,y):c.moveTo(x,y)}c.closePath();c.fill()}else if(['line','polyline','curve'].includes(k)){c.moveTo(0,h);if(k==='curve')c.bezierCurveTo(w*.25,-h*.3,w*.75,h*1.3,w,0);else if(k==='polyline'){c.lineTo(w*.35,h*.25);c.lineTo(w*.65,h*.75);c.lineTo(w,0)}else c.lineTo(w,0);c.stroke()}else{const sz=k==='square'?Math.min(w,h):null;c.rect(0,0,sz||w,sz||h);c.fill()}}
      else if(n.type==='image'){const im=this.getPlayer(n,n.id,e.sourceId);if(im?.complete&&im.naturalWidth)c.drawImage(im,0,0,n.baseW,n.baseH);else this.placeholder(n)}
      else if(['video','cutout'].includes(n.type)){const r=linkedRoot(e),v=this.getPlayer(n,playerKey(r),r.sourceId);if(v?.readyState>=2&&v.videoWidth){const s=n.sourceRect||{x:0,y:0,w:1,h:1};c.drawImage(v,s.x*v.videoWidth,s.y*v.videoHeight,s.w*v.videoWidth,s.h*v.videoHeight,0,0,n.baseW,n.baseH)}else this.placeholder(n)}
      c.restore();this.hitEntries.push(e)
    }
    if(guides)this.paintClipGuides(highlightId);
    const current=this.hitEntries.find(e=>e.node.id===highlightId);if(current){c.save();const m=current.matrix;c.setTransform(m.a,m.b,m.c,m.d,m.e,m.f);c.strokeStyle=current.node.type==='cutout'?'#ffb84b':'#97aaff';c.lineWidth=2/Math.max(.2,Math.sqrt(Math.abs(m.a*m.d-m.b*m.c)));c.setLineDash([8,5]);if(current.node.type==='cutout'&&traceMask(c,current.node.mask,current.node.baseW,current.node.baseH))c.stroke();else c.strokeRect(0,0,current.node.baseW,current.node.baseH);c.restore()}
    if(current&&draft?.points?.length){c.save();const m=current.matrix;c.setTransform(m.a,m.b,m.c,m.d,m.e,m.f);
      // Sizes in screen pixels: node units -> canvas pixels (matrix) -> screen pixels (canvas is scaled to fit).
      const px=1/Math.max(1e-6,Math.hypot(m.a,m.b)*(this.canvas.clientWidth?this.canvas.clientWidth/this.canvas.width:1));c.strokeStyle='#72ffbf';c.lineWidth=2.5*px;c.shadowColor='rgba(0,0,0,.85)';c.shadowBlur=3;c.beginPath();const p=draft.points;c.moveTo(p[0].x*current.node.baseW,p[0].y*current.node.baseH);
      if(['rect','circle','ellipse'].includes(draft.type)&&p.length>=2){traceMask(c,draft,current.node.baseW,current.node.baseH)}else{for(const q of p.slice(1))c.lineTo(q.x*current.node.baseW,q.y*current.node.baseH)}c.stroke();
      // Open polygon: line from the last vertex to the cursor.
      const k=draft.cursor,W=current.node.baseW,H=current.node.baseH,last=p[p.length-1];
      if(k){c.beginPath();c.moveTo(last.x*W,last.y*H);c.lineTo(k.x*W,k.y*H);c.stroke()}
      if(draft.type==='polygon'){c.fillStyle='#72ffbf';for(const q of draft.type==='polygon'?p:[p[0]]){c.beginPath();c.arc(q.x*W,q.y*H,4.5*px,0,Math.PI*2);c.fill()}}
      c.restore()}
  }
  // Outline every visible clip (cutout) shape; for the selected one, also show the area of the
  // parent video it is cut from. Line widths and dashes stay constant on screen.
  paintClipGuides(selectedId){const c=this.ctx,view=this.canvas.clientWidth?this.canvas.width/this.canvas.clientWidth:1;// canvas px per screen px
    const stroke=(m,mask,x,y,w,h,color,width)=>{const k=view/Math.max(.2,Math.sqrt(Math.abs(m.a*m.d-m.b*m.c)));c.save();c.setTransform(m.a,m.b,m.c,m.d,m.e,m.f);c.translate(x,y);
      c.globalAlpha=1;c.strokeStyle=color;c.lineWidth=width*k;c.setLineDash([6*k,4*k]);if(traceMask(c,mask,w,h))c.stroke();c.restore()};
    for(const e of this.hitEntries){const n=e.node;if(n.type!=='cutout'||!n.mask)continue;
      stroke(e.matrix,n.mask,0,0,n.baseW,n.baseH,'rgba(255,184,75,.9)',1.5);
      const p=e.parent;if(n.id===selectedId&&p&&n.sourceRect){const s=n.sourceRect,pw=p.node.baseW,ph=p.node.baseH;stroke(p.matrix,n.mask,s.x*pw,s.y*ph,s.w*pw,s.h*ph,'rgba(120,230,255,.9)',1.5)}}
  }
  placeholder(n){const c=this.ctx;c.fillStyle='#334158';c.fillRect(0,0,n.baseW,n.baseH);c.fillStyle='#c9d8f6';c.font='20px sans-serif';c.fillText(n.name,12,31)}
  render(nodes,t,highlightId=null,draft=null,guides=false,live=0){const entries=this.entries(nodes,t);const job=async()=>{await this.prepare(entries,live);this.paint(entries,highlightId,draft,guides);this.lastTime=t;return entries};this.busy=this.busy.then(job,job);return this.busy}
  hit(x,y){for(const e of [...this.hitEntries].reverse()){const n=e.node;const p=new DOMPoint(x,y).matrixTransform(e.matrix.inverse());if(p.x>=0&&p.y>=0&&p.x<=n.baseW&&p.y<=n.baseH)return{...e,local:p}}return null}
  localPoint(entry,x,y){const p=new DOMPoint(x,y).matrixTransform(entry.matrix.inverse());return{x:clamp(p.x/entry.node.baseW,0,1),y:clamp(p.y/entry.node.baseH,0,1)}}
}

export function cutoutFrom(parent,mask){const pts=mask.points;let minx=Math.min(...pts.map(p=>p.x)),miny=Math.min(...pts.map(p=>p.y)),maxx=Math.max(...pts.map(p=>p.x)),maxy=Math.max(...pts.map(p=>p.y));
  if(mask.type==='circle'){const cx=(minx+maxx)/2,cy=(miny+maxy)/2,r=Math.min(maxx-minx,maxy-miny)/2;minx=cx-r;maxx=cx+r;miny=cy-r;maxy=cy+r}
  const dx=Math.max(.01,maxx-minx),dy=Math.max(.01,maxy-miny),localPts=pts.map(p=>({x:(p.x-minx)/dx,y:(p.y-miny)/dy}));
  const w=Math.max(12,parent.baseW*dx),h=Math.max(12,parent.baseH*dy);
  return node('cutout',{name:`${parent.name} / 切り抜き`,sourceId:parent.sourceId,start:0,duration:parent.duration,inPoint:parent.inPoint,speed:parent.speed,
    x:minx*parent.baseW,y:miny*parent.baseH,w,h,baseW:w,baseH:h,sourceRect:{x:minx,y:miny,w:dx,h:dy},mask:{type:mask.type,points:localPts}})
}
