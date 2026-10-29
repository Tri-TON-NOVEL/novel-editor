import {pptxToImages} from './pptx-import.js';
import {WIDTH,HEIGHT,FPS,setCanvasResolution,clamp,id,node,findNode,walk,removeNode,cloneNode,duration,matrixForNode,SceneRenderer,cutoutFrom} from './engine.js';
import {encryptLkv,decryptLkv} from './lkv.js';
import {isFlv,flvToMp4} from './flv-import.js';
import {fastExport} from './fast-export.js';
import {fastMp4Export} from './mp4-export.js';
import {applyIcons,setIcon,installTooltips} from './icons.js';
import {AudioMix} from './audio-mix.js';
const $=s=>document.getElementById(s);
applyIcons();installTooltips();
// Phones (560 px wide or less): the area under the timeline shows one panel at a time — canvas, Explorer or
// properties — chosen with the tab bar at the bottom. Wider screens keep all panels side by side.
const phoneQuery=matchMedia('(max-width:560px)'),phoneTabs=document.createElement('nav');phoneTabs.className='phone-tabs';phoneTabs.setAttribute('aria-label','表示する領域');
for(const [pane,name,label] of [['canvas','canvasSize','キャンバス'],['explorer','folder','素材'],['inspector','sliders','プロパティ']]){
  const b=document.createElement('button');b.dataset.phonePane=pane;setIcon(b,name,{text:label,tip:label+'を表示'});b.onclick=()=>showPhonePane(pane);phoneTabs.append(b)}
document.querySelector('.workspace').append(phoneTabs);
function showPhonePane(pane){document.querySelector('.workspace').dataset.phonePane=pane;for(const b of phoneTabs.children)b.classList.toggle('active',b.dataset.phonePane===pane);if(pane==='canvas')requestAnimationFrame(()=>layout())}
showPhonePane('canvas');
// Settings that open in the properties area (speed, canvas size) bring that panel forward on a phone.
for(const id of ['speedButton','canvasSettingsToggle'])$(id).addEventListener('click',()=>{if(phoneQuery.matches)showPhonePane('inspector')});
const state={nodes:[],assets:new Map(),files:[],selectedFilePath:null,onlineRefs:[],selectedOnlineId:null,timelineOffset:0,path:'',selected:null,t:0,total:10,playing:false,zoom:1,tlScale:1,mode:'select',draft:null,attachToSelection:false,exporting:false,dirty:false,showThumbnails:true,explorerThumbs:true,rowHeight:37,rulerUnit:60,timelineUnits:10,previewRate:1};
let bookmarkActive=false,bookmarkPreview=null;
let removalActive=false,removalStart=null,removalNodeId=null;
const bookmarks=[],BOOKMARK_TYPES=['video','cutout','audio','image'];let removalHover=null;let bookmarkPanelOpen=false;
$('bookmarkMode').onclick=()=>{bookmarkPanelOpen=true;showBookmarkPanel();removalActive=false;removalStart=null;$('removeWithin').classList.remove('active');bookmarkActive=!bookmarkActive;bookmarkPreview=null;$('bookmarkMode').classList.toggle('active',bookmarkActive);setIcon($('bookmarkMode'),bookmarkActive?'bookmarkOn':'bookmark');requestPaint()};
const renderer=new SceneRenderer($('stage'),state.assets);let toastTimeout,gesture=null,polygonPoints=[],playOrigin=0,lastPaint=0,paintRequested=false;
const filmstrips=new Map(),thumbnailTasks=new Map();
// A thumbnail is a frame at its own timeline position, never a stretched filmstrip.
// Cache frame images by media ID + source time. Only one decoder seeks a given media at once.
const frameCache=new Map(),frameJobs=new Map();
const FRAME_CACHE_LIMIT=400,filmTimers=new Map();
function sourceTimeAt(n,local){
  const seg=(n.segments||[]).find(s=>local>=s.start&&local<s.start+s.duration);
  if(n.segments?.length&&!seg)return null;
  if((n.cutRanges||[]).some(([a,b])=>local>=a&&local<b))return null;
  return Math.max(0,seg?seg.inPoint+(local-seg.start)*(n.speed||1):(n.inPoint||0)+local*(n.speed||1));
}
// File and source time a layer shows at its local time, following linked parents all the way up (null: nothing shown).
function sourceAt(n,local,m=timeMap(n)){const seg=m.segments.find(s=>local>=s.start&&local<s.start+s.duration);
  if(!seg||m.cuts.some(([a,b])=>local>=a&&local<b))return null;return{time:Math.max(0,seg.inPoint+(local-seg.start)*m.speed),sourceId:seg.sourceId||n.sourceId}}
function frameTimes(n,asset,slots){
  // Each image represents the center of an actual on-screen time interval.
  return Array.from({length:slots},(_,i)=>{
    const local=n.duration*(i+.5)/slots;
    const parent=findNode(state.nodes,n.id)?.parent;
    if(parent&&n.editLinked!==false&&parent.sourceId===n.sourceId){
      return sourceTimeAt(parent,n.start+local);
    }
    return sourceTimeAt(n,local);
  });
}
// Thumbnail times snap to the 1/30 s frame grid so nearby zoom levels reuse cached frames.
const frameTime=t=>Math.round(t*30)/30;
// One decoder per media file is kept and reused (at most FRAME_DECODERS files at once).
// Creating a fresh <video> for every request re-reads the whole file and could exhaust memory
// while the timeline scale was being dragged.
const frameDecoders=new Map(),FRAME_DECODERS=3;
function releaseDecoder(id){const v=frameDecoders.get(id);if(!v)return;frameDecoders.delete(id);v.removeAttribute('src');v.load()}
async function frameDecoder(asset){let v=frameDecoders.get(asset.id);
  if(v&&v.dataset.url!==asset.url){releaseDecoder(asset.id);v=null}
  if(v){frameDecoders.delete(asset.id);frameDecoders.set(asset.id,v)}// most recently used last
  else{v=document.createElement('video');v.preload='auto';v.muted=true;v.playsInline=true;v.crossOrigin='anonymous';v.src=asset.url;v.dataset.url=asset.url;frameDecoders.set(asset.id,v);
    while(frameDecoders.size>FRAME_DECODERS)releaseDecoder(frameDecoders.keys().next().value)}
  const ready=await new Promise(resolve=>{if(v.readyState>=2)return resolve(true);let done=false;
    const finish=ok=>{if(done)return;done=true;clearTimeout(timeout);v.removeEventListener('loadeddata',yes);v.removeEventListener('error',no);resolve(ok)};
    const yes=()=>finish(true),no=()=>finish(false);v.addEventListener('loadeddata',yes);v.addEventListener('error',no);
    const timeout=setTimeout(()=>finish(false),12000);});
  if(!ready||!v.videoWidth){releaseDecoder(asset.id);return null}return v}
// channel: requests on the same channel replace older ones (e.g. timeline repaint while zooming);
// a superseded request stops seeking and just returns what is cached.
const frameGeneration=new Map();
async function getMediaFrames(asset, requested, channel=null){
  if(!asset.url||!requested.length)return new Map();
  const wanted=new Map();for(const t of requested){if(t==null)continue;
    const qt=frameTime(t);wanted.set(qt,`${asset.id}@${qt}`)}
  const missing=[...wanted].filter(([,k])=>!frameCache.has(k));
  const lane=channel&&asset.id+'|'+channel,generation=lane?(frameGeneration.get(lane)||0)+1:0;if(lane)frameGeneration.set(lane,generation);
  const stale=()=>lane&&frameGeneration.get(lane)!==generation;
  if(missing.length){
    const prior=frameJobs.get(asset.id)||Promise.resolve();
    const task=prior.catch(()=>{}).then(async()=>{
      if(stale())return;
      const v=await frameDecoder(asset);if(!v)return;
      const canvas=document.createElement('canvas');canvas.width=128;canvas.height=72;
      const ctx=canvas.getContext('2d',{alpha:false,colorSpace:'srgb'});
      for(const [time,key] of missing){if(stale())break;if(frameCache.has(key))continue;
        const target=clamp(time,0,Math.max(0,(Number.isFinite(v.duration)?v.duration:asset.duration||time)-.015));
        await new Promise(resolve=>{if(Math.abs(v.currentTime-target)<.0005&&v.readyState>=2)return resolve();let done=false;
          const finish=()=>{if(done)return;done=true;clearTimeout(timer);v.removeEventListener('seeked',finish);v.removeEventListener('error',finish);resolve()};
          v.addEventListener('seeked',finish);v.addEventListener('error',finish);const timer=setTimeout(finish,3500);
          try{v.currentTime=target}catch{finish()}});
        // 'seeked' is required; it ensures that the new frame has been decoded.
        try{ctx.drawImage(v,0,0,128,72);frameCache.set(key,canvas.toDataURL('image/jpeg',.82));
          while(frameCache.size>FRAME_CACHE_LIMIT)frameCache.delete(frameCache.keys().next().value)
        }catch(e){console.warn('thumbnail frame failed',time,e)}
      }
    });
    frameJobs.set(asset.id,task);await task.finally(()=>{if(frameJobs.get(asset.id)===task)frameJobs.delete(asset.id)})
  }
  const result=new Map();for(const [time,key] of wanted)result.set(time,frameCache.get(key));return result;
}
// v5.8: thumbnail tile width = visible row height * source aspect ratio.
// Tiles are scheduled only for the visible part of a clip; time sampling follows
// its edited time map, not the media's original unedited timeline location.
function paintTimelineFrames(bar,n,asset,lane,segment=null){
  if(!bar.isConnected||!lane.isConnected||!state.showThumbnails)return;
  const old=bar.querySelector(':scope > .timeline-frame-track');if(old)old.remove();
  const clipRect=bar.getBoundingClientRect(),laneRect=lane.getBoundingClientRect();
  const height=Math.max(12,bar.clientHeight-2);
  const ar=(asset.width>0&&asset.height>0)?asset.width/asset.height:16/9;
  const tileWidth=Math.max(16,height*ar);
  const realWidth=Math.max(0,clipRect.width);
  if(realWidth<=0||laneRect.width<=0)return;
  const visibleLeft=Math.max(0,laneRect.left-clipRect.left);
  const visibleRight=Math.min(realWidth,laneRect.right-clipRect.left);
  if(visibleRight<=visibleLeft)return;
  // Keep tiles aligned to the start of each independently movable cut segment.
  const first=Math.max(0,Math.floor(visibleLeft/tileWidth));
  const last=Math.min(Math.ceil(realWidth/tileWidth),Math.ceil(visibleRight/tileWidth));
  const requested=[],tiles=[];
  const layerDuration=segment?segment.duration:n.duration;
  const layerOffset=segment?segment.start:0,map=segment?null:timeMap(n);
  const frames=document.createElement('div');frames.className='timeline-frame-track';
  bar.prepend(frames);
  for(let i=first;i<last;i++){
    const x=i*tileWidth,cellW=Math.min(tileWidth,realWidth-x);
    if(cellW<=0)continue;
    // Each tile shows the scene at its left edge, so the first tile is the clip's first frame.
    const local=layerOffset+x/realWidth*layerDuration;
    let sourceTime;
    if(segment){
      sourceTime=(segment.inPoint||0)+(local-segment.start)*(n.speed||1);
      if((n.cutRanges||[]).some(([a,b])=>local>=a&&local<b))sourceTime=null;
    }else sourceTime=sourceAt(n,local,map)?.time??null;
    if(sourceTime==null)continue;
    const tile=document.createElement('img');tile.className='timeline-frame';tile.alt='';tile.draggable=false;
    tile.style.left=x+'px';tile.style.width=cellW+'px';
    frames.append(tile);requested.push(sourceTime);tiles.push([tile,sourceTime]);
  }
  if(!requested.length)return;
  // Cached frames appear at once; the rest arrive from the (single, reused) decoder.
  for(const [img,time] of tiles){const url=frameCache.get(`${asset.id}@${frameTime(time)}`);if(url)img.src=url}
  // Decode only after the view has been still for a moment (not on every zoom/scroll step).
  const channel=`film:${n.id}:${segment?n.segments.indexOf(segment):'all'}`;clearTimeout(filmTimers.get(channel));
  // During playback decoding waits, so it does not compete with the preview and sound (noticeable on iPad).
  const run=()=>{if(!frames.isConnected){filmTimers.delete(channel);return}if(state.playing){filmTimers.set(channel,setTimeout(run,600));return}filmTimers.delete(channel);
    getMediaFrames(asset,requested,channel).then(images=>{
      if(!frames.isConnected||!state.showThumbnails)return;
      for(const [img,time] of tiles){const url=images.get(frameTime(time));if(url)img.src=url}
    }).catch(e=>console.warn('filmstrip frames',e))};
  filmTimers.set(channel,setTimeout(run,150));
}

const selected=()=>findNode(state.nodes,state.selected)?.node||null;
const assetFor=n=>state.assets.get(n.sourceId);
const nameOf=t=>({online:'▷',video:'▶',image:'▧',audio:'♫',text:'T',shape:'◆',cutout:'◈'}[t]||'•');
const fmt=t=>{t=Math.max(0,t);return `${String(Math.floor(t/60)).padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`};
const notify=m=>{const e=$('toast');e.textContent=m;e.classList.remove('hidden');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>e.classList.add('hidden'),3000)};
const download=(blob,name)=>{const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),20000)};
function touch(){state.dirty=true;state.total=duration(state.nodes);$('seek').max=state.total;updateClock()}
const history={past:[],future:[],limit:80};
function historySnapshot(){return JSON.stringify({nodes:state.nodes,bookmarks,selected:state.selected,t:state.t,canvasW:WIDTH,canvasH:HEIGHT})}
function checkpoint(){const snap=historySnapshot();if(history.past.at(-1)===snap)return;history.past.push(snap);if(history.past.length>history.limit)history.past.shift();history.future.length=0;updateHistoryButtons()}
function historyRestore(snap){const d=JSON.parse(snap);state.nodes=d.nodes;bookmarks.splice(0,bookmarks.length,...(d.bookmarks||[]));state.selected=d.selected;state.selectedObject=null;state.t=d.t;applyCanvasSize(d.canvasW||1280,d.canvasH||720,false);renderAll();if($('bookmarkPanel'))showBookmarkPanel()}
// Checkpoints taken by clicks that changed nothing (mode toggles...) are skipped, so one press always undoes a change.
const editKey=snap=>{const d=JSON.parse(snap);return JSON.stringify([d.nodes,d.bookmarks,d.canvasW,d.canvasH])};// ignores playhead and selection
function doUndo(){const now=historySnapshot(),k=editKey(now);while(history.past.length&&editKey(history.past.at(-1))===k)history.past.pop();if(!history.past.length)return updateHistoryButtons();history.future.push(now);historyRestore(history.past.pop());updateHistoryButtons()}
function doRedo(){const now=historySnapshot(),k=editKey(now);while(history.future.length&&editKey(history.future.at(-1))===k)history.future.pop();if(!history.future.length)return updateHistoryButtons();history.past.push(now);historyRestore(history.future.pop());updateHistoryButtons()}
function updateHistoryButtons(){for(const id of ['timelineUndo'])if($(id))$(id).disabled=!history.past.length;for(const id of ['timelineRedo'])if($(id))$(id).disabled=!history.future.length}
function applyCanvasSize(w,h,refresh=true){w=Math.max(16,Math.min(7680,Math.round(w)));h=Math.max(16,Math.min(4320,Math.round(h)));setCanvasResolution(w,h);const c=$('stage');c.width=w;c.height=h;renderer.ctx=c.getContext('2d',{alpha:false});$('canvasSizeLabel').textContent=`${w} × ${h} / ${FPS}fps`; $('customWidth').value=w;$('customHeight').value=h;const p=$('canvasPreset');if(p)p.value=Array.from(p.options).find(o=>o.value===`${w}x${h}`)?.value||'custom';if(refresh)layout()}
function globalStart(target){let found=0;function visit(list,base){for(const n of list){const s=base+n.start;if(n.id===target)found=s;visit(n.children,s)}}visit(state.nodes,0);return found}
function locateParent(idValue){const info=findNode(state.nodes,idValue);return info?.parent||null}
function listVisible(){const out=[];const go=(list,depth=0)=>{for(const n of list){out.push({n,depth});if(!n.collapsed)go(n.children,depth+1)}};go(state.nodes);return out}
function worldMatrix(nodeId){const path=[];let found=false;function visit(list,chain){for(const n of list){if(n.id===nodeId){path.push(...chain,n);found=true;return}visit(n.children,[...chain,n]);if(found)return}}visit(state.nodes,[]);let m=new DOMMatrix();for(const n of path)m=matrixForNode(m,n);return m}
function isDescendant(root,target){let yes=false;walk(root.children,n=>{if(n.id===target)yes=true});return yes}
function moveHierarchy(fromId,targetId,placement='child'){
  const src=findNode(state.nodes,fromId),dst=targetId?findNode(state.nodes,targetId):null;
  if(!src||targetId&&(!dst||fromId===targetId||isDescendant(src.node,targetId)))return notify('自分自身や子レイヤーの下へは移動できません');
  const targetParent=placement==='child'?dst?.node||null:dst?.parent||null;
  const targetList=targetParent?targetParent.children:state.nodes;
  const absoluteStart=globalStart(fromId),targetParentStart=targetParent?globalStart(targetParent.id):0;
  const relative=worldMatrix(fromId),targetWorld=targetParent?worldMatrix(targetParent.id):new DOMMatrix();
  const m=targetWorld.inverse().multiply(relative),n=src.node;
  const sx=Math.hypot(m.a,m.b),sy=Math.hypot(m.c,m.d),rotation=Math.atan2(m.b,m.a),w=n.baseW*sx,h=n.baseH*sy;
  const ox=Math.cos(rotation)*w/2-Math.sin(rotation)*h/2,oy=Math.sin(rotation)*w/2+Math.cos(rotation)*h/2;
  if(src.parent!==targetParent)bakeLink(n);
  src.list.splice(src.list.indexOf(n),1);
  let insertion=placement==='end'?targetList.length:0;
  if(placement==='before'||placement==='after'){insertion=targetList.indexOf(dst.node)+(placement==='after'?1:0);insertion=Math.max(0,insertion)}
  targetList.splice(insertion,0,n);
  n.start=Math.max(0,absoluteStart-targetParentStart);n.x=m.e-w/2+ox;n.y=m.f-h/2+oy;n.w=w;n.h=h;n.rotation=rotation*180/Math.PI;
  if(targetParent)targetParent.collapsed=false;state.selected=n.id;renderAll();
  if(absoluteStart<targetParentStart)notify('親の開始時刻より前の部分は表示できないため、子レイヤー開始を0秒にしました');
}
function dropZone(element,event){const b=element.getBoundingClientRect(),y=(event.clientY-b.top)/Math.max(1,b.height);return y<.27?'before':y>.73?'after':'child'}
function dropIndicator(element,zone){element.classList.remove('drag-before','drag-after','drag-inside');if(zone)element.classList.add(zone==='child'?'drag-inside':'drag-'+zone)}
let hierarchyPointer=null;
function attachHierarchyDrag(el,id,droptarget=el){el.draggable=false;droptarget.dataset.hierarchyId=id;
  el.addEventListener('pointerdown',e=>{if(e.button!==0)return;hierarchyPointer={id,x:e.clientX,y:e.clientY,moved:false,ghost:null,marked:null};el.setPointerCapture(e.pointerId)});
  el.addEventListener('pointermove',e=>{const g=hierarchyPointer;if(!g||g.id!==id)return;
    if(!g.moved&&Math.hypot(e.clientX-g.x,e.clientY-g.y)<7)return;
    if(!g.moved){g.moved=true;g.ghost=document.createElement('div');g.ghost.className='hierarchy-ghost';g.ghost.textContent=findNode(state.nodes,id)?.node.name||'レイヤー';document.body.append(g.ghost)}
    g.ghost.style.left=(e.clientX+13)+'px';g.ghost.style.top=(e.clientY+12)+'px';
    const hit=document.elementFromPoint(e.clientX,e.clientY),target=hit?.closest('[data-hierarchy-id],.rootdrop');
    if(g.marked&&g.marked!==target){dropIndicator(g.marked,null);g.marked.classList.remove('dragover')}
    g.marked=target;if(target?.classList.contains('rootdrop'))target.classList.add('dragover');else if(target)dropIndicator(target,dropZone(target,e));
  });
  const release=e=>{const g=hierarchyPointer;if(!g||g.id!==id)return;hierarchyPointer=null;
    if(g.marked){dropIndicator(g.marked,null);g.marked.classList.remove('dragover')}
    if(g.ghost)g.ghost.remove();if(!g.moved)return;
    const hit=document.elementFromPoint(e.clientX,e.clientY),target=hit?.closest('[data-hierarchy-id],.rootdrop');
    if(target?.id==='timelineRootBottom'||(!target&&e.clientY>[...document.querySelectorAll('.tlrow')].at(-1)?.getBoundingClientRect().bottom))moveHierarchy(id,null,'end');else if(target?.classList.contains('rootdrop'))moveHierarchy(id,null,'child');
    else if(target?.dataset.hierarchyId)moveHierarchy(id,target.dataset.hierarchyId,dropZone(target,e));
    e.preventDefault();e.stopPropagation();
  };
  el.addEventListener('pointerup',release);el.addEventListener('pointercancel',release)
}
async function filmstripFor(asset){if(filmstrips.has(asset.id))return filmstrips.get(asset.id);if(thumbnailTasks.has(asset.id))return thumbnailTasks.get(asset.id);
  const task=(async()=>{if(!asset.url||asset.type!=='video')return null;const v=document.createElement('video');v.src=asset.url;v.preload='auto';v.muted=true;v.playsInline=true;
    const ready=await new Promise(resolve=>{if(v.readyState>=1)return resolve(true);let done=false;const finish=ok=>{if(done)return;done=true;resolve(ok)};v.onloadedmetadata=()=>finish(true);v.onerror=()=>finish(false);setTimeout(()=>finish(false),3500)});
    if(!ready||!v.videoWidth)return null;
    const total=Number.isFinite(v.duration)?v.duration:asset.duration||5,w=96,h=54,count=7,canvas=document.createElement('canvas');canvas.width=w*count;canvas.height=h;
    const ctx=canvas.getContext('2d',{alpha:false,colorSpace:'srgb'});
    for(let i=0;i<count;i++){const at=clamp(total*(i+.5)/count,0,Math.max(0,total-.05));
      await new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;v.removeEventListener('seeked',finish);resolve()};v.addEventListener('seeked',finish,{once:true});try{v.currentTime=at}catch{finish()}setTimeout(finish,1100)});
      try{ctx.drawImage(v,i*w,0,w,h)}catch{ctx.fillStyle='#36465a';ctx.fillRect(i*w,0,w,h)}
    }
    const url=canvas.toDataURL('image/png');filmstrips.set(asset.id,url);v.removeAttribute('src');v.load();return url
  })().catch(()=>null).finally(()=>thumbnailTasks.delete(asset.id));thumbnailTasks.set(asset.id,task);return task
}
function create(type,asset=null,parentId=null){checkpoint();const parent=parentId?findNode(state.nodes,parentId)?.node:null;const isChild=!!parent;
  const base=type==='text'?{w:530,h:104}:type==='shape'?{w:230,h:160}:type==='audio'?{w:500,h:20}:{w:690,h:388};
  if(asset&&type==='image'){base.w=Math.min(720,asset.width||720);base.h=base.w/(asset.width/asset.height||16/9)}
  if(asset&&type==='video'){base.w=730;base.h=base.w/(asset.width/asset.height||16/9)}
  const n=node(type,{...(asset?{name:asset.name}:{}),sourceId:asset?.id||null,start:isChild?0:state.t,duration:asset?(Number.isFinite(asset.duration)&&asset.duration>0?asset.duration:10):5,
    x:isChild?30:Math.round((WIDTH-base.w)/2),y:isChild?30:Math.round((HEIGHT-base.h)/2),w:base.w,h:base.h,baseW:base.w,baseH:base.h});
  if(type==='audio'){n.x=0;n.y=0}if(parent)parent.children.unshift(n);else state.nodes.unshift(n);
  state.selected=n.id;state.attachToSelection=false;renderAll();return n
}
function select(idValue){$('canvasSettings').classList.add('hidden');state.selected=idValue;state.selectedObject=null;state.draft=null;polygonPoints=[];renderAll()}
function renderAll(){touch();renderTimeline();renderProps();renderFileList();requestPaint();syncAudio();$('fitObject').disabled=!['video','image','cutout'].includes(selected()?.type)}

function importAsset(file,path=file.name,autoLayer=false,restoreId=null,suppressList=false,displayTitle=null){if(!/^(video|audio|image)\//.test(file.type)){return null}
  const prior=restoreId?state.assets.get(restoreId):[...state.assets.values()].find(a=>a.name===file.name&&!a.url);
  const asset=prior||{id:id(),name:file.name,type:file.type.split('/')[0],duration:10,width:1280,height:720};
  if(asset.url)URL.revokeObjectURL(asset.url);asset.file=file;asset.url=URL.createObjectURL(file);asset.path=path;asset.type=file.type.split('/')[0];if(displayTitle)asset.name=displayTitle;state.assets.set(asset.id,asset);for(const k of frameCache.keys())if(k.startsWith(asset.id+'@'))frameCache.delete(k);releaseDecoder(asset.id);
  if(asset.type==='image'){
    const img=new Image();img.onload=()=>{asset.width=img.naturalWidth;asset.height=img.naturalHeight;requestPaint()};img.src=asset.url;asset.image=img
  }else{
    const media=document.createElement(asset.type==='audio'?'audio':'video');media.preload='metadata';media.src=asset.url;media.onloadedmetadata=()=>{const oldDuration=asset.duration;asset.duration=Number.isFinite(media.duration)&&media.duration>0?media.duration:oldDuration;walk(state.nodes,n=>{if(n.sourceId===asset.id&&Math.abs(n.duration-oldDuration)<.001)n.duration=asset.duration});if(asset.type==='video'){asset.width=media.videoWidth||1280;asset.height=media.videoHeight||720}renderAll()}
  }
  renderer.invalidate();if(autoLayer)create(asset.type,asset,state.attachToSelection?state.selected:null);if(!suppressList)renderFileList();return asset
}
function registerFile(file,path){if(!/^(video|audio|image)\//.test(file.type)&&!/\.lkv$/i.test(file.name)&&!isFlv(file))return;const ix=state.files.findIndex(f=>f.path===path);if(ix>=0)state.files.splice(ix,1);state.files.push({file,path})}
async function importLkv(file,path=file.name,autoLayer=true){const password=prompt(`暗号化動画「${file.name}」のパスワードを入力してください。`);if(password===null)return;const status=$('status');status.textContent='LKV復号中…';try{
  const result=await decryptLkv(file,password,p=>status.textContent=`LKV復号中 ${Math.floor(p*100)}%`);
  // The asset keeps the same path as its Explorer entry (otherwise reopening the work lists the file twice).
  const plain=path.replace(/\.lkv$/i,'.'+result.file.name.split('.').pop());registerFile(result.file,plain);const asset=importAsset(result.file,plain,autoLayer,null,false,result.title);status.textContent=`LKV復号完了：${result.title}`;notify(`暗号化された表示名「${result.title}」で読み込みました`);return asset
}catch(e){status.textContent='LKV復号失敗';notify(e.message);return null}}
// Browsers cannot play FLV, so it is remuxed to MP4 and the Explorer entry is replaced by the MP4.
async function importFlv(file,path=file.name){const status=$('status');status.textContent='FLVをMP4に変換中…';readingProgress(file,0);try{
  const {file:mp4,warnings}=await flvToMp4(file,p=>{status.textContent=`FLVをMP4に変換中 ${Math.floor(p*100)}%`;readingProgress(file,Math.round(p*100))});
  const mp4Path=path.replace(/\.flv$/i,'')+'.'+mp4.name.split('.').pop();state.files=state.files.filter(x=>x.path!==path);if(state.selectedFilePath===path)state.selectedFilePath=mp4Path;
  registerFile(mp4,mp4Path);const asset=importAsset(mp4,mp4Path,false);status.textContent=`FLV読込完了：${mp4.name}`;
  notify(warnings.length?warnings.join(' / '):`${file.name} をMP4に変換して読み込みました`);return asset
}catch(e){console.error(e);status.textContent='FLV変換失敗';notify(`FLV変換失敗（${file.name}）: ${e.message}`);return null}
finally{importingItems=importingItems.filter(x=>x.name!==file.name);renderFileList()}}
// Convert every FLV currently listed in the Explorer (e.g. after picking a folder).
async function convertListedFlv(){for(const item of state.files.filter(x=>isFlv(x.file)))await importFlv(item.file,item.path)}
async function scanDirectory(handle,prefix='',depth=0){if(depth>8)return;for await(const [name,entry] of handle.entries()){
  if(state.files.length>=1000)break;
  if(entry.kind==='directory')await scanDirectory(entry,prefix+name+'/',depth+1);
  else{const f=await entry.getFile();registerFile(f,prefix+name)}
}}
// Online media imports were removed in v4.6.
const selectedOnline=()=>null;
const permittedOnlineAsset=()=>false;
const addOnlineClip=()=>null;
const updateOnlineButtons=()=>{};
function youtubeId(){return null}
let importingItems=[];
function renderFileList(){const h=$('fileList');h.replaceChildren();$('currentPath').textContent=state.path||'';$('assetCount').textContent=`${state.assets.size}点`;
  const prefix=state.path?state.path+'/':'',folders=new Set(),files=[];
  for(const item of state.files){if(!item.path.startsWith(prefix))continue;const rest=item.path.slice(prefix.length);if(rest.includes('/'))folders.add(rest.split('/')[0]);else files.push(item)}
  for(const entry of importingItems){const d=document.createElement('div');d.className='fileentry importing-file';const name=document.createElement('span');name.className='filename';name.textContent=entry.name;const p=document.createElement('progress');p.max=100;p.value=entry.percent;d.append(name,p);h.append(d)}

  for(const f of [...folders].sort()){const div=document.createElement('div');div.className='fileentry';div.innerHTML='<span class="folder">▣</span>';div.append(document.createTextNode(f));div.onclick=()=>{state.path=prefix+f;renderFileList()};h.append(div)}
  for(const item of files.sort((a,b)=>a.file.name.localeCompare(b.file.name))){const div=document.createElement('div');div.className='fileentry';const ico=document.createElement('span');ico.className='file-icon';const type=/\.lkv$/i.test(item.file.name)?'encrypted':isFlv(item.file)?'flv':item.file.type.split('/')[0];ico.textContent=type==='encrypted'?'🔒':type==='flv'?'🎞':nameOf(type);div.append(ico);if(state.explorerThumbs&&type==='video'){
      const img=document.createElement('img');img.className='file-thumb';img.alt='動画サムネイル';const a=[...state.assets.values()].find(a=>a.file===item.file);const asset=a||importAsset(item.file,item.path,false,null,true);if(asset){getMediaFrames(asset,[Math.max(0,(asset.duration||1)*.1)]).then(images=>{if(img.isConnected)img.src=[...images.values()][0]||''})}div.append(img)
    }else if(state.explorerThumbs&&type==='image'){const img=document.createElement('img');img.className='file-thumb';img.alt='画像サムネイル';const asset=[...state.assets.values()].find(a=>a.file===item.file)||importAsset(item.file,item.path,false,null,true);if(asset)img.src=asset.url;div.append(img)}
    const fileLabel=document.createElement('span');fileLabel.className='filename';fileLabel.textContent=([...state.assets.values()].find(a=>a.file===item.file)?.name||item.file.name);div.append(fileLabel);div.classList.toggle('file-selected',state.selectedFilePath===item.path);div.title='選択して「選択素材を追加」を押してください';div.onclick=()=>{state.selectedFilePath=item.path;state.selectedOnlineId=null;renderFileList()};div.draggable=true;div.addEventListener('dragstart',e=>{e.dataTransfer.setData('application/x-triton-asset',item.path);e.dataTransfer.effectAllowed='copy'});h.append(div)}
  $('addSelectedAsset').disabled=$('removeSelectedAsset').disabled=!state.files.some(x=>x.path===state.selectedFilePath);
  if(!h.children.length){const d=document.createElement('div');d.className='help';d.textContent='ファイルかフォルダを選択してください';h.append(d)}
}
// One mapping from time to horizontal position, shared by the ruler needle, every lane's yellow
// line and ruler clicks, so the two areas can never disagree.
const timelineSpanNow=()=>state.timelineSpan||state.total/state.tlScale;
const timelineX=t=>`${(t-(state.timelineOffset||0))/timelineSpanNow()*100}%`;
// The ruler must be exactly as wide as the lanes (the lanes lose width to the vertical scrollbar).
function alignRuler(){const ruler=$('timelineRuler'),lane=document.querySelector('#timelineBody .tllane');if(!lane)return;
  ruler.style.marginLeft=ruler.style.marginRight='';const r=ruler.getBoundingClientRect(),l=lane.getBoundingClientRect();
  ruler.style.marginLeft=(l.left-r.left)+'px';ruler.style.marginRight=(r.right-l.right)+'px'}
function renderRuler(){const el=$('timelineRuler'),max=timelineSpanNow(),offset=state.timelineOffset||0,width=el.clientWidth||700;
  const step=Number(state.rulerUnit)||60;el.replaceChildren();
  // Lane grid lines follow the ruler ticks. The grid is a CSS background tile as wide as one tick
  // gap; with a 1-hour tick on a sub-second view that tile would be millions of pixels wide and can
  // exhaust GPU memory, so the grid is switched off when the gap is far wider than the lane
  // (or too narrow to be useful).
  const gap=step/max*width,body=$('timelineBody');body.classList.toggle('no-grid',!(gap>=3&&gap<=width*2));
  body.style.setProperty('--tick-size',clamp(gap,3,width*2)+'px');body.style.setProperty('--tick-pos',(-(offset%step)/max*width%Math.max(1,gap))+'px');
  for(let i=0;i<=Math.ceil(max/step)&&i<250;i++){
    const sec=(Math.floor(offset/step)+i)*step;if(sec>offset+max+.00001)break;const tick=document.createElement('div');tick.className='ruler-tick';tick.style.left=((sec-offset)/max*100)+'%';
    tick.textContent=step<1?sec.toFixed(step<.2?2:1)+'s':sec>=60?`${Math.floor(sec/60)}:${String(Math.round(sec%60)).padStart(2,'0')}`:Math.round(sec)+'s';el.append(tick)
  }
  const needle=document.createElement('div');needle.id='rulerNeedle';needle.className='ruler-needle';needle.style.left=timelineX(state.t);el.append(needle)
}
$('timelineRuler').addEventListener('pointerdown',e=>{const r=$('timelineRuler').getBoundingClientRect();const t=clamp((state.timelineOffset||0)+(e.clientX-r.left)/Math.max(1,r.width)*timelineSpanNow(),0,state.total);if(removalActive){e.preventDefault();removalClick(t);return}state.t=t;if(state.playing)playOrigin=performance.now()-state.t*1000/state.previewRate;updateClock();requestPaint();syncAudio()});
$('timelineRuler').addEventListener('keydown',e=>{if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();jump(e.key==='ArrowRight'?.1:-.1)});
function renderTimeline(){const host=$('timelineBody'),rootBottom=$('timelineRootBottom');host.replaceChildren();for(const {n,depth}of listVisible()){
  const row=document.createElement('div');row.dataset.nodeId=n.id;row.className='tlrow'+(n.id===state.selected?' selected':'')+((n.type==='audio'?n.mute:!n.visible)?' track-disabled':'');
  const label=document.createElement('div');label.className='tlname'+((n.type==='audio'?n.mute:!n.visible)?' layer-off':'');label.style.paddingLeft=(5+depth*13)+'px';label.title=n.name+' — ドラッグで階層を移動';label.onclick=()=>select(n.id);
  const arrow=document.createElement('button');arrow.className='layer-caret';arrow.textContent=n.children.length?(n.collapsed?'▸':'▾'):'·';arrow.title='子レイヤーを折りたたむ／展開';arrow.setAttribute('aria-label','展開／折りたたみ');arrow.onpointerdown=e=>e.stopPropagation();arrow.onclick=e=>{e.stopPropagation();n.collapsed=!n.collapsed;renderTimeline()};
  const icon=document.createElement('span');icon.className='layer-type';icon.textContent=nameOf(n.type);
  const title=document.createElement('span');title.className='layer-title';title.textContent=n.name;
  const toggle=document.createElement('button');toggle.type='button';toggle.className='layer-switch'+((n.type==='audio'?n.mute:!n.visible)?' is-off':'');
  const isAudio=n.type==='audio';toggle.textContent=isAudio?(n.mute?'🔇':'🔊'):(n.visible?'👁':'⊘');toggle.title=isAudio?(n.mute?'ミュート解除':'ミュートする'):(n.visible?'非表示にする':'表示する');toggle.setAttribute('aria-label',toggle.title);
  toggle.onpointerdown=e=>e.stopPropagation();toggle.onclick=e=>{e.stopPropagation();if(isAudio)n.mute=!n.mute;else n.visible=!n.visible;renderTimeline();renderProps();requestPaint();syncAudio();touch()};
  const actions=document.createElement('button');actions.className='layer-action';actions.textContent='⋯';actions.title='レイヤー操作';actions.onpointerdown=e=>e.stopPropagation();actions.onclick=e=>{e.stopPropagation();select(n.id);const choice=prompt('レイヤー操作：1=次の追加素材をこの子にする / 2=親から独立する', '1');if(choice==='1'){state.attachToSelection=true;notify('次の追加素材をこのレイヤーの子にします')}else if(choice==='2'){const f=findNode(state.nodes,n.id);if(!f?.parent)return notify('すでに最上位です');checkpoint();moveHierarchy(n.id,null,'child');const moved=findNode(state.nodes,n.id)?.node;if(moved)moved.editLinked=false}};label.append(arrow,icon,title,toggle,actions);
  attachHierarchyDrag(label,n.id,row);
  const lane=document.createElement('div');lane.className='tllane';const bar=document.createElement('div');bar.className='tlclip'+(n.id===state.selected?' is-selected':'');bar.textContent=n.name;bar.title='クリック：オブジェクトを選択／ドラッグ：開始時刻を移動／両端：トリム';bar.style.background={online:'#b45357',video:'#407fa9',cutout:'#8274d0',text:'#aa70c6',image:'#b98944',audio:'#4c9b79',shape:'#698bb1'}[n.type];
  const max=(state.timelineSpan||state.total/state.tlScale),start=globalStart(n.id),offset=state.timelineOffset||0;
  bar.style.left=`${(start-offset)/max*100}%`;bar.style.width=`${n.duration/max*100}%`;
  if(n.type==='online'){bar.title='オンライン参照クリップ／公式再生のみ／書き出し対象外';bar.style.border='2px dashed #ffb0b0';}const a=state.assets.get(n.sourceId);
  // Detached audio shares its video's asset; audio rows show only the waveform.
  const film=state.showThumbnails&&a?.type==='video'&&['video','cutout'].includes(n.type);
  if(film){
    bar.classList.add('has-thumbnails')
  }
  // Cut pieces remain in one layer, but each segment has its own draggable time position.
  if(showsPieces(n)){
    bar.classList.add('segmented-container');bar.textContent='';bar.style.background='transparent';
    for(const segment of n.segments){const part=document.createElement('div');part.className='segment-piece';
      part.style.left=`${segment.start/n.duration*100}%`;part.style.width=`${segment.duration/n.duration*100}%`;
      const pa=state.assets.get(segment.sourceId||n.sourceId)||a;part.textContent=segment.label||n.name;part.title=`カット区間：${segment.start.toFixed(2)} 秒、ドラッグして独立移動`;
      if(n.type==='image'&&pa?.url){part.classList.add('image-piece');part.style.backgroundImage=`url("${pa.url}")`}
      if(isObjectSelected(n,n.segments.indexOf(segment)))part.classList.add('object-selected');
      part.onpointerdown=e=>{if(bookmarkActive)return;e.stopPropagation();e.preventDefault();checkpoint();state.selected=n.id;if(state.objectMode)state.selectedObject={nodeId:n.id,index:n.segments.indexOf(segment)};renderProps();const initialX=e.clientX,initialStart=segment.start,span=(state.timelineSpan||state.total/state.tlScale);
        // Unlinked children (text, images...) lying inside this piece travel with it.
        const riders=objectRiders(n,segment).map(c=>[c,c.start]);
        part.setPointerCapture(e.pointerId);let dragged=false;
        part.onpointermove=ev=>{const dx=ev.clientX-initialX;if(Math.hypot(dx,ev.clientY-e.clientY)>3)dragged=true;if(!dragged)return;objectDropTarget(n,ev);
          const other=n.segments.filter(x=>x!==segment).sort((a,b)=>a.start-b.start);
          let candidate=Math.max(0,initialStart+dx/Math.max(1,lane.clientWidth)*span);
          // Block collisions, but allow drag through gaps along the same track.
          for(const o of other){if(candidate<o.start+o.duration&&candidate+segment.duration>o.start){candidate=initialStart<=o.start?Math.max(0,o.start-segment.duration):o.start+o.duration}}
          segment.start=candidate;for(const [c,s0] of riders)c.start=Math.max(0,s0+candidate-initialStart);for(const child of linkedChildren(n))child.duration=Math.max(child.duration,n.duration);n.duration=Math.max(.1,...n.segments.map(x=>x.start+x.duration));
          part.style.left=`${segment.start/n.duration*100}%`;part.style.width=`${segment.duration/n.duration*100}%`;bar.style.width=`${n.duration/span*100}%`;touch();requestPaint();
        };
        part.onpointercancel=()=>{part.onpointermove=null;part.onpointerup=null;clearDropTarget();renderAll()};
        part.onpointerup=()=>{part.onpointermove=null;part.onpointerup=null;const row=dropRow;clearDropTarget();if(row)moveObjectToLayer(n.id,n.segments.indexOf(segment),row.dataset.nodeId);renderAll()};
      };
      bar.append(part);
      if(film&&pa?.type==='video'){part.classList.add('has-thumbnails');requestAnimationFrame(()=>paintTimelineFrames(part,n,pa,lane,segment))}
    }
  }
  // Added after the segment pieces, which clear the bar's contents.
  if(n.type==='audio'&&a?.url){bar.classList.add('audio-waveform');const wave=document.createElement('canvas');wave.className='waveform';bar.append(wave);drawWaveform(a,wave,n,bar,lane)}
  if(film&&!showsPieces(n)){requestAnimationFrame(()=>paintTimelineFrames(bar,n,a,lane))}
  if(isObjectSelected(n,null))bar.classList.add('object-selected');
  // Cut boundaries are real clip-segment boundaries held on the SAME track.
  // Each segment retains its own source in-point, for future per-segment edits.
  // Cut segments are represented as independently movable timeline clips; no yellow seam marker.
  for(const [from,to] of n.cutRanges||[]){const hole=document.createElement('span');hole.className='clip-cut-gap';hole.title='除去済み区間';hole.style.left=(from/n.duration*100)+'%';hole.style.width=((to-from)/n.duration*100)+'%';bar.append(hole)}
  const mark=document.createElement('div');mark.className='tlheadmark';mark.style.left=timelineX(state.t);lane.append(bar,mark);
  // A timeline clip selects its object. Only the ruler moves the yellow playhead.
  bar.onpointerdown=e=>{e.stopPropagation();e.preventDefault();state.selected=n.id;if(state.objectMode)state.selectedObject={nodeId:n.id,index:null};row.classList.add('selected');bar.classList.add('is-selected');for(const other of host.querySelectorAll('.tlrow'))if(other!==row){other.classList.remove('selected');other.querySelector('.tlclip')?.classList.remove('is-selected')}
    const rect=bar.getBoundingClientRect();const kind=e.clientX-rect.left<8?'left':rect.right-e.clientX<8?'right':'move';const init={x:e.clientX,t:n.start,d:n.duration,in:n.inPoint,wasDrag:false};bar.setPointerCapture(e.pointerId);
    renderProps();requestPaint();
    bar.onpointermove=ev=>{const delta=(ev.clientX-init.x)/lane.clientWidth*max;if(Math.hypot(ev.clientX-init.x,ev.clientY-e.clientY)>4)init.wasDrag=true;if(!init.wasDrag)return;if(kind==='move')objectDropTarget(n,ev);
      if(kind==='move')n.start=Math.max(0,init.t+delta);
      else if(kind==='right')n.duration=Math.max(.1,init.d+delta);
      else{const s=clamp(init.t+delta,0,init.t+init.d-.1);n.start=s;n.duration=init.d-(s-init.t);n.inPoint=Math.max(0,init.in+(s-init.t)*n.speed)}
      bar.style.left=`${(globalStart(n.id)-offset)/max*100}%`;bar.style.width=`${n.duration/max*100}%`;touch();
      if(n.type==='audio'&&a)updateWaveCanvases(a.id)
    };
    bar.onpointerup=()=>{bar.onpointermove=null;const row=dropRow;clearDropTarget();if(row){checkpoint();moveObjectToLayer(n.id,null,row.dataset.nodeId)}renderAll()};renderProps()
  };
  lane.addEventListener('pointermove',e=>{if(removalActive&&removalStart!==null&&removalNodeId===n.id){const r=lane.getBoundingClientRect();removalHover=clamp(offset+(e.clientX-r.left)/Math.max(1,r.width)*max,0,state.total);renderRemovalPreview(lane,{from:globalStart(n.id)+removalStart,to:removalHover,offset,max})}if(!bookmarkActive||n.id!==state.selected)return;const r=lane.getBoundingClientRect();bookmarkPreview=clamp(offset+(e.clientX-r.left)/r.width*max,0,state.total);requestPaint()});
  lane.addEventListener('pointerleave',()=>{if(bookmarkActive){bookmarkPreview=null;requestPaint()}if(removalActive){removalHover=null;renderRemovalPreview(lane,null)}});
  lane.addEventListener('pointerdown',e=>{if(!removalActive)return;e.stopPropagation();e.preventDefault();const r=lane.getBoundingClientRect();const t=clamp(offset+(e.clientX-r.left)/Math.max(1,r.width)*max,0,state.total);removalClick(t,n.id)},true);
  lane.addEventListener('pointerdown',e=>{if(!bookmarkActive||n.id!==state.selected)return;if(!BOOKMARK_TYPES.includes(n.type)){notify('ブックマークは動画・音声・画像のレイヤーに設定できます');return}e.stopPropagation();e.preventDefault();const r=lane.getBoundingClientRect();const t=clamp(offset+(e.clientX-r.left)/r.width*max,0,state.total);checkpoint();bookmarks.push({id:id(),nodeId:n.id,t,name:n.name});bookmarkPreview=null;showBookmarkPanel();renderTimeline();requestPaint();notify('ブックマークを追加しました')},true);
  // Bookmarks belong to their layer's lane (video, cutout, audio or image), not to the global ruler.
  if(BOOKMARK_TYPES.includes(n.type)) for(const b of bookmarks.filter(b=>b.nodeId===n.id)){
    const marker=document.createElement('button');marker.type='button';marker.className='bookmark-mark lane-bookmark';
    marker.title=`${b.name} @ ${fmt(b.t)}（クリックで移動）`;
    marker.style.left=((b.t-offset)/max*100)+'%';marker.textContent='◆';
    marker.onpointerdown=e=>e.stopPropagation();marker.onclick=e=>{e.stopPropagation();state.t=b.t;select(n.id);updateClock();renderRuler();requestPaint()};
    lane.append(marker);
  }
  row.append(label,lane);host.append(row)
}host.append(rootBottom);alignRuler();renderRuler();updateTimelinePan()}
 $('showThumbnails').onchange=e=>{state.showThumbnails=e.target.checked;renderTimeline()};
 $('rowHeight').oninput=e=>{state.rowHeight=Number(e.target.value);workspace.style.setProperty('--tl-row-height',state.rowHeight+'px');touch();redrawAllWaveforms()};
 $('explorerThumbs').onchange=e=>{state.explorerThumbs=e.target.checked;renderFileList()};
const fields={prName:'name',prText:'text',prStart:'start',prDuration:'duration',prX:'x',prY:'y',prW:'w',prH:'h',prRotation:'rotation',prSpeed:'speed',prOpacity:'opacity',prColor:'color',prFont:'font',prVisible:'visible',prMute:'mute'};
function showBookmarkPanel(){
 let panel=$('bookmarkPanel');if(!panel){panel=document.createElement('section');panel.id='bookmarkPanel';panel.className='bookmark-panel';document.querySelector('.inspector').append(panel)}
 panel.replaceChildren();const title=document.createElement('strong');title.textContent='★ ブックマーク一覧';panel.append(title);
 const close=document.createElement('button');setIcon(close,'x',{tip:'ブックマーク一覧を閉じる'});close.onclick=()=>{bookmarkPanelOpen=false;panel.classList.add('hidden')};panel.append(close);
 for(const b of bookmarks){const row=document.createElement('div');row.className='bookmark-row';const go=document.createElement('button');go.textContent=fmt(b.t);go.onclick=()=>{state.t=b.t;updateClock();requestPaint();renderRuler()};const name=document.createElement('input');name.value=b.name||'ブックマーク';name.title='ブックマーク名';name.onchange=()=>{checkpoint();b.name=name.value;renderTimeline()};const del=document.createElement('button');setIcon(del,'trash',{tip:'このブックマークを削除'});del.onclick=()=>{checkpoint();bookmarks.splice(bookmarks.indexOf(b),1);showBookmarkPanel();renderTimeline()};row.append(go,name,del);panel.append(row)}
 panel.classList.toggle('hidden',!bookmarkPanelOpen)
}
function captureDialogHidden(){return $('captureDialog').classList.contains('hidden')}
function renderProps(){if(!$('speedSettings').classList.contains('hidden')){renderSpeedPanel();return}if(!$('canvasSettings').classList.contains('hidden')||!captureDialogHidden())return;const n=selected();$('props').classList.toggle('hidden',!n);$('emptySelection').classList.toggle('hidden',!!n);$('selectedType').textContent=n?({video:'動画',cutout:'切り抜き',image:'画像',audio:'音声',text:'文字',shape:'図形'}[n.type]):'未選択';if(!n)return;
  const info=findNode(state.nodes,n.id);$('linkEditsField').classList.toggle('hidden',!info?.parent || !['video','cutout'].includes(n.type));$('linkEdits').checked=n.editLinked!==false;
  $('waveScaleField').classList.toggle('hidden',n.type!=='audio');if(n.type==='audio'){const k=waveScaleOf(n);$('prWaveScale').value=k;$('waveScaleValue').textContent=k.toFixed(1)+'×'}
  $('textProperty').classList.toggle('hidden',n.type!=='text');$('textTargetField').classList.toggle('hidden',n.type!=='text');$('textTargetHelp').classList.toggle('hidden',n.type!=='text');if(n.type==='text'){const dropdown=$('textTarget');dropdown.replaceChildren(new Option('新規レイヤー（現在のレイヤーを維持）',''));function visit(nodes){for(const other of nodes){if(other.type==='text'&&other.id!==n.id)dropdown.add(new Option(other.name||'テキスト',other.id));if(other.children)visit(other.children)}}visit(state.nodes);dropdown.value=''}$('fontProperty').classList.toggle('hidden',n.type!=='text');$('colorProperty').classList.toggle('hidden',!['text','shape'].includes(n.type));
  for(const[id,key]of Object.entries(fields)){const el=$(id);if(el.type==='checkbox')el.checked=n[key];else el.value=n[key]}
  showSpeed($('prSpeedSelect'),$('prSpeed'),$('prSpeed'),n.speed||1);
  const anim=n.animation||{enter:'none',enterDuration:.8,exit:'none',exitDuration:.8};
  $('animIn').value=anim.enter||'none';$('animOut').value=anim.exit||'none';$('animInDuration').value=anim.enterDuration||.8;$('animOutDuration').value=anim.exitDuration||.8;
  $('animEmphasis').value=anim.emphasis||'none';$('animEmphasisAt').value=anim.emphasisAt??1;$('animEmphasisDuration').value=anim.emphasisDuration||.7;
  $('animIntensity').value=anim.intensity||1;$('animFrequency').value=anim.frequency||8;
}
// Speed: a preset list plus "カスタム" (0.1-3x). Used for the clip speed (layout tab and the speed
// panel) and for the preview playback rate (speed panel, opened from the transport bar).
const SPEED_PRESETS=[0.1,0.25,0.5,0.75,1,1.25,1.5,1.75,2,2.5,3];
const speedText=v=>`${+v.toFixed(2)}×`;
for(const id of ['prSpeedSelect','previewRateSelect','clipSpeedSelect'])$(id).replaceChildren(...SPEED_PRESETS.map(v=>new Option(speedText(v),String(v))),new Option('カスタム…','custom'));
function showSpeed(select,input,customField,value){const preset=SPEED_PRESETS.find(p=>Math.abs(p-value)<1e-6);
  if(select.value==='custom'&&!customField.classList.contains('hidden')&&document.activeElement===input)return;// user is typing
  select.value=preset!=null?String(preset):'custom';input.value=+value.toFixed(3);customField.classList.toggle('hidden',preset!=null)}
function wireSpeed(select,input,customField,apply){
  select.addEventListener('change',()=>{if(select.value==='custom'){customField.classList.remove('hidden');input.focus();input.select?.();return}customField.classList.add('hidden');apply(Number(select.value))});
  input.addEventListener('change',()=>{const v=clamp(Number(input.value)||1,.1,3);input.value=v;apply(v)})}
const speedTarget=()=>{const n=selected(),parent=n&&findNode(state.nodes,n.id)?.parent;return n&&['video','cutout','audio'].includes(n.type)&&!isLinkedTo(parent,n)?n:null};
wireSpeed($('prSpeedSelect'),$('prSpeed'),$('prSpeed'),v=>{const n=selected();if(!n)return;checkpoint();$('prSpeed').value=v;n.speed=v;renderAll()});
wireSpeed($('clipSpeedSelect'),$('clipSpeedCustom'),$('clipSpeedCustomField'),v=>{const n=speedTarget();if(!n)return;checkpoint();n.speed=v;renderAll()});
wireSpeed($('previewRateSelect'),$('previewRateCustom'),$('previewRateCustomField'),v=>setPreviewRate(v));
function setPreviewRate(v){state.previewRate=clamp(v,.1,3);if(state.playing)playOrigin=performance.now()-state.t*1000/state.previewRate;
  setIcon($('speedButton'),'gauge',{text:speedText(state.previewRate)});syncAudio();renderSpeedPanel()}
function renderSpeedPanel(){showSpeed($('previewRateSelect'),$('previewRateCustom'),$('previewRateCustomField'),state.previewRate);
  const n=selected(),target=speedTarget(),off=!target;
  $('clipSpeedTarget').textContent=n?`（${n.name}）`:'（未選択）';$('clipSpeedSelect').disabled=$('clipSpeedCustom').disabled=off;
  $('clipSpeedHelp').textContent=!n?'タイムラインで動画・音声のクリップを選ぶと設定できます。':off&&['video','cutout','audio'].includes(n.type)?'親動画に連動しているため、親の速度に従います。':off?'このレイヤーには速度がありません。':'素材を何倍速で使うかです。書き出した動画にも反映されます。クリップの長さは変わりません。';
  if(target)showSpeed($('clipSpeedSelect'),$('clipSpeedCustom'),$('clipSpeedCustomField'),target.speed||1)}
function toggleSpeedPanel(show=$('speedSettings').classList.contains('hidden')){$('speedSettings').classList.toggle('hidden',!show);$('speedButton').setAttribute('aria-expanded',String(show));$('speedButton').classList.toggle('active',show);
  if(show){$('canvasSettings').classList.add('hidden');$('props').classList.add('hidden');$('emptySelection').classList.add('hidden');$('selectedType').textContent='再生速度';renderSpeedPanel()}else renderProps()}
$('speedButton').onclick=()=>toggleSpeedPanel();$('speedClose').onclick=()=>toggleSpeedPanel(false);
$('textTarget').addEventListener('change',e=>{const source=selected(),id=e.target.value;if(!source||source.type!=='text'||!id)return;const dest=findNode(state.nodes,id)?.node;if(!dest||dest.type!=='text'||dest.id===source.id)return;checkpoint();dest.text=[dest.text||'',source.text||''].filter(Boolean).join('\n');removeNode(state.nodes,source.id);state.selected=dest.id;renderAll();notify('既存テキストレイヤーに追加しました')});
// Waveform display gain only; playback volume and row height are unaffected.
const waveScaleOf=n=>clamp(Number(n.waveScale)||1,.5,20);
function setWaveScale(value){const n=selected();if(!n||n.type!=='audio')return;n.waveScale=clamp(Number(value)||1,.5,20);$('prWaveScale').value=n.waveScale;$('waveScaleValue').textContent=n.waveScale.toFixed(1)+'×';const a=state.assets.get(n.sourceId);if(a)updateWaveCanvases(a.id);state.dirty=true}
$('prWaveScale').addEventListener('input',e=>setWaveScale(e.target.value));
$('prWaveScale').addEventListener('dblclick',()=>{checkpoint();setWaveScale(1)});
$('linkEdits').addEventListener('change',e=>{const n=selected();if(!n)return;checkpoint();if(e.target.checked)n.editLinked=true;else bakeLink(n);n.editLinked=e.target.checked;renderAll()});
for(const[id,key]of Object.entries(fields))$(id).addEventListener('input',()=>{const n=selected();if(!n)return;const e=$(id);let value=e.type==='checkbox'?e.checked:e.type==='number'||e.type==='range'?Number(e.value):e.value;
  // Speed used to be clamped to at least 1, which made slow motion impossible.
  if(key==='speed')value=clamp(value||1,.1,3);
  else if(['duration','w','h','font'].includes(key))value=Math.max(key==='duration'?.1:1,value);
  if(['start','inPoint'].includes(key))value=Math.max(0,value);n[key]=value;renderTimeline();requestPaint();touch()
});
for(const [control,key] of Object.entries({animIn:'enter',animOut:'exit',animInDuration:'enterDuration',animOutDuration:'exitDuration',animEmphasis:'emphasis',animEmphasisAt:'emphasisAt',animEmphasisDuration:'emphasisDuration',animIntensity:'intensity',animFrequency:'frequency'}))$(control).addEventListener('change',()=>{
  const n=selected();if(!n)return;n.animation??={enter:'none',enterDuration:.8,exit:'none',exitDuration:.8};
  const input=$(control);n.animation[key]=key.endsWith('Duration')?Math.max(.1,Number(input.value)||.8):key==='emphasisAt'?Math.max(0,Number(input.value)||0):key==='intensity'?clamp(Number(input.value)||1,.1,3):key==='frequency'?clamp(Number(input.value)||8,1,30):input.value;touch();renderTimeline();requestPaint();
});
$('previewAnimation').onclick=()=>{const n=selected();if(!n)return;state.playing=false;refreshPlaybackButtons();
  const s=globalStart(n.id),hasEntry=n.animation?.enter&&n.animation.enter!=='none',hasEmphasis=n.animation?.emphasis&&n.animation.emphasis!=='none',hasExit=n.animation?.exit&&n.animation.exit!=='none';
  state.t=clamp(hasEntry?s:hasEmphasis?s+(n.animation.emphasisAt||0):hasExit?s+n.duration-Math.max(.1,n.animation.exitDuration||.8):s,0,state.total);
  updateClock();requestPaint();togglePlay();
};
function setMode(mode){state.mode=mode;state.draft=null;polygonPoints=[];gesture=null;document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  $('modeHelp').textContent={select:'ドラッグで移動',resize:'レイヤー上をドラッグでサイズ変更',rect:'対角ドラッグ',ellipse:'対角ドラッグ',circle:'対角ドラッグ',polygon:'クリックで頂点を確定→最後はダブルクリックで始点と閉じる／Escで取り消し',freehand:'輪郭をなぞる（離すと確定）'}[mode];requestPaint()
}
function paintImmediate(){renderer.paint(renderer.entries(state.nodes,state.t),state.selected,state.draft,true)}
let repaintAgain=false;
async function paint(){if(paintRequested){repaintAgain=true;return}paintRequested=true;try{await renderer.render(state.nodes,bookmarkPreview??state.t,state.selected,state.draft,true)}catch(e){$('status').textContent='描画エラー: '+e.message}finally{paintRequested=false;if(repaintAgain){repaintAgain=false;paint()}}}
function requestPaint(){paint()}
function updateClock(){$('clock').textContent=`${fmt(state.t)} / ${fmt(state.total)}`;if(document.activeElement!==$('playheadTime'))$('playheadTime').value=state.t.toFixed(2);$('seek').value=state.t;const x=timelineX(state.t);for(const m of document.querySelectorAll('.tllane > .tlheadmark'))m.style.left=x;
  const rulerMark=$('rulerNeedle');if(rulerMark)rulerMark.style.left=x;followPlayhead()}
// Scroll the timeline so the yellow line stays visible. Only a playhead move (or a zoom, with
// force) triggers it, so editing while scrolled elsewhere does not yank the view back.
// While playing, the view turns a page; after a jump, the playhead is centred.
let followedT=0;
function followPlayhead(force=false){if(!force&&state.t===followedT)return;followedT=state.t;
  const span=timelineSpanNow(),offset=state.timelineOffset||0;if(state.t>=offset&&state.t<=offset+span)return;
  state.timelineOffset=clamp(state.playing&&state.t>offset+span?state.t-span*.05:state.t-span/2,0,timelineMaxOffset());renderTimeline()}
function layout(){const vp=$('viewport');const fit=Math.min((vp.clientWidth-24)/WIDTH,(vp.clientHeight-24)/HEIGHT);const size=Math.max(.05,fit*state.zoom);$('canvasBox').style.width=(WIDTH*size)+'px';$('canvasBox').style.height=(HEIGHT*size)+'px';$('viewZoom').textContent=Math.round(state.zoom*100)+'%';requestPaint()}
function installSplitter(id,calculate,reset){const bar=$(id);let initial=null;
  bar.addEventListener('pointerdown',e=>{if(e.button!==0)return;initial={x:e.clientX,y:e.clientY};bar.setPointerCapture(e.pointerId);bar.classList.add('dragging');e.preventDefault()});
  bar.addEventListener('pointermove',e=>{if(!initial)return;calculate(e.clientX-initial.x,e.clientY-initial.y);initial={x:e.clientX,y:e.clientY};layout()});
  const stop=()=>{initial=null;bar.classList.remove('dragging')};bar.addEventListener('pointerup',stop);bar.addEventListener('pointercancel',stop);
  bar.addEventListener('dblclick',()=>{reset();layout()});
  bar.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();calculate(e.key==='ArrowRight'?12:e.key==='ArrowLeft'?-12:0,e.key==='ArrowDown'?12:e.key==='ArrowUp'?-12:0);layout()})
}
const workspace=document.querySelector('.workspace'),editarea=document.querySelector('.editarea'),leftpanel=document.querySelector('.leftpanel');
installSplitter('leftDivider',dx=>{const v=parseFloat(getComputedStyle(workspace).getPropertyValue('--left-width'))||230;workspace.style.setProperty('--left-width',clamp(v+dx,150,Math.min(500,innerWidth*.43))+'px')},()=>workspace.style.removeProperty('--left-width'));
installSplitter('rightDivider',dx=>{const v=parseFloat(getComputedStyle(workspace).getPropertyValue('--right-width'))||250;workspace.style.setProperty('--right-width',clamp(v-dx,175,Math.min(540,innerWidth*.45))+'px')},()=>workspace.style.removeProperty('--right-width'));
installSplitter('timelineDivider',(_,dy)=>{const current=document.querySelector('.timeline').getBoundingClientRect().height;workspace.style.setProperty('--timeline-height',clamp(current+dy,155,Math.max(200,workspace.clientHeight*.7))+'px')},()=>workspace.style.removeProperty('--timeline-height'));
installSplitter('hierarchyGutter',dx=>{const v=parseFloat(getComputedStyle(workspace).getPropertyValue('--hier-width'))||214;workspace.style.setProperty('--hier-width',clamp(v+dx,105,Math.min(440,innerWidth*.48))+'px')},()=>workspace.style.removeProperty('--hier-width'));
function screenPt(e){const b=$('stage').getBoundingClientRect();return{x:(e.clientX-b.left)*WIDTH/b.width,y:(e.clientY-b.top)*HEIGHT/b.height}}
function addCutout(mask){const parent=selected();if(!parent||!['video','cutout'].includes(parent.type))return notify('切り抜き対象の動画を選択してください');
  checkpoint();const child=cutoutFrom(parent,mask);child.editLinked=true;parent.children.unshift(child);parent.collapsed=false;state.selected=parent.id;state.draft=null;renderAll();notify('子クリップを作成しました。ドラッグで自由に配置できます')
}
// Polygon: each click fixes a vertex (and the side ending there); a green line runs from the last vertex to the
// cursor and follows it; a double-click closes the shape from its last vertex back to the first. Freehand finishes on release.
const PATH_MODES=['polygon'];let pathTarget=null,lastPathDown=null;
function finishPolygon(){if(!PATH_MODES.includes(state.mode))return;const pts=polygonPoints.filter((p,i,a)=>i===0||Math.hypot(p.x-a[i-1].x,p.y-a[i-1].y)>1e-4);
  if(pts.length<3)return notify('少なくとも3点指定してください');polygonPoints=[];pathTarget=null;state.draft=null;addCutout({type:state.mode,points:pts.map(p=>({...p}))})}
function cancelPath(){polygonPoints=[];pathTarget=null;state.draft=null;gesture=null;paintImmediate()}
function pathDraft(cursor=null){state.draft=polygonPoints.length?{type:state.mode==='freehand'?'freehand':'polygon',points:[...polygonPoints],cursor}:null}
function ancestorMatrix(nodeId){const info=findNode(state.nodes,nodeId);if(!info?.parent)return new DOMMatrix();const e=renderer.hitEntries.find(e=>e.node.id===info.parent.id);return e?.matrix||new DOMMatrix()}
$('shapeMenuButton').onclick=()=>document.getElementById('shapeMenu').classList.toggle('hidden');document.querySelectorAll('[data-shape]').forEach(b=>b.onclick=()=>{shapeKind=b.dataset.shape;document.getElementById('shapeMenu').classList.add('hidden');setMode('shape-draw');notify('キャンバス上でドラッグして図形を描画')});let shapeKind='rect';
// Enlarge the selected video/image object as far as it fits inside the canvas, keeping its aspect ratio and
// rotation, and centre it. Worked out in canvas pixels, then mapped back into the parent's coordinates so
// child objects (whose parent may be scaled or rotated) land in the same place.
function fitObjectToCanvas(){const n=selected();if(!n||!['video','image','cutout'].includes(n.type))return notify('キャンバスに最大化する動画・画像を選択してください');
  const P=ancestorMatrix(n.id),kx=Math.hypot(P.a,P.b)||1,ky=Math.hypot(P.c,P.d)||1,rad=(Math.atan2(P.b,P.a)*180/Math.PI+(n.rotation||0))*Math.PI/180;
  const cw=n.w*kx,ch=n.h*ky,cos=Math.abs(Math.cos(rad)),sin=Math.abs(Math.sin(rad)),s=Math.min(WIDTH/(cw*cos+ch*sin),HEIGHT/(cw*sin+ch*cos));
  if(!Number.isFinite(s)||s<=0)return;const c=new DOMPoint(WIDTH/2,HEIGHT/2).matrixTransform(P.inverse());
  checkpoint();n.w*=s;n.h*=s;n.x=c.x-n.w/2;n.y=c.y-n.h/2;renderAll();notify('オブジェクトをキャンバスに最大化しました（Undoで戻せます）')}
$('fitObject').onclick=fitObjectToCanvas;$('clipStretch').onclick=()=>setMode('clip-stretch');$('canvasRotate').onclick=()=>setMode('rotate-object');
const vp=$('viewport');vp.addEventListener('pointerdown',e=>{const p=screenPt(e),hit=renderer.hit(p.x,p.y),n=selected();if(state.mode==='shape-draw'){checkpoint();const shape=node('shape',{name:'図形 '+shapeKind,shapeKind,x:p.x,y:p.y,w:1,h:1,baseW:300,baseH:200,color:'#68b6ee'});state.nodes.unshift(shape);state.selected=shape.id;gesture={mode:'drawshape',p,x:p.x,y:p.y,target:shape.id};vp.setPointerCapture(e.pointerId);renderAll();return}if(state.mode==='clip-delete'){if(hit?.node?.type==='cutout'){checkpoint();removeNode(state.nodes,hit.node.id);state.selected=null;renderAll()}else notify('切り抜きクリップをクリックしてください');return}
  if(['select','resize','clip-stretch','rotate-object'].includes(state.mode)){
    if(!hit){if(state.mode==='select')select(null);return}
    if(['select','resize','clip-stretch','rotate-object'].includes(state.mode))state.selected=hit.node.id;
    const target=selected();const inv=ancestorMatrix(target.id).inverse();const loc=new DOMPoint(p.x,p.y).matrixTransform(inv);
    checkpoint();gesture={mode:state.mode,p:loc,x:target.x,y:target.y,w:target.w,h:target.h,rotation:target.rotation,target:target.id,moved:false};vp.setPointerCapture(e.pointerId);renderProps();renderTimeline();paintImmediate();return
  }
  if(!n||!['video','cutout'].includes(n.type))return notify('先に動画レイヤーを選択してください');
  const entry=renderer.hitEntries.find(e=>e.node.id===n.id);if(!entry)return notify('この時間には動画が表示されていません');
  const point=renderer.localPoint(entry,p.x,p.y);
  if(PATH_MODES.includes(state.mode)){const now=performance.now(),dbl=lastPathDown&&now-lastPathDown.t<500&&Math.hypot(e.clientX-lastPathDown.x,e.clientY-lastPathDown.y)<8;
    lastPathDown=dbl?null:{t:now,x:e.clientX,y:e.clientY};if(dbl){gesture=null;finishPolygon();return}
    if(pathTarget&&pathTarget!==n.id)polygonPoints=[];pathTarget=n.id;polygonPoints.push(point);
    pathDraft(point);paintImmediate();return}
  if(hit?.node.id!==n.id&&!renderer.hitEntries.some(e=>e.node.id===n.id))return;
  state.draft={type:state.mode,points:[point,point]};gesture={mode:'mask',target:n.id};vp.setPointerCapture(e.pointerId);paintImmediate()
});
vp.addEventListener('pointermove',e=>{
  // Green line from the last vertex to the cursor, following the mouse.
  if(PATH_MODES.includes(state.mode)&&polygonPoints.length&&!gesture){const entry=renderer.hitEntries.find(x=>x.node.id===pathTarget);if(!entry)return;const p=screenPt(e);
    pathDraft(renderer.localPoint(entry,p.x,p.y));paintImmediate();return}
  if(!gesture)return;const n=selected(),p=screenPt(e);if(gesture.mode==='drawshape'){const target=findNode(state.nodes,gesture.target)?.node;if(!target)return;target.x=Math.min(p.x,gesture.x);target.y=Math.min(p.y,gesture.y);target.w=Math.max(2,Math.abs(p.x-gesture.x));target.h=Math.max(2,Math.abs(p.y-gesture.y));paintImmediate();return}
  if(['select','resize','clip-stretch','rotate-object'].includes(gesture.mode)){
    const target=findNode(state.nodes,gesture.target)?.node;if(!target)return;const loc=new DOMPoint(p.x,p.y).matrixTransform(ancestorMatrix(target.id).inverse());const dx=loc.x-gesture.p.x,dy=loc.y-gesture.p.y;if(Math.hypot(dx,dy)<2&&!gesture.moved)return;gesture.moved=true;
    if(gesture.mode==='select'){target.x=gesture.x+dx;target.y=gesture.y+dy}else if(gesture.mode==='rotate-object'){target.rotation=gesture.rotation-dy*.6}else if(gesture.mode==='clip-stretch'){target.w=Math.max(15,gesture.w+dx);target.h=Math.max(15,gesture.h+dy)}else{target.w=Math.max(15,gesture.w+dx);target.h=$('keepProportions').checked?Math.max(15,target.w*gesture.h/Math.max(1,gesture.w)):Math.max(15,gesture.h+dy)}
    paintImmediate();return
  }
  const entry=renderer.hitEntries.find(e=>e.node.id===gesture.target);if(!entry||!state.draft)return;const q=renderer.localPoint(entry,p.x,p.y);
  if(state.mode==='freehand'){const pts=state.draft.points,last=pts[pts.length-1];if(Math.hypot((q.x-last.x)*n.baseW,(q.y-last.y)*n.baseH)>3)pts.push(q)}else state.draft.points[1]=q;paintImmediate()
});
// The browser's own double-click also closes the polygon; its second click may have added a vertex on top of the last one.
vp.addEventListener('dblclick',()=>{if(!PATH_MODES.includes(state.mode)||!polygonPoints.length)return;const n=findNode(state.nodes,pathTarget)?.node,a=polygonPoints.at(-1),b=polygonPoints.at(-2);
  if(n&&b&&Math.hypot((a.x-b.x)*n.baseW,(a.y-b.y)*n.baseH)<6)polygonPoints.pop();lastPathDown=null;gesture=null;finishPolygon()});
vp.addEventListener('pointerup',()=>{if(!gesture)return;const mode=gesture.mode;gesture=null;if(mode==='mask'){
  const d=state.draft;state.draft=null;if(d&&d.points.length>=2)addCutout(d)
}else renderAll()});vp.addEventListener('pointercancel',()=>{gesture=null;state.draft=null;paintImmediate()});
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));$('finishShape').onclick=finishPolygon;$('cancelShape').onclick=()=>{setMode('clip-delete');notify('削除対象の切り抜きクリップをキャンバスでクリックしてください')};
function jump(delta){state.t=clamp(state.t+delta,0,state.total);if(state.playing)playOrigin=performance.now()-state.t*1000/state.previewRate;updateClock();requestPaint();syncAudio();refreshPlaybackButtons()}
// Playback sound for audio layers and for the soundtrack of video layers.
// The renderer's <video> elements stay muted. Sound normally comes from AudioMix (Web Audio, scheduled on the
// audio clock); a layer whose sound is not decoded (yet), is too long, or plays at a speed other than 1× uses
// an <audio> element ("voice") kept in step from script instead.
const voices=new Map(),mix=new AudioMix();let mixSig='';
// An MP4's sound-only copy is used once ready: the element then does not read through the whole video file.
function voiceFor(n,asset){const url=mix.audioUrl(asset)||asset.url;let v=voices.get(n.id);if(v&&v.dataset.url!==url){v.pause();v.removeAttribute('src');v.load();v=null}
  if(!v){v=new Audio();v.preload='auto';v.src=url;v.dataset.url=url;voices.set(n.id,v)}return v}
// Muted layers, and layers under a hidden visual layer, are silent. An audio layer's own visibility is ignored.
function audible(n){if(n.mute)return false;for(let info=findNode(state.nodes,n.id);info;info=info.parent?findNode(state.nodes,info.parent.id):null)if(info.node.type!=='audio'&&!info.node.visible)return false;return true}
// What should sound: buffer pieces for AudioMix (timeline start, length, offset in the file) and the layers
// left to media elements. sig changes whenever the pieces do, which is when AudioMix must be rescheduled.
function audioPlan(){const pieces=[],elementIds=new Set(),keys=[];
  walk(state.nodes,n=>{if(n.type!=='audio'&&n.type!=='video')return;if(!audible(n))return;const m=timeMap(n);
    // Each piece may come from its own file (pieces moved in from another layer).
    const sounds=m.segments.map(seg=>{const asset=state.assets.get(seg.sourceId||n.sourceId);if(!asset?.url||!['audio','video'].includes(asset.type))return null;mix.prepare(asset);return{asset,buffer:mix.buffer(asset)}});
    if(!sounds.some(Boolean))return;
    if(sounds.some(x=>x&&!x.buffer)||m.speed!==1||state.previewRate!==1){elementIds.add(n.id);keys.push('e'+n.id);return}
    const g=globalStart(n.id);
    m.segments.forEach((s,k)=>{if(!sounds[k])return;const {asset,buffer}=sounds[k];let parts=[[Math.max(0,s.start),Math.min(n.duration,s.start+s.duration)]];
      for(const [a,b] of m.cuts)parts=parts.flatMap(([x,y])=>b<=x||a>=y?[[x,y]]:[[x,Math.max(x,a)],[Math.min(y,b),y]]).filter(([x,y])=>y-x>1e-4);
      for(const [x,y] of parts){const piece={buffer,start:g+x,duration:y-x,offset:s.inPoint+(x-s.start)};pieces.push(piece);keys.push(`${asset.id}:${piece.start.toFixed(4)}:${piece.duration.toFixed(4)}:${piece.offset.toFixed(4)}`)}})});
  return{pieces,elementIds,sig:keys.join('|')}}
function syncAudio(){const live=new Set(),plan=audioPlan();
  if(!state.playing){if(mixSig){mix.stop();mixSig=''}}
  else{const heard=mix.timeNow();if(mixSig&&heard!=null&&Math.abs(heard-state.t)>.15)mixSig='';
    if(plan.sig!==mixSig){mix.start(plan.pieces,state.t);mixSig=plan.sig}}
  if(state.playing)walk(state.nodes,n=>{if(!plan.elementIds.has(n.id))return;
    const local=state.t-globalStart(n.id);if(local<0||local>=n.duration)return;
    const at=sourceAt(n,local);if(!at)return;const time=at.time;
    const asset=state.assets.get(at.sourceId);if(!asset?.url||!['audio','video'].includes(asset.type))return;
    const p=voiceFor(n,asset),media=clamp(time,0,asset.duration||10);live.add(n.id);if(p.muted!==state.masterMute)p.muted=state.masterMute;
    // Small drift is absorbed by playing 4% faster or slower (no gap in the sound); only a large one jumps.
    // Settings are touched only when they change: re-assigning them every frame makes Safari's audio stutter.
    const base=clamp((n.speed||1)*state.previewRate,.0625,16);let rate=base;
    if(p.paused){p.currentTime=media;p.startedAt=performance.now();p.play().catch(()=>{})}
    else if(!p.seeking&&p.readyState>=3&&performance.now()-(p.startedAt||0)>600){const drift=p.currentTime-media;
      if(Math.abs(drift)>.5){p.currentTime=media;p.startedAt=performance.now()}else if(Math.abs(drift)>.04)rate=base*(drift>0?.96:1.04)}
    if(Math.abs(p.playbackRate-rate)>1e-3)p.playbackRate=rate
  });
  // Silence everything else; release players whose layer was deleted.
  for(const [nodeId,p] of voices){if(live.has(nodeId))continue;p.pause();if(!findNode(state.nodes,nodeId)){p.removeAttribute('src');p.load();voices.delete(nodeId)}}
}
// Master mute keeps every player running in sync; it only silences the output.
state.masterMute=false;
$('masterMute').onclick=()=>{state.masterMute=!state.masterMute;const b=$('masterMute');setIcon(b,state.masterMute?'volumeOff':'volume',{tip:state.masterMute?'全ミュート中\nクリックで音声を戻す':'全ミュート\nすべての音声をミュート'});b.classList.toggle('active',state.masterMute);b.setAttribute('aria-pressed',String(state.masterMute));for(const p of voices.values())p.muted=state.masterMute;mix.setMuted(state.masterMute)};
function refreshPlaybackButtons(){ setIcon($('togglePlay'),state.playing?'pause':'play',{tip:state.playing?'一時停止':'再生'});$('stopPlay').classList.toggle('hidden',!state.playing&&state.t===0) }
// While AudioMix is sounding, the playhead follows the audio clock (picture and sound stay together); the page clock
// (playOrigin) is pulled along with it. A jump of the page clock (seek while playing) reschedules the sound instead.
async function playLoop(now){if(!state.playing)return;let t=(now-playOrigin)/1000*state.previewRate;const heard=mixSig?mix.timeNow():null;
  if(heard!=null){if(Math.abs(heard-t)>.15)mixSig='';else{t=heard;playOrigin=now-t*1000/state.previewRate}}
  state.t=clamp(t,0,state.total);if(state.t>=state.total){state.playing=false;refreshPlaybackButtons();syncAudio();updateClock();requestPaint();return}
  if(now-lastPaint>=1000/FPS){lastPaint=now;updateClock();syncAudio();await renderer.render(state.nodes,bookmarkPreview??state.t,state.selected,state.draft,true,state.previewRate).catch(()=>{})}if(state.playing)requestAnimationFrame(playLoop)
}
function togglePlay(){if(!state.playing&&state.t>=state.total)state.t=0;state.playing=!state.playing;if(state.playing)mix.unlock();refreshPlaybackButtons();if(state.playing){playOrigin=performance.now()-state.t*1000/state.previewRate;requestAnimationFrame(playLoop)}else{syncAudio();requestPaint()}}
function stopPlayback(){state.playing=false;state.t=0;syncAudio();updateClock();requestPaint();refreshPlaybackButtons()}
$('togglePlay').onclick=togglePlay;$('stopPlay').onclick=stopPlayback;$('home').onclick=()=>jump(-state.total);$('end').onclick=()=>jump(state.total);$('stepBack').onclick=()=>jump(-Math.max(.01,Number($('jump').value)||5));$('stepForward').onclick=()=>jump(Math.max(.01,Number($('jump').value)||5));$('seek').oninput=e=>{state.t=Number(e.target.value);if(state.playing)playOrigin=performance.now()-state.t*1000/state.previewRate;updateClock();requestPaint();syncAudio();refreshPlaybackButtons()};
$('playheadTime').addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();const seconds=Number(e.currentTarget.value);if(!Number.isFinite(seconds)||seconds<0){notify('再生位置には0以上の秒数を入力してください');return}state.t=clamp(seconds,0,state.total);if(state.playing)playOrigin=performance.now()-state.t*1000/state.previewRate;updateClock();renderRuler();requestPaint();syncAudio();e.currentTarget.blur()});
$('jumpPreset').onchange=e=>{if(e.target.value!=='custom')$('jump').value=e.target.value;else $('jump').focus()};
$('jump').oninput=()=>{const v=String(Number($('jump').value));$('jumpPreset').value=['1','5','10','30'].includes(v)?v:'custom'};
window.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA'].includes(document.activeElement.tagName))return;
  // While a polygon is open: Esc discards it, Delete/Backspace removes the last point, Enter closes it.
  if(PATH_MODES.includes(state.mode)&&polygonPoints.length){if(e.key==='Escape'){e.preventDefault();cancelPath();return}
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();polygonPoints.pop();if(!polygonPoints.length)pathTarget=null;pathDraft(state.draft?.cursor||null);paintImmediate();return}
    if(e.key==='Enter'){e.preventDefault();finishPolygon();return}}
  if(e.code==='Space'){e.preventDefault();togglePlay()}if(e.key==='Delete'&&(selected()||state.selectedObject))deleteSelection()});
$('deleteLayer').onclick=deleteSelection;$('duplicate').onclick=()=>{const f=findNode(state.nodes,state.selected);if(!f)return;const c=cloneNode(f.node);c.x+=22;c.y+=22;f.list.unshift(c);state.selected=c.id;renderAll()};
// Keep only layer time [from,to) of n, moved to start at 0: its pieces, hidden ranges and children are cut to match.
function sliceLayer(n,from,to){const k=n.speed||1;
  if(n.segments?.length)n.segments=n.segments.flatMap(s=>{const a=Math.max(s.start,from),b=Math.min(s.start+s.duration,to);return b-a>1e-6?[{...s,start:a-from,duration:b-a,inPoint:s.inPoint+(a-s.start)*k}]:[]});
  else n.inPoint=(n.inPoint||0)+from*k;
  if(n.cutRanges?.length)n.cutRanges=n.cutRanges.map(([a,b])=>[Math.max(a,from)-from,Math.min(b,to)-from]).filter(([a,b])=>b-a>1e-6);
  n.children=n.children.filter(c=>c.start<to&&c.start+c.duration>from);
  for(const c of n.children){const cut=from-c.start;if(cut>0){sliceLayer(c,cut,c.duration);c.start=0}else c.start-=from}
  n.duration=to-from}
$('split').onclick=()=>{const f=findNode(state.nodes,state.selected);if(!f)return;const n=f.node,offset=state.t-globalStart(n.id);if(offset<=.05||offset>=n.duration-.05)return notify('クリップの内側に再生位置を移動してください');
  const has=(a,b)=>!n.segments?.length||n.segments.some(s=>Math.min(s.start+s.duration,b)-Math.max(s.start,a)>1e-6);if(!has(0,offset)||!has(offset,n.duration))return notify('分割すると片方が空になります。区間のある位置で分割してください');
  checkpoint();const c=cloneNode(n),end=n.duration;sliceLayer(n,0,offset);sliceLayer(c,offset,end);c.start=n.start+offset;f.list.splice(f.list.indexOf(n)+1,0,c);state.selected=c.id;renderAll()};

// A child that plays its parent's media through the parent's edits (cutouts, detached audio...).
function isLinkedTo(parent,n){return !!parent&&n.editLinked!==false&&!!n.sourceId&&n.sourceId===parent.sourceId&&['video','cutout','audio'].includes(n.type)}
// How a layer's own time maps onto its source media, following linked parents up the tree:
// pieces {start,duration,inPoint} in layer time, playback speed, and removed (hidden) ranges.
function timeMap(n){const parent=findNode(state.nodes,n.id)?.parent;
  if(!isLinkedTo(parent,n))return{segments:(n.segments?.length?n.segments:[{start:0,duration:n.duration,inPoint:n.inPoint||0}]).map(s=>({...s})),speed:n.speed||1,cuts:(n.cutRanges||[]).map(r=>[...r])};
  const m=timeMap(parent),from=n.start,to=n.start+n.duration,segments=[];
  for(const s of m.segments){const a=Math.max(s.start,from),b=Math.min(s.start+s.duration,to);if(b-a>1e-6)segments.push({start:a-from,duration:b-a,inPoint:s.inPoint+(a-s.start)*m.speed,...(s.sourceId?{sourceId:s.sourceId}:{})})}
  return{segments,speed:m.speed,cuts:m.cuts.map(([a,b])=>[Math.max(a,from)-from,Math.min(b,to)-from]).filter(([a,b])=>b>a)}}
// Before a linked child leaves its parent (or stops following it), copy the parent's edits into
// the child so it keeps showing exactly what it showed, instead of reverting to the raw source.
function bakeLink(n){const parent=findNode(state.nodes,n.id)?.parent;if(!isLinkedTo(parent,n))return false;const m=timeMap(n);n.editLinked=false;
  if(!m.segments.length)return true;// never visible through the parent: nothing to keep
  n.speed=m.speed;n.cutRanges=m.cuts;
  if(m.segments.length===1&&m.segments[0].start<1e-6){n.inPoint=m.segments[0].inPoint;n.duration=m.segments[0].duration;delete n.segments}
  else{n.segments=m.segments;n.duration=Math.max(...m.segments.map(s=>s.start+s.duration))}
  return true}
// The pieces are drawn separately unless the layer is one piece covering its whole length.
function showsPieces(n){const s=n.segments||[];return s.length>1||s.length===1&&(s[0].start>1e-6||Math.abs(s[0].start+s[0].duration-n.duration)>1e-6)}
// Timeline objects: each cut piece of a layer, or the whole clip when it has no pieces (index null).
state.objectMode=false;state.selectedObject=null;
function isObjectSelected(n,index){const o=state.selectedObject;return state.objectMode&&!!o&&o.nodeId===n.id&&o.index===index}
function objectRiders(n,segment){const eps=1e-6;return n.children.filter(c=>!isLinkedTo(n,c)&&c.start>=segment.start-eps&&c.start+c.duration<=segment.start+segment.duration+eps)}
// Object mode: drag an object (a piece, or a whole clip) onto another layer of the same type to move it there.
// The piece keeps its file, in-point and time on screen; the target layer grows to hold it if needed.
const OBJECT_MOVE_TYPES=['video','image','audio'];let dropRow=null;
function canMoveObject(src,dst){return !!dst&&dst.id!==src.id&&dst.type===src.type&&OBJECT_MOVE_TYPES.includes(src.type)}
function objectDropTarget(n,ev){if(!state.objectMode)return null;const row=document.elementFromPoint(ev.clientX,ev.clientY)?.closest?.('.tlrow'),dst=row&&findNode(state.nodes,row.dataset.nodeId)?.node,ok=canMoveObject(n,dst)?row:null;
  if(dropRow&&dropRow!==ok)dropRow.classList.remove('object-drop-target');dropRow=ok;ok?.classList.add('object-drop-target');return ok}
function clearDropTarget(){dropRow?.classList.remove('object-drop-target');dropRow=null}
function moveObjectToLayer(srcId,index,dstId){const si=findNode(state.nodes,srcId),di=findNode(state.nodes,dstId),src=si?.node,dst=di?.node;if(!canMoveObject(src,dst))return false;
  let inside=false;walk(src.children,c=>{if(c.id===dst.id)inside=true});if(inside)return notify('自分の子レイヤーには移動できません'),false;
  if(isLinkedTo(si.parent,src)||isLinkedTo(di.parent,dst))return notify('親の動画に連動しているレイヤーとの間では移動できません（連動を外すと移動できます）'),false;
  if((src.speed||1)!==(dst.speed||1))return notify('再生速度が違うレイヤーには移動できません'),false;
  const whole=index==null||!(src.segments||[]).length,seg=whole?{start:0,duration:src.duration,inPoint:src.inPoint||0}:src.segments[index];if(!seg)return false;
  const riders=whole?src.children.filter(c=>!isLinkedTo(src,c)):objectRiders(src,seg),emptied=whole||src.segments.length<=1;
  if(emptied&&src.children.some(c=>!riders.includes(c)))return notify('連動する子レイヤーがあるため、最後のオブジェクトは移動できません'),false;
  const gSrc=globalStart(src.id),G=gSrc+seg.start;let gDst=globalStart(dst.id);
  const occupied=dst.segments?.length?dst.segments:[{start:0,duration:dst.duration}];
  if(occupied.some(s=>G<gDst+s.start+s.duration-1e-6&&G+seg.duration>gDst+s.start+1e-6))return notify('移動先のレイヤーには、その時間に別のオブジェクトがあります'),false;
  const riderStarts=riders.map(c=>[c,gSrc+c.start]);
  if(!dst.segments?.length)dst.segments=[{start:0,duration:dst.duration,inPoint:dst.inPoint||0}];
  let local=G-gDst;if(local<0){const d=-local;dst.start-=d;gDst-=d;dst.duration+=d;for(const s of dst.segments)s.start+=d;dst.cutRanges=(dst.cutRanges||[]).map(([a,b])=>[a+d,b+d]);for(const c of dst.children)c.start+=d;local=0}
  const piece={start:local,duration:seg.duration,inPoint:seg.inPoint||0};const sid=seg.sourceId||src.sourceId;if(sid!==dst.sourceId)piece.sourceId=sid;if(seg.label)piece.label=seg.label;
  // Hidden ranges of the target that fall where the piece lands would hide it: drop those parts.
  if(dst.cutRanges?.length)dst.cutRanges=dst.cutRanges.flatMap(([a,b])=>b<=local||a>=local+piece.duration?[[a,b]]:[[a,Math.min(b,local)],[Math.max(a,local+piece.duration),b]]).filter(([a,b])=>b-a>1e-6);
  dst.segments.push(piece);dst.segments.sort((a,b)=>a.start-b.start);dst.duration=Math.max(dst.duration,local+piece.duration);
  for(const [c,g] of riderStarts){src.children.splice(src.children.indexOf(c),1);c.start=g-gDst;dst.children.push(c)}
  if(emptied)removeNode(state.nodes,src.id);else{src.segments.splice(index,1);src.duration=Math.max(.1,...src.segments.map(s=>s.start+s.duration))}
  state.selected=dst.id;state.selectedObject={nodeId:dst.id,index:dst.segments.indexOf(piece)};notify(`「${dst.name}」へ移動しました（Undoで戻せます）`);return true}
function setObjectMode(on){state.objectMode=on;state.selectedObject=null;const b=$('objectMode');b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));
  if(on)notify('オブジェクト選択：クリックで選択、ドラッグで移動、Deleteキーで削除');renderTimeline()}
$('objectMode').onclick=()=>setObjectMode(!state.objectMode);
// Deleting a piece takes its unlinked children with it; linked children lose that part automatically.
function deleteObject(){const o=state.selectedObject,info=o&&findNode(state.nodes,o.nodeId),n=info?.node;if(!n)return false;
  if(o.index==null||(n.segments||[]).length<=1){deleteSelectedLayer(n.id);return true}
  const segment=n.segments[o.index];if(!segment)return false;
  for(const c of objectRiders(n,segment))n.children.splice(n.children.indexOf(c),1);
  n.segments.splice(o.index,1);n.duration=Math.max(.1,...n.segments.map(s=>s.start+s.duration));
  state.selectedObject=null;renderer.invalidate();renderAll();notify('オブジェクトを削除しました');return true}
function deleteSelectedLayer(nodeId){removeNode(state.nodes,nodeId);if(state.selected===nodeId)state.selected=null;state.selectedObject=null;renderer.invalidate();renderAll()}
function deleteSelection(){checkpoint();if(state.objectMode&&state.selectedObject)deleteObject();else if(state.selected)deleteSelectedLayer(state.selected)}
function linkedChildren(parent){return (parent.children||[]).filter(c=>c.editLinked!==false && ['cutout','video'].includes(c.type))}
function propagateParentCut(parent,position){
 for(const child of linkedChildren(parent)){
  const at=position-child.start;if(at<=.001||at>=child.duration-.001)continue;
  if(!child.segments?.length)child.segments=[{start:0,duration:child.duration,inPoint:child.inPoint}];
  const index=child.segments.findIndex(s=>at>s.start+.001&&at<s.start+s.duration-.001);
  if(index<0)continue;const seg=child.segments[index],len=at-seg.start;
  child.segments.splice(index,1,{...seg,duration:len},{...seg,start:at,duration:seg.duration-len,inPoint:seg.inPoint+len*child.speed});
  propagateParentCut(child,at);
 }
}
function propagateSegmentMove(parent,oldStart,newStart,source){
 const delta=newStart-oldStart;if(Math.abs(delta)<1e-6)return;
 for(const child of linkedChildren(parent)){
  const seg=(child.segments||[]).find(s=>Math.abs(s.start-(oldStart-child.start))<.035 && Math.abs(s.inPoint-source)<.1);
  if(seg){seg.start=Math.max(0,seg.start+delta);child.duration=Math.max(child.duration,...child.segments.map(s=>s.start+s.duration));}
  else if(!child.segments?.length && Math.abs(oldStart)<.035){child.start+=delta;}
  propagateSegmentMove(child,oldStart-child.start,newStart-child.start,source);
 }
}

$('cutWithin').onclick=()=>{
  const n=selected();if(!n)return notify('カットするレイヤーを選択してください');
  const at=state.t-globalStart(n.id);
  if(at<=.05||at>=n.duration-.05)return notify('対象クリップの内側に再生位置を移動してください');
  checkpoint();
  if(!Array.isArray(n.segments)||!n.segments.length){
    n.segments=[{start:0,duration:n.duration,inPoint:n.inPoint}];
  }
  const index=n.segments.findIndex(seg=>at>seg.start+.001&&at<seg.start+seg.duration-.001);
  if(index<0)return notify('すでにカットされた位置です');
  const seg=n.segments[index],leftLength=at-seg.start;
  const before={...seg,duration:leftLength};
  const after={...seg,start:at,duration:seg.duration-leftLength,inPoint:seg.inPoint+leftLength*n.speed};
  n.segments.splice(index,1,before,after);
  for(const child of linkedChildren(n)){child.duration=Math.max(child.duration,n.duration);}
  renderAll();notify('同一レイヤー内でカットしました。区間を個別にドラッグできます');
};
function renderRemovalPreview(lane,range){let el=lane.querySelector('.removal-preview');if(!el){el=document.createElement('span');el.className='removal-preview';lane.append(el)}if(!range){el.style.display='none';return}const a=Math.min(range.from,range.to),b=Math.max(range.from,range.to);el.style.display='block';el.style.left=((a-range.offset)/range.max*100)+'%';el.style.width=((b-a)/range.max*100)+'%'}
function removalClick(t,nodeId=null){
  const n=selected();if(!n){notify('先に除去対象のレイヤーを選択してください');return}
  if(nodeId&&nodeId!==n.id){notify('選択中のレイヤー上で除去位置をクリックしてください');return}
  const local=t-globalStart(n.id);
  if(local<0||local>n.duration){notify('選択レイヤーの表示時間内をクリックしてください');return}
  if(removalStart===null){removalStart=local;removalNodeId=n.id;removalHover=t;notify('開始位置を設定しました。終了位置をクリックしてください');return}
  if(removalNodeId!==n.id){removalStart=local;removalNodeId=n.id;notify('開始位置を再指定しました');return}
  const a=Math.min(removalStart,local),b=Math.max(removalStart,local);
  if(b-a<0.01){notify('開始位置と異なる終了位置をクリックしてください');return}
  checkpoint();n.cutRanges=[...(n.cutRanges||[]),[a,b]];removalActive=false;removalStart=null;removalNodeId=null;
  $('removeWithin').classList.remove('active');renderAll();notify(`${a.toFixed(2)}秒〜${b.toFixed(2)}秒を除去しました（時間は詰めません）`)
}
$('removeWithin').onclick=()=>{if(!selected())return notify('除去するレイヤーを選択してください');bookmarkActive=false;bookmarkPreview=null;$('bookmarkMode').classList.remove('active');setIcon($('bookmarkMode'),'bookmark');removalActive=!removalActive;removalStart=null;removalNodeId=null;$('removeWithin').classList.toggle('active',removalActive);notify(removalActive?'タイムライン上で開始点と終了点を順にクリックしてください':'除去操作を解除しました')};

$('detachAudio').onclick=()=>{const n=selected(),asset=n&&state.assets.get(n.sourceId);if(!n||n.type!=='video'||!asset?.file)return notify('動画レイヤーを選択してください');const audio=node('audio',{name:n.name+'（音声）',sourceId:n.sourceId,start:0,duration:n.duration,x:0,y:0,w:n.w,h:n.h,baseW:n.w,baseH:n.h,children:[]});audio.editLinked=true;n.children.push(audio);n.mute=true;state.selected=audio.id;renderAll();ensureWaveform(asset).catch(e=>console.warn('音声波形',e));notify('親動画に連動する音声レイヤーを作成しました。波形を解析します')};
$('relinkAudio').onclick=()=>{const f=findNode(state.nodes,state.selected);if(!f||f.node.type!=='audio')return notify('音声レイヤーを選択してください');const video=state.nodes.find(x=>x.type==='video');if(!video)return notify('結合先の最上位動画レイヤーがありません');const currentTime=globalStart(f.node.id);if(f.parent!==video)bakeLink(f.node);const n=removeNode(state.nodes,f.node.id);n.start=Math.max(0,currentTime-globalStart(video.id));video.children.push(n);state.selected=n.id;renderAll();notify('音声を動画の子レイヤーへ移動しました（音声ファイル自体の合成ではありません）')};
$('canvasSettingsToggle').onclick=()=>{const show=$('canvasSettings').classList.contains('hidden');if(show&&!$('speedSettings').classList.contains('hidden'))toggleSpeedPanel(false);$('canvasSettings').classList.toggle('hidden',!show);$('props').classList.add('hidden');$('emptySelection').classList.add('hidden');$('selectedType').textContent=show?'キャンバスサイズ':'オブジェクト';if(!show)renderProps()};$('canvasSettings').classList.add('hidden');
$('viewPlus').onclick=()=>{state.zoom=clamp(state.zoom*1.25,.2,5);layout()};$('viewMinus').onclick=()=>{state.zoom=clamp(state.zoom/1.25,.2,5);layout()};$('viewFit').onclick=()=>{state.zoom=1;layout()};
function updateScaleFromSlider(){const v=Number($('timelineScaleSlider').value);const visible=Math.pow(10, v/100*Math.log10(3600/.1))*.1;state.timelineSpan=visible;state.timelineOffset=clamp(state.timelineOffset||0,0,timelineMaxOffset());$('timelineUnits').value=Math.max(1,Math.round(visible/state.rulerUnit));renderTimeline();followPlayhead(true)}
$('timelineScaleSlider').oninput=updateScaleFromSlider;
function adjustTimelineUnits(){state.timelineUnits=clamp(Math.round(Number($('timelineUnits').value)||10),1,1000);state.timelineSpan=state.timelineUnits*state.rulerUnit;state.timelineOffset=clamp(state.timelineOffset||0,0,timelineMaxOffset());$('timelineScaleSlider').value=Math.round(clamp(Math.log10(state.timelineSpan/.1)/Math.log10(3600/.1)*100,0,100));renderTimeline();followPlayhead(true)}
$('rulerUnit').onchange=e=>{state.rulerUnit=Number(e.target.value);adjustTimelineUnits()};$('timelineUnits').onchange=adjustTimelineUnits;
// Furthest scroll position: the end of the last clip (children included) at the right edge.
function timelineMaxOffset(){let last=state.total;walk(state.nodes,n=>{last=Math.max(last,globalStart(n.id)+n.duration)});return Math.max(0,last-timelineSpanNow())}
function updateTimelinePan(){const max=timelineMaxOffset();state.timelineOffset=clamp(state.timelineOffset||0,0,max);$('timelinePan').max=max;$('timelinePan').value=state.timelineOffset;$('timelinePan').disabled=max===0}
$('timelinePan').oninput=e=>{state.timelineOffset=Number(e.target.value)||0;renderTimeline()};
$('timelineBody').addEventListener('wheel',e=>{if(Math.abs(e.deltaX)>0||e.shiftKey){const visible=state.timelineSpan||state.total/state.tlScale;const delta=(Math.abs(e.deltaX)>0?e.deltaX:e.deltaY)/Math.max(1,$('timelineBody').clientWidth)*visible;state.timelineOffset=clamp((state.timelineOffset||0)+delta,0,timelineMaxOffset());renderTimeline();e.preventDefault()}},{passive:false});

vp.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();state.zoom=clamp(state.zoom*(e.deltaY<0?1.12:.9),.2,5);layout()}},{passive:false});
for(const id of ['timelineUndo'])$(id).onclick=doUndo;
for(const id of ['timelineRedo'])$(id).onclick=doRedo;
let canvasSettingsActive=false;
$('canvasSettings').classList.add('hidden');
$('canvasPreset').onchange=e=>{if(e.target.value==='custom')return;const [w,h]=e.target.value.split('x').map(Number);checkpoint();applyCanvasSize(w,h)};
$('applyCanvasSize').onclick=()=>{const w=Number($('customWidth').value),h=Number($('customHeight').value);if(!Number.isFinite(w)||!Number.isFinite(h)||w<16||h<16)return notify('キャンバスの幅・高さは16以上を指定してください');checkpoint();applyCanvasSize(w,h)};
// Keep a shared undo stack for changes made from either workspace.
document.addEventListener('pointerdown',e=>{const el=e.target.closest('button,input,select,textarea,.tlclip,.tlname');if(!el)return;if(el.closest('.timeline-toolbar,.inspector,.modes,.timelinebody')){if(el.closest('.inspector')||(!['timelineUndo','timelineRedo','canvasUndo','canvasRedo'].includes(el.id)&&!el.closest('.viewheader')))checkpoint()}},true);
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();if(e.shiftKey)doRedo();else doUndo()}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();doRedo()}});
updateHistoryButtons();

$('addText').onclick=()=>create('text',null,state.attachToSelection?state.selected:null);$('addShape').onclick=()=>create('shape',null,state.attachToSelection?state.selected:null);
for(const [b,m] of [['fileMenuButton','fileMenu'],['importMenuButton','importMenu'],['clipMenuButton','clipMenu']]){$(b).onclick=e=>{e.stopPropagation();for(const other of ['fileMenu','importMenu','clipMenu'])if(other!==m)$(other).classList.add('hidden');$(m).classList.toggle('hidden')}}
document.addEventListener('click',e=>{if(!e.target.closest('.menu-wrap'))for(const m of ['fileMenu','importMenu','clipMenu'])$(m).classList.add('hidden')});
$('addSelectedAsset').onclick=async()=>{const item=state.files.find(x=>x.path===state.selectedFilePath);if(!item)return;let asset=[...state.assets.values()].find(a=>a.file===item.file);if(/\.lkv$/i.test(item.file.name)){await importLkv(item.file,item.path,true);return}if(isFlv(item.file))asset=await importFlv(item.file,item.path);else if(!asset)asset=importAsset(item.file,item.path,false);if(asset)create(asset.type,asset,state.attachToSelection?state.selected:null)};
$('removeSelectedAsset').onclick=()=>{if(state.selectedOnlineId){state.onlineRefs=state.onlineRefs.filter(x=>x.id!==state.selectedOnlineId);state.selectedOnlineId=null;renderFileList();touch();return;}const path=state.selectedFilePath;const item=state.files.find(x=>x.path===path);if(!item)return;state.files=state.files.filter(x=>x.path!==path);state.selectedFilePath=null;for(const [id,a] of state.assets)if(a.file===item.file&&!JSON.stringify(state.nodes).includes(id)){releaseDecoder(id);if(a.url)URL.revokeObjectURL(a.url);state.assets.delete(id)}renderFileList();touch()};
// iPad/iPhone pickers only understand file types the system knows, so .lkv (and often .flv) show greyed out when
// the accept list names them. There the picker accepts any file and processIncomingFiles skips what cannot be read.
const IS_IOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
$('chooseFiles').onclick=()=>{if(IS_IOS)$('fileInput').removeAttribute('accept');else $('fileInput').accept='video/*,audio/*,image/*,.lkv,.flv';$('fileInput').click()};
$('importPptx').onclick=()=>{ $('pptxInput').click() };
$('pptxInput').onchange=async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;try{$('status').textContent='PowerPointのスライドを変換中…';const images=await pptxToImages(f);
  // All slides go into ONE image layer, side by side in time: each slide is a 5-second piece with its own image.
  const segments=[];let first=null;for(let i=0;i<images.length;i++){const file=images[i],path=f.name+'/'+file.name;registerFile(file,path);const a=importAsset(file,path,false,null,true);if(!a)continue;first??=a;segments.push({start:segments.length*5,duration:5,inPoint:0,sourceId:a.id,label:'スライド '+(i+1)})}
  if(!segments.length)throw Error('スライドを画像にできませんでした');
  checkpoint();const layer=node('image',{name:f.name+'（スライド）',sourceId:first.id,start:state.t,duration:segments.length*5,x:0,y:0,w:WIDTH,h:HEIGHT,baseW:WIDTH,baseH:HEIGHT,segments});
  state.nodes.unshift(layer);state.selected=layer.id;renderAll();notify(segments.length+'ページを1つのレイヤーに読み込みました')}catch(err){console.error(err);notify('PowerPoint読込失敗: '+err.message)}finally{$('status').textContent=''}};


async function importDroppedAsset(path,targetId=null){const item=state.files.find(x=>x.path===path);if(!item)return;if(/\.lkv$/i.test(item.file.name)){await importLkv(item.file,item.path,true);return;}const a=isFlv(item.file)?await importFlv(item.file,item.path):[...state.assets.values()].find(a=>a.file===item.file)||importAsset(item.file,item.path,false);if(a){checkpoint();create(a.type,a,targetId);notify('素材をタイムラインへ追加しました')}}
for(const id of ['timelineBody','timelineRootBottom']){const el=$(id);el.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('application/x-triton-asset')||e.dataTransfer.types.includes('application/x-triton-online')){e.preventDefault();e.dataTransfer.dropEffect='copy'}});el.addEventListener('drop',e=>{const path=e.dataTransfer.getData('application/x-triton-asset');const onlineId=e.dataTransfer.getData('application/x-triton-online');if(!path&&!onlineId)return;e.preventDefault();e.stopPropagation();const target=e.target.closest('[data-hierarchy-id]');if(onlineId){checkpoint();addOnlineClip(state.onlineRefs.find(x=>x.id===onlineId),target?.dataset.hierarchyId||null)}else importDroppedAsset(path,target?.dataset.hierarchyId||null)})}
function readingProgress(file,percent){const existing=importingItems.find(x=>x.name===file.name);if(existing)existing.percent=percent;else importingItems.push({name:file.name,percent});renderFileList()}
const readableFile=f=>/^(video|audio|image)\//.test(f.type)||/\.lkv$/i.test(f.name)||isFlv(f);
async function processIncomingFiles(inputFiles,isFolder=false){const skipped=inputFiles.filter(f=>!readableFile(f));inputFiles=inputFiles.filter(readableFile);
 if(skipped.length&&!isFolder)notify(`読み込めない形式のため除外しました: ${skipped.slice(0,3).map(f=>f.name).join('、')}${skipped.length>3?' ほか'+(skipped.length-3)+'件':''}`);
 for(const file of inputFiles){readingProgress(file,5);const path=isFolder?(file.webkitRelativePath||file.name):file.name;try{
 // Reading raw bytes advances the displayed progress; the resulting File keeps its original metadata.
 if(file.stream){const reader=file.stream().getReader();let read=0;while(true){const {done,value}=await reader.read();if(done)break;read+=value.byteLength;readingProgress(file,Math.min(90,Math.round(read/Math.max(1,file.size)*90)));await new Promise(r=>setTimeout(r,0))}}
 readingProgress(file,95);registerFile(file,path);if(/\.lkv$/i.test(file.name))await importLkv(file,path,false);else if(isFlv(file))await importFlv(file,path);else importAsset(file,path,false);
 }catch(err){console.error(err);notify('読込失敗: '+file.name)}finally{importingItems=importingItems.filter(x=>x.name!==file.name);renderFileList()}}
 renderAll()}
// Files dragged in from Windows Explorer / Finder are imported like "＋ ファイル" (FLV is converted).
document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy'}});
document.addEventListener('drop',e=>{const files=[...(e.dataTransfer?.files||[])];if(!files.length||e.dataTransfer.types.includes('application/x-triton-asset'))return;e.preventDefault();processIncomingFiles(files)});
$('fileInput').onchange=async e=>{const files=[...e.target.files];e.target.value='';await processIncomingFiles(files)};
$('chooseFolder').onclick=async()=>{if('showDirectoryPicker'in window){try{const handle=await window.showDirectoryPicker();await scanDirectory(handle,handle.name+'/');state.path=handle.name;renderFileList();await convertListedFlv()}catch(e){if(e.name!=='AbortError')notify('フォルダ選択に失敗しました')}return}$('folderInput').click()};
$('folderInput').onchange=async e=>{const entries=[...e.target.files];e.target.value='';await processIncomingFiles(entries,true);const first=entries[0];if(first?.webkitRelativePath)state.path=first.webkitRelativePath.split('/')[0];renderFileList()};

// Browser-native camera, microphone and screen capture. The operating system / browser owns source selection.
const capture={stream:null,output:null,recorder:null,chunks:[],started:0,region:null,drag:null,raf:0,canvas:null,audioContext:null};
const captureDialog=$('captureDialog'),capturePreview=$('capturePreview'),regionOverlay=$('regionOverlay');$('captureMount').appendChild(captureDialog);$('captureDialog').classList.remove('capture-inline');$('captureDialog').classList.add('capture-inspector');
function fillSelect(id,list,fallback){const el=$(id),previous=el.value;el.replaceChildren(new Option(fallback,''));for(const d of list)el.add(new Option(d.label||`${d.kind} ${el.length}`,d.deviceId));if([...el.options].some(o=>o.value===previous))el.value=previous}
async function listInputDevices(){if(!navigator.mediaDevices?.enumerateDevices)return;try{const items=await navigator.mediaDevices.enumerateDevices();fillSelect('captureCamera',items.filter(x=>x.kind==='videoinput'),'既定のカメラ');fillSelect('captureMicrophone',items.filter(x=>x.kind==='audioinput'),'既定のマイク')}catch{}}
function updateCaptureFields(){const kind=$('captureKind').value;for(const [id,show] of Object.entries({cameraField:kind==='camera',micField:kind!=='screen',surfaceField:kind==='screen',micToggleField:kind!=='audio',systemAudioField:kind==='screen',cursorField:kind==='screen',regionField:kind==='screen'}))$(id).classList.toggle('hidden',!show);
  if(kind==='audio')$('captureMicEnabled').checked=true;$('capturePreviewBox').classList.toggle('hidden',kind==='audio');$('capturePrepare').classList.toggle('hidden',kind!=='screen');setIcon($('capturePrepare'),'monitor');$('captureRecord').disabled=!capture.stream}
function releaseCapture(){cancelAnimationFrame(meterAnimation);if($('captureMeter'))$('captureMeter').value=0;cancelAnimationFrame(capture.raf);capture.raf=0;for(const s of [capture.output,capture.stream])s?.getTracks().forEach(t=>t.stop());capture.audioContext?.close().catch(()=>{});capture.audioContext=null;capture.stream=null;capture.output=null;capturePreview.pause();capturePreview.srcObject=null;capture.region=null;capture.recorder=null;capture.drag=null;regionOverlay.getContext('2d').clearRect(0,0,regionOverlay.width,regionOverlay.height);$('captureRecord').disabled=true;$('captureFinish').disabled=true}
$('captureOpen').onclick=async()=>{const opening=captureDialog.classList.contains('hidden');if(!opening){if(capture.recorder?.state==='recording')return notify('先に収録を終了してください');releaseCapture();captureDialog.classList.add('hidden');$('captureMount').classList.add('hidden');$('captureOpen').setAttribute('aria-expanded','false');renderProps();return}captureDialog.classList.remove('hidden');$('captureMount').classList.remove('hidden');$('props').classList.add('hidden');$('emptySelection').classList.add('hidden');$('canvasSettings').classList.add('hidden');$('speedSettings').classList.add('hidden');$('speedButton').classList.remove('active');$('selectedType').textContent='収録設定';$('captureOpen').setAttribute('aria-expanded','true');updateCaptureFields();await listInputDevices();if($('captureKind').value!=='screen')$('capturePrepare').click()};$('captureKind').onchange=()=>{releaseCapture();updateCaptureFields();if($('captureKind').value!=='screen')$('capturePrepare').click();else $('captureStatus').textContent='「画面ソースを選択」を押すとブラウザの共有対象選択画面が開きます。'};for(const id of ['captureCamera','captureMicrophone'])$(id).addEventListener('change',()=>{$('capturePrepare').click()});
$('captureClose').onclick=()=>{if(capture.recorder?.state==='recording')return notify('先に「収録終了・追加」を押してください');releaseCapture();captureDialog.classList.add('hidden');$('captureMount').classList.add('hidden');$('captureOpen').setAttribute('aria-expanded','false');renderProps()};
function captureRegionRect(){const r=capture.region;if(!r)return null;const x=Math.min(r.x,r.x+r.w),y=Math.min(r.y,r.y+r.h),w=Math.abs(r.w),h=Math.abs(r.h);return w>.03&&h>.03?{x,y,w,h}:null}
function drawRegion(){const ctx=regionOverlay.getContext('2d');ctx.clearRect(0,0,640,360);const r=captureRegionRect();if(!r)return;ctx.fillStyle='#050b1577';ctx.fillRect(0,0,640,360);ctx.clearRect(r.x*640,r.y*360,r.w*640,r.h*360);ctx.lineWidth=3;ctx.strokeStyle='#ffd56f';ctx.strokeRect(r.x*640,r.y*360,r.w*640,r.h*360)}
regionOverlay.addEventListener('pointerdown',e=>{if(!$('captureRegion').checked||!capture.stream)return;const b=regionOverlay.getBoundingClientRect(),x=clamp((e.clientX-b.left)/b.width,0,1),y=clamp((e.clientY-b.top)/b.height,0,1);capture.region={x,y,w:0,h:0};capture.drag={x,y};regionOverlay.setPointerCapture(e.pointerId);drawRegion()});
regionOverlay.addEventListener('pointermove',e=>{if(!capture.drag)return;const b=regionOverlay.getBoundingClientRect();capture.region.w=clamp((e.clientX-b.left)/b.width,0,1)-capture.drag.x;capture.region.h=clamp((e.clientY-b.top)/b.height,0,1)-capture.drag.y;drawRegion()});
regionOverlay.addEventListener('pointerup',()=>{capture.drag=null;drawRegion()});
$('captureRegion').onchange=()=>{capture.region=null;drawRegion()};
// A chosen device is requested with `exact`: `ideal` lets the browser silently open another one
// (e.g. when the chosen camera is busy), so the preview never appeared to switch.
const pickDevice=deviceId=>deviceId?{deviceId:{exact:deviceId}}:true;
async function openUserMedia(video,audio){try{return await navigator.mediaDevices.getUserMedia({video,audio})}
  catch(e){if(!['OverconstrainedError','NotFoundError','NotReadableError'].includes(e.name)||(video===true||!video)&&(audio===true||!audio))throw e;
    notify('選択したデバイスを開けないため、既定のデバイスを使います');return navigator.mediaDevices.getUserMedia({video:!!video,audio:!!audio})}}
const trackNames=stream=>[...stream.getVideoTracks(),...stream.getAudioTracks()].map(t=>t.label).filter(Boolean).join(' ／ ');
let prepareRequest=0;
$('capturePrepare').onclick=async()=>{if(!navigator.mediaDevices){notify('localhostまたはHTTPSで開いてください');return}releaseCapture();const kind=$('captureKind').value,request=++prepareRequest;
  try{const mic=$('captureMicrophone').value,camera=$('captureCamera').value,micEnabled=$('captureMicEnabled').checked;let stream;
    if(kind==='screen'){
      stream=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:$('captureSurface').value,cursor:$('captureCursor').checked?'always':'never'},audio:$('captureSystemAudio').checked,systemAudio:$('captureSystemAudio').checked?'include':'exclude',surfaceSwitching:'include',monitorTypeSurfaces:'include'});
      // An optional microphone is acquired separately, without changing the display selection.
      if(micEnabled){try{const voice=await openUserMedia(false,pickDevice(mic));for(const t of voice.getAudioTracks())stream.addTrack(t)}catch{notify('マイクを追加できませんでした（画面のみ収録します）')}}
    }else stream=await openUserMedia(kind==='camera'?pickDevice(camera):false,kind==='audio'||micEnabled?pickDevice(mic):false);
    // A newer device change started while this one was opening: drop this stream.
    if(request!==prepareRequest){stream.getTracks().forEach(t=>t.stop());return}
    capture.stream=stream;const vids=stream.getVideoTracks();capturePreview.srcObject=stream;capturePreview.muted=true;capturePreview.play().catch(()=>{});if(vids.length)vids[0].onended=()=>{if(capture.recorder?.state==='recording')$('captureFinish').click();else releaseCapture()};
    $('captureRecord').disabled=false;const names=trackNames(stream);$('captureStatus').textContent=`入力中${names?'：'+names:''}（音声レベルを表示）`;startCaptureMeter();await listInputDevices()
  }catch(e){if(request!==prepareRequest)return;releaseCapture();$('captureStatus').textContent=`入力を開始できません: ${e.name||e.message}`}}
function recorderMime(audioOnly){const types=audioOnly?['audio/webm;codecs=opus','audio/webm','audio/mp4']:['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];return types.find(t=>MediaRecorder.isTypeSupported(t))||''}
let meterAnimation=0,meterCtx=null;
function startCaptureMeter(){cancelAnimationFrame(meterAnimation);const meter=$('captureMeter');if(!meter||!capture.stream?.getAudioTracks().length)return;try{if(!meterCtx)meterCtx=new (window.AudioContext||window.webkitAudioContext)();const source=meterCtx.createMediaStreamSource(new MediaStream(capture.stream.getAudioTracks()));const analyser=meterCtx.createAnalyser();analyser.fftSize=512;source.connect(analyser);const values=new Uint8Array(analyser.frequencyBinCount);function draw(){if(!capture.stream)return;analyser.getByteTimeDomainData(values);let sum=0;for(const v of values)sum+=((v-128)/128)**2;meter.value=Math.min(100,Math.sqrt(sum/values.length)*230);meterAnimation=requestAnimationFrame(draw)}draw()}catch(e){console.warn('音声レベル計測不可',e)}}
function croppedScreenStream(){const video=capturePreview,crop=captureRegionRect();if(!crop)return null;
  const settings=capture.stream.getVideoTracks()[0]?.getSettings()||{};const vw=video.videoWidth||settings.width||1280,vh=video.videoHeight||settings.height||720;
  const c=document.createElement('canvas');c.width=Math.max(2,Math.round(vw*crop.w));c.height=Math.max(2,Math.round(vh*crop.h));capture.canvas=c;
  const ctx=c.getContext('2d',{alpha:false});const draw=()=>{if(!capture.stream)return;try{ctx.drawImage(video,crop.x*vw,crop.y*vh,crop.w*vw,crop.h*vh,0,0,c.width,c.height)}catch{}capture.raf=requestAnimationFrame(draw)};draw();return c.captureStream(30)
}
$('captureRecord').onclick=()=>{if(!capture.stream||!window.MediaRecorder)return notify('録画に対応していません');const kind=$('captureKind').value,audioOnly=kind==='audio';try{
    if(kind==='screen'&&$('captureRegion').checked&&!captureRegionRect())return notify('プレビューの上で収録範囲をドラッグしてください');
    const cropped=kind==='screen'&&$('captureRegion').checked?croppedScreenStream():null;
    const audioTracks=capture.stream.getAudioTracks();let outputAudio=audioTracks;
    if(audioTracks.length>1){const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw Error('音声のミックスに対応していません');capture.audioContext=new AC();const dest=capture.audioContext.createMediaStreamDestination();for(const track of audioTracks){const source=capture.audioContext.createMediaStreamSource(new MediaStream([track]));source.connect(dest)}outputAudio=dest.stream.getAudioTracks()}
    capture.output=new MediaStream([...(cropped?cropped.getVideoTracks():capture.stream.getVideoTracks()),...outputAudio]);
    const mime=recorderMime(audioOnly);if(!mime)throw Error('対応する録画形式がありません');capture.chunks=[];capture.recorder=new MediaRecorder(capture.output,{mimeType:mime});capture.recorder.ondataavailable=e=>{if(e.data.size)capture.chunks.push(e.data)};
    capture.started=Date.now();capture.recorder.start(250);$('captureRecord').disabled=true;$('capturePrepare').disabled=true;$('captureFinish').disabled=false;$('captureStatus').textContent='● 収録中… 終了すると素材Explorerとタイムラインに追加します'
  }catch(e){cancelAnimationFrame(capture.raf);$('captureStatus').textContent='収録開始失敗: '+e.message}}
$('captureFinish').onclick=async()=>{const rec=capture.recorder;if(!rec||rec.state==='inactive')return;const finished=new Promise(resolve=>{rec.addEventListener('stop',resolve,{once:true})});rec.stop();await finished;
  const audioOnly=$('captureKind').value==='audio',type=rec.mimeType.split(';')[0],ext=type.includes('mp4')?(audioOnly?'m4a':'mp4'):'webm';const name=`${audioOnly?'音声':'収録'}-${new Date(capture.started).toISOString().replace(/[:.]/g,'-')}.${ext}`;
  const file=new File([new Blob(capture.chunks,{type})],name,{type});releaseCapture();$('capturePrepare').disabled=false;registerFile(file,name);importAsset(file,name,true);renderAll();$('captureStatus').textContent=`素材を追加しました: ${name}`;notify('収録ファイルをタイムラインに追加しました。「保存」で作業状態を保存してください')};
const PROJECT_DB='triton-video-studio-local-v3',PROJECT_STORE='projects';
function projectDB(){return new Promise((resolve,reject)=>{if(!('indexedDB'in window))return reject(Error('IndexedDBに対応していません'));const req=indexedDB.open(PROJECT_DB,1);req.onupgradeneeded=()=>req.result.createObjectStore(PROJECT_STORE);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function savedProject(){const db=await projectDB();return new Promise((resolve,reject)=>{const tx=db.transaction(PROJECT_STORE,'readonly'),req=tx.objectStore(PROJECT_STORE).get('current');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);tx.oncomplete=()=>db.close();tx.onerror=()=>db.close()})}
function projectSnapshot(withFiles=true){return{version:5,canvasW:WIDTH,canvasH:HEIGHT,nodes:JSON.parse(JSON.stringify(state.nodes)),assets:[...state.assets.values()].map(a=>({id:a.id,name:a.name,type:a.type,duration:a.duration,width:a.width,height:a.height,path:a.path,file:withFiles?a.file||null:null})),files:withFiles?state.files.map(x=>({path:x.path,file:x.file})):[],onlineRefs:[],bookmarks:bookmarks,t:state.t,selected:state.selected,zoom:state.zoom,tlScale:state.tlScale,timelineOffset:state.timelineOffset||0,timelineSpan:state.timelineSpan||0,showThumbnails:state.showThumbnails,explorerThumbs:state.explorerThumbs,rowHeight:state.rowHeight,rulerUnit:state.rulerUnit,timelineUnits:state.timelineUnits,path:state.path,updatedAt:Date.now()}}
// Each media file is stored once under its own key ('file:…') and the project record (version 6) only names it,
// so saving again — by hand or automatically — writes the edit state plus files added since the last save.
const storedFileKeys=new WeakMap();let fileKeySeq=0,writtenFileKeys=new Set(),saveChain=Promise.resolve();
function fileKeyOf(file){let key=storedFileKeys.get(file);if(!key){key=`file:${Date.now().toString(36)}-${(fileKeySeq++).toString(36)}-${Math.random().toString(36).slice(2,8)}`;storedFileKeys.set(file,key)}return key}
function writeProject(){const run=saveChain.then(async()=>{
  const d=projectSnapshot(false),files=new Map(),keyFor=file=>{if(!file)return null;const key=fileKeyOf(file);files.set(key,file);return key};
  const assets=[...state.assets.values()];d.version=6;d.assets.forEach((a,i)=>{a.fileKey=keyFor(assets[i].file)});d.files=state.files.map(x=>({path:x.path,fileKey:keyFor(x.file)}));
  const db=await projectDB();try{await new Promise((resolve,reject)=>{const tx=db.transaction(PROJECT_STORE,'readwrite'),store=tx.objectStore(PROJECT_STORE);
    for(const [key,file] of files)if(!writtenFileKeys.has(key))store.put(file,key);store.put(d,'current');
    const keys=store.getAllKeys();keys.onsuccess=()=>{for(const key of keys.result)if(typeof key==='string'&&key.startsWith('file:')&&!files.has(key))store.delete(key)};
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}finally{db.close()}
  writtenFileKeys=new Set(files.keys());return d});saveChain=run.catch(()=>{});return run}
// Put the stored files back into a version 6 record so restoreProject can use it like the older formats.
async function attachStoredFiles(d){const keys=new Set([...(d.assets||[]),...(d.files||[])].map(x=>x.fileKey).filter(Boolean));const db=await projectDB(),found=new Map();
  try{await new Promise((resolve,reject)=>{const tx=db.transaction(PROJECT_STORE,'readonly'),store=tx.objectStore(PROJECT_STORE);for(const key of keys){const req=store.get(key);req.onsuccess=()=>{if(req.result)found.set(key,req.result)}}tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}finally{db.close()}
  for(const x of [...(d.assets||[]),...(d.files||[])])x.file=found.get(x.fileKey)||null;for(const [key,file] of found)storedFileKeys.set(file,key);writtenFileKeys=new Set(found.keys())}
async function saveProject(){if(state.exporting)return;const btn=$('saveLocal'),label=btn.innerHTML;btn.disabled=true;setIcon(btn,'save',{text:'保存中…'});try{
  await writeProject();state.dirty=false;autosaveSig=autosaveSignature();autosaveReady=true;notify('素材を含む作業状態を、このブラウザに保存しました');$('status').textContent='保存完了 '+new Date().toLocaleTimeString('ja-JP')
}catch(e){notify('保存失敗: '+(e.name==='QuotaExceededError'?'ブラウザの保存容量が不足しています':e.message));$('status').textContent='保存失敗'}finally{btn.disabled=false;btn.innerHTML=label}}
// Autosave: every few seconds, save to the same place as "作業状態を端末に保存" when the edit has changed.
// It waits until the startup reopen has finished, so an empty start never overwrites the saved work.
let autosaveSig='',autosaveReady=false,autosaveFailed=false;
function autosaveSignature(){return JSON.stringify([state.nodes,bookmarks,state.files.map(x=>x.path),[...state.assets.keys()],WIDTH,HEIGHT,state.path])}
async function autosave(force=false){if(!autosaveReady||!$('autoSave').checked||state.exporting||(state.playing&&!force))return;const sig=autosaveSignature();if(sig===autosaveSig)return;autosaveSig=sig;
  try{await writeProject();state.dirty=false;autosaveFailed=false;$('autoSaveTime').textContent=new Date().toLocaleTimeString('ja-JP')+' 保存'}
  catch(e){autosaveSig='';$('autoSaveTime').textContent='失敗';if(!autosaveFailed)notify('自動保存できませんでした: '+(e.name==='QuotaExceededError'?'ブラウザの保存容量が不足しています':e.message));autosaveFailed=true}}
setInterval(autosave,5000);addEventListener('pagehide',()=>autosave(true));document.addEventListener('visibilitychange',()=>{if(document.hidden)autosave(true)});
$('autoSave').addEventListener('change',()=>{$('autoSaveTime').textContent=$('autoSave').checked?'':'オフ';autosave()});
async function restoreProject(d){if(![3,4,5,6].includes(d.version)||!Array.isArray(d.nodes))throw Error('非対応の保存データ');if(d.version===6)await attachStoredFiles(d);
  state.playing=false;for(const asset of state.assets.values())if(asset.url)URL.revokeObjectURL(asset.url);state.nodes=d.nodes;state.assets.clear();state.files=[];frameCache.clear();mix.clear();mixSig='';for(const id of [...frameDecoders.keys()])releaseDecoder(id);history.past.length=history.future.length=0;updateHistoryButtons();// Undo must not bring back the previous project's layers
  // A file already listed is not added again under its asset path (older saves of LKV/PowerPoint used two paths).
  const listed=file=>state.files.some(x=>x.file===file);for(const entry of d.files||[])if(entry.file&&!listed(entry.file))registerFile(entry.file,entry.path);
  for(const a of d.assets||[]){const file=a.file;const meta={id:a.id,name:a.name,type:a.type,duration:a.duration,width:a.width,height:a.height,path:a.path||a.name};state.assets.set(meta.id,meta);if(file){if(!listed(file))registerFile(file,meta.path);importAsset(file,meta.path,false,meta.id,true)}}
  applyCanvasSize(d.canvasW||1280,d.canvasH||720,false);state.path=d.path||'';state.onlineRefs=Array.isArray(d.onlineRefs)?d.onlineRefs.filter(r=>youtubeId(r.url)===r.videoId):[];state.selectedOnlineId=null;bookmarks.splice(0,bookmarks.length,...(d.bookmarks||[]));state.selected=findNode(state.nodes,d.selected)?.node?.id||null;state.t=d.t||0;state.zoom=d.zoom||1;state.tlScale=d.tlScale||1;state.timelineOffset=d.timelineOffset||0;state.timelineSpan=d.timelineSpan||0;state.showThumbnails=d.showThumbnails!==false;state.explorerThumbs=d.explorerThumbs!==false;state.rowHeight=Number(d.rowHeight)||37;state.rulerUnit=Number(d.rulerUnit)||60;state.timelineUnits=Number(d.timelineUnits)||10;$('timelineUnits').value=state.timelineUnits;$('rulerUnit').value=String(state.rulerUnit);
  $('showThumbnails').checked=state.showThumbnails;$('explorerThumbs').checked=state.explorerThumbs;$('rowHeight').value=state.rowHeight;workspace.style.setProperty('--tl-row-height',state.rowHeight+'px');$('timelineUnits').value=state.timelineUnits;
  renderer.invalidate();renderAll();layout();refreshPlaybackButtons();state.dirty=false
}
$('saveLocal').onclick=saveProject;$('projectSave').onclick=()=>{const snapshot=projectSnapshot(false);download(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}),'Tri-TON-project-v3.7.json');notify('構成JSONを保存しました（素材ファイルは含まれません）')}
// Start a blank project. The Explorer list and the work saved on this device are kept; Undo restores.
$('projectNew').onclick=()=>{$('fileMenu').classList.add('hidden');if(state.nodes.length&&!confirm('いまの編集内容を閉じて、新しいプロジェクトを始めますか？\n（素材Explorerの一覧は残ります。自動保存がオンなら、新しい状態で保存し直されます。Undoで戻せます）'))return;
  checkpoint();state.playing=false;state.nodes=[];state.selected=null;state.selectedObject=null;state.t=0;state.timelineOffset=0;bookmarks.length=0;
  renderer.invalidate();refreshPlaybackButtons();renderAll();showBookmarkPanel();$('status').textContent='新規プロジェクト';state.dirty=false};
$('projectOpen').onclick=async()=>{try{const d=await savedProject();if(d){if(confirm('このブラウザに保存した作業状態を開きますか？\nキャンセルするとJSONファイルを選べます。')){await restoreProject(d);notify('保存した作業状態を復元しました');return}}}catch(e){notify('保存データの確認ができません: '+e.message)}$('projectInput').click()};
$('projectInput').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{const d=JSON.parse(await file.text());await restoreProject(d);notify('編集構成を読み込みました。素材が不足する場合は同じ名前のファイルを読み込んでください')}catch(err){notify('プロジェクト読み込み失敗: '+err.message)}e.target.value=''};
async function realtimeExport(){const canvas=$('stage');if(!canvas.captureStream||!window.MediaRecorder)throw Error('MediaRecorderに対応していません');const opts=['video/mp4;codecs=avc1.42E01E','video/webm;codecs=vp9','video/webm'];const mime=opts.find(x=>MediaRecorder.isTypeSupported(x));if(!mime)throw Error('対応する動画エンコーダーがありません');
  const stream=canvas.captureStream(0),track=stream.getVideoTracks()[0],chunks=[];let recorder;
  try{recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:5000000});recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};const finished=new Promise(resolve=>recorder.addEventListener('stop',resolve,{once:true}));recorder.start(500);
    const start=performance.now(),frames=Math.ceil(state.total*FPS);for(let i=0;i<=frames;i++){
      state.t=Math.min(state.total-.0001,i/FPS);await renderer.render(state.nodes,state.t,null,null);track.requestFrame?.();$('status').textContent=`通常書き出し中 ${Math.floor(i/frames*100)}%`;
      const delay=start+(i+1)*1000/FPS-performance.now();if(delay>0)await new Promise(r=>setTimeout(r,delay))
    }
    recorder.stop();await finished;if(!chunks.length)throw Error('動画データが生成されませんでした');return new Blob(chunks,{type:mime})
  }finally{if(recorder?.state==='recording')recorder.stop();stream.getTracks().forEach(t=>t.stop())}
}
async function exportVideo(base,options){if(state.exporting)return;state.exporting=true;$('exportOpen').disabled=true;const oldT=state.t;state.playing=false;syncAudio();refreshPlaybackButtons();const started=performance.now();
  try{let blob;if(options.mode==='fast-mp4'){
      blob=await fastMp4Export($('stage'),async time=>{state.t=Math.min(state.total-.0001,time);await renderer.render(state.nodes,state.t,null,null)},state.total,FPS,p=>$('status').textContent=`MP4高速書き出し中 ${Math.floor(p*100)}%`)
    }else if(options.mode==='fast'){
      blob=await fastExport($('stage'),async time=>{state.t=Math.min(state.total-.0001,time);await renderer.render(state.nodes,state.t,null,null)},state.total,FPS,p=>$('status').textContent=`高速書き出し中 ${Math.floor(p*100)}%`)
    }else blob=await realtimeExport();
    let filename=base+'.'+(blob.type.includes('mp4')?'mp4':'webm');if(options.encrypt){$('status').textContent='LKV 暗号化の鍵を生成中…';const result=await encryptLkv(blob,options.password,base,filename,p=>$('status').textContent=`LKV暗号化中 ${Math.floor(p*100)}%`);blob=result.blob;filename=options.hideName?result.hiddenName:result.readableName}
    download(blob,filename);const elapsed=((performance.now()-started)/1000).toFixed(1);$('status').textContent=`書き出し完了 ${elapsed}秒`;notify(`${filename} の書き出しを開始しました（処理時間 ${elapsed}秒）`)
  }catch(e){$('status').textContent='書き出し失敗';notify('書き出し失敗: '+e.message)}finally{state.t=oldT;state.exporting=false;$('exportOpen').disabled=false;refreshPlaybackButtons();requestPaint()}
}
$('encryptExport').onchange=e=>$('encryptionExportOptions').classList.toggle('hidden',!e.target.checked);
$('exportOpen').onclick=()=>{if(!state.nodes.length)return notify('レイヤーを追加してください');$('exportDialog').showModal()};
$('exportDialog').addEventListener('close',()=>{if($('exportDialog').returnValue!=='ok')return;const base=($('exportName').value||'Tri-TON-video').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/\.(mp4|webm|lkv)$/i,'');const encrypt=$('encryptExport').checked,password=$('exportPassword').value;
  if(encrypt&&(!password||password!==$('exportPasswordConfirm').value)){notify('暗号化パスワードと確認入力が一致しません');return}
  const options={mode:$('exportMode').value,encrypt,password,hideName:$('exportHideName').checked};$('exportPassword').value='';$('exportPasswordConfirm').value='';exportVideo(base||'Tri-TON-video',options)
});

// Start with an empty composition; the last saved work is reopened at the end of this file.
state.nodes=[];state.selected=null;state.t=0;
new ResizeObserver(layout).observe(vp);new ResizeObserver(renderRuler).observe($('timelineRuler'));renderAll();layout();setMode('select');refreshPlaybackButtons();
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});

applyCanvasSize(1280,720,false);updateHistoryButtons();

// Inspector tabs group object properties without modifying node schema.
for(const button of document.querySelectorAll('[data-property-tab]'))button.addEventListener('click',()=>{
 const tab=button.dataset.propertyTab;document.querySelectorAll('[data-property-tab]').forEach(b=>b.classList.toggle('active',b===button));
 document.querySelectorAll('[data-property-panel]').forEach(p=>p.classList.toggle('hidden',p.dataset.propertyPanel!==tab));
});

$('clipMenu').addEventListener('click',e=>{if(e.target.closest('button'))$('clipMenu').classList.add('hidden')});

// Waveform peaks are indexed by ORIGINAL media time, not by a mutable timeline position.
// Video and its detached-audio child reuse the same data even after cuts/moves.
// Peaks form a pyramid: level 0 holds one bin per WAVE_BASE_SAMPLES samples and each level
// above halves it, so any pixel column is answered from at most three bins at any zoom.
const waveCache=new Map(), waveJobs=new Map();
const WAVE_BASE_SAMPLES=256, WAVE_FALLBACK_BIN=.01;
function wavePyramid(base){const levels=[base];while(levels.at(-1).length>1){const p=levels.at(-1),q=new Float32Array(Math.ceil(p.length/2));
  for(let i=0;i<q.length;i++){const a=p[2*i],b=2*i+1<p.length?p[2*i+1]:0;q[i]=a>b?a:b}levels.push(q)}return levels}
function wavePeak(data,t0,t1){let level=0,bin=data.binDuration;while(level<data.levels.length-1&&bin*2<=t1-t0){bin*=2;level++}
  const bins=data.levels[level],from=Math.max(0,Math.floor(t0/bin)),to=Math.min(bins.length,Math.max(from+1,Math.ceil(t1/bin)));
  let peak=0;for(let i=from;i<to;i++)if(bins[i]>peak)peak=bins[i];return peak}
async function ensureWaveform(asset){
 if(waveCache.has(asset.id))return waveCache.get(asset.id);
 if(waveJobs.has(asset.id))return waveJobs.get(asset.id);
 const job=(async()=>{
  const duration=Math.max(.001,Number(asset.duration)||1);
  let data=null;
  // The playback copy from AudioMix (MP4: sound track only) is reused when there is one; otherwise the browser's
  // WebAudio decodes ordinary WAV/MP3/M4A and some MP4s directly.
  const ac=new (window.AudioContext||window.webkitAudioContext)();
  try{await mix.ready(asset);const decoded=mix.buffer(asset)||await ac.decodeAudioData(await asset.file.arrayBuffer());
   const count=Math.max(1,Math.ceil(decoded.length/WAVE_BASE_SAMPLES)),base=new Float32Array(count);
   for(let ch=0;ch<decoded.numberOfChannels;ch++){const samples=decoded.getChannelData(ch);
    for(let i=0,j=0;i<count;i++){const end=Math.min(samples.length,j+WAVE_BASE_SAMPLES);let peak=base[i];
     for(;j<end;j++){const v=samples[j]<0?-samples[j]:samples[j];if(v>peak)peak=v}base[i]=peak}}
   data={levels:wavePyramid(base),binDuration:WAVE_BASE_SAMPLES/decoded.sampleRate,duration:decoded.duration,ready:true};waveCache.set(asset.id,data);
  }catch(err){
   // MP4 with both video and audio is frequently refused by decodeAudioData.
   // A separate muted-output media element feeds an analyser while playing quickly.
   const base=new Float32Array(Math.ceil(duration/WAVE_FALLBACK_BIN)+1);
   data={levels:[base],binDuration:WAVE_FALLBACK_BIN,duration,ready:false,progress:0};waveCache.set(asset.id,data);let filled=0;
   const media=document.createElement('video');media.src=asset.url;media.preload='auto';media.playsInline=true;media.muted=false;
   const srcNode=ac.createMediaElementSource(media),analyser=ac.createAnalyser(),silent=ac.createGain();
   analyser.fftSize=2048;silent.gain.value=0;srcNode.connect(analyser);analyser.connect(silent);silent.connect(ac.destination);
   const samples=new Float32Array(analyser.fftSize);
   const finish=()=>{data.levels=wavePyramid(base);data.ready=true;media.pause();media.removeAttribute('src');media.load();ac.close().catch(()=>{});renderTimeline()};
   await ac.resume();media.playbackRate=4;
   await new Promise((resolve,reject)=>{
    let done=false;const clean=()=>{if(done)return;done=true;clearInterval(timer);media.onended=null;media.onerror=null;resolve()};
    media.onended=clean;media.onerror=clean;
    const timer=setInterval(()=>{
     if(!media.duration||!Number.isFinite(media.currentTime))return;
     analyser.getFloatTimeDomainData(samples);
     let peak=0;for(let j=0;j<samples.length;j+=8)peak=Math.max(peak,Math.abs(samples[j]));
     const idx=Math.min(base.length-1,Math.floor(media.currentTime/WAVE_FALLBACK_BIN));
     // Fill elapsed bins with their observed peak; actual temporal resolution is
     // limited by sampling speed and browser timer precision.
     for(let i=Math.min(filled,idx);i<=idx;i++)base[i]=Math.max(base[i],peak);filled=idx;
     data.progress=Math.max(data.progress,media.currentTime/media.duration);
     updateWaveCanvases(asset.id);
    },30);
    media.play().catch(reject);
   }).catch(e=>{console.warn('MP4 waveform scan failed',e)});
   finish();return data;
  }
  finally{if(!data||data.ready)ac.close().catch(()=>{})}
  return data;
 })();waveJobs.set(asset.id,job);try{return await job}finally{waveJobs.delete(asset.id)}
}
// The canvas covers only the on-screen part of the clip at device-pixel resolution,
// and is redrawn from the peak pyramid whenever the timeline scale, scroll or size changes.
const waveViews=new Map();
function updateWaveCanvases(assetId){const refs=waveViews.get(assetId)||new Set();for(const view of refs){if(!view.canvas.isConnected){refs.delete(view);continue}paintWaveform(view)}}
function redrawAllWaveforms(){for(const id of waveViews.keys())updateWaveCanvases(id)}
function fitWaveCanvas(view){const {canvas,bar,lane}=view,clip=bar.getBoundingClientRect(),visible=lane.getBoundingClientRect();
 const left=Math.max(0,visible.left-clip.left),right=Math.min(clip.width,visible.right-clip.left);
 if(right-left<1||!bar.clientHeight){canvas.style.display='none';return false}
 const dpr=window.devicePixelRatio||1,w=Math.ceil((right-left)*dpr),h=Math.max(1,Math.round(bar.clientHeight*dpr));
 canvas.style.display='';canvas.style.left=left+'px';canvas.style.width=(right-left)+'px';
 if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;
 view.from=left/clip.width;view.to=right/clip.width;return true}
// The layer whose timing the waveform follows (a linked child follows its parent), and every file its pieces use.
function waveMap(n){const m=timeMap(n);return{m,ids:[...new Set([n.sourceId,...m.segments.map(s=>s.sourceId)].filter(Boolean))]}}
function paintWaveform(view){const {canvas,node:n}=view;const {m,ids}=waveMap(n),datas=ids.map(id=>waveCache.get(id)).filter(Boolean);if(!datas.length||!fitWaveCanvas(view))return;
 const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,mid=h/2;ctx.clearRect(0,0,w,h);ctx.fillStyle='#b8ffdd';
 const speed=m.speed,gain=waveScaleOf(n),data0=datas.find(d=>!d.ready)||datas[0];
 const first=n.duration*view.from,step=n.duration*(view.to-view.from)/w;
 for(let i=0;i<w;i++){const at=sourceAt(n,first+i*step,m);if(!at)continue;const data=waveCache.get(at.sourceId);if(!data)continue;
  const peak=wavePeak(data,at.time,at.time+step*speed);if(!peak)continue;
  const amplitude=Math.max(1,Math.min(h*.48,peak*h*.46*gain));ctx.fillRect(i,mid-amplitude,1,amplitude*2)}
 if(!data0.ready){const dpr=window.devicePixelRatio||1;ctx.fillStyle='rgba(220,240,245,.65)';ctx.font=`${12*dpr}px sans-serif`;ctx.fillText(`波形解析中 ${Math.round((data0.progress||0)*100)}%`,6*dpr,14*dpr)}
}
// renderTimeline appends a row only after building it, so measure once the whole pass is done.
let wavePending=new Set();
function drawWaveform(asset,canvas,n,bar,lane){
 const view={asset,canvas,node:n,bar,lane};
 // Registered under every file the layer's pieces use, so each finished analysis repaints it.
 for(const id of waveMap(n).ids){let views=waveViews.get(id);if(!views){views=new Set();waveViews.set(id,views)}
  for(const v of views)if(v.node.id===n.id)views.delete(v);views.add(view);const other=state.assets.get(id);
  if(other&&other!==asset)ensureWaveform(other).then(()=>{if(canvas.isConnected)paintWaveform(view)}).catch(e=>console.warn('波形生成に失敗',e))}
 if(!wavePending.size)queueMicrotask(()=>{const list=wavePending;wavePending=new Set();for(const v of list)if(v.canvas.isConnected)paintWaveform(v)});
 wavePending.add(view);
 ensureWaveform(asset).then(()=>{if(canvas.isConnected)paintWaveform(view)}).catch(e=>console.warn('波形生成に失敗',e));
}
new ResizeObserver(()=>{alignRuler();redrawAllWaveforms()}).observe($('timelineBody'));

// ---- Remembered settings ----------------------------------------------------------------
// Editor preferences (not the project itself) are kept in this browser and re-applied at the
// next launch: timeline display, panel sizes, canvas size, zoom, playback/mute, export and capture
// choices. Storage can be unavailable (private mode, blocked site data); everything still works.
const PREFS_KEY='triton-video-studio-prefs-v1';
const PREF_VALUES=['rulerUnit','timelineUnits','rowHeight','jumpPreset','jump','exportMode','exportName','captureKind','captureSurface','captureCamera','captureMicrophone'];
const PREF_CHECKS=['autoSave','showThumbnails','explorerThumbs','keepProportions','exportHideName','captureMicEnabled','captureSystemAudio','captureCursor'];
const PREF_LAYOUT=['--left-width','--right-width','--timeline-height','--hier-width'];
function readPrefs(){try{return JSON.parse(localStorage.getItem(PREFS_KEY))||{}}catch{return{}}}
function savePrefs(){const p={values:{},checks:{},layout:{},canvas:[WIDTH,HEIGHT],zoom:state.zoom,previewRate:state.previewRate,masterMute:state.masterMute,
    propertyTab:document.querySelector('[data-property-tab].active')?.dataset.propertyTab||'general'};
  for(const id of PREF_VALUES)p.values[id]=$(id).value;for(const id of PREF_CHECKS)p.checks[id]=$(id).checked;
  for(const v of PREF_LAYOUT){const x=workspace.style.getPropertyValue(v);if(x)p.layout[v]=x}
  // Device selects only hold real ids once permission was granted; keep the last real choice.
  const old=readPrefs().values||{};for(const id of ['captureCamera','captureMicrophone'])if(!p.values[id]&&old[id])p.values[id]=old[id];
  try{localStorage.setItem(PREFS_KEY,JSON.stringify(p))}catch{}}
let prefsTimer=0;const queuePrefs=()=>{clearTimeout(prefsTimer);prefsTimer=setTimeout(savePrefs,400)};
function applyPrefs(){const p=readPrefs();if(!p.values)return;
  for(const v of PREF_LAYOUT)if(p.layout?.[v])workspace.style.setProperty(v,p.layout[v]);
  if(Array.isArray(p.canvas))applyCanvasSize(p.canvas[0],p.canvas[1],false);
  for(const id of PREF_CHECKS)if(id in (p.checks||{})){$(id).checked=!!p.checks[id];$(id).dispatchEvent(new Event('change'))}
  for(const id of PREF_VALUES)if(p.values[id]!=null&&!['captureCamera','captureMicrophone'].includes(id))$(id).value=p.values[id];
  $('rowHeight').dispatchEvent(new Event('input'));$('rulerUnit').dispatchEvent(new Event('change'));// applies ruler unit + visible units
  if(p.zoom)state.zoom=clamp(Number(p.zoom)||1,.2,5);
  if(p.previewRate)setPreviewRate(Number(p.previewRate)||1);
  if(p.masterMute&&!state.masterMute)$('masterMute').click();
  document.querySelector(`[data-property-tab="${p.propertyTab}"]`)?.click();
  layout()}
// Re-select the remembered camera/microphone once the device list is filled.
const fillSelectBase=fillSelect;fillSelect=(id,list,fallback)=>{fillSelectBase(id,list,fallback);const want=readPrefs().values?.[id],el=$(id);if(!el.value&&want&&[...el.options].some(o=>o.value===want))el.value=want};
for(const type of ['change','input','click','pointerup'])document.addEventListener(type,queuePrefs,true);
addEventListener('pagehide',savePrefs);document.addEventListener('visibilitychange',()=>{if(document.hidden)savePrefs()});
applyPrefs();

// Reopen the work last saved with "作業状態を端末に保存" (IndexedDB), if there is any.
// With autosave on, that is the state a few seconds before the app was closed.
// Autosave starts only after this; if the saved work cannot be opened it stays off so it is not overwritten.
(async()=>{let d;try{d=await savedProject()}catch{return}if(!d||!Array.isArray(d.nodes)||!d.nodes.length){autosaveSig=autosaveSignature();autosaveReady=true;return}
  $('status').textContent='前回保存した作業状態を開いています…';
  try{await restoreProject(d);const when=d.updatedAt?new Date(d.updatedAt).toLocaleString('ja-JP'):'';autosaveSig=autosaveSignature();autosaveReady=true;
    $('status').textContent=`前回保存した作業状態を開きました${when?'（'+when+' 保存）':''}`;notify('前回保存した作業状態を開きました。新しく始めるには「ファイル ▸ 新規」')}
  catch(e){$('status').textContent='前回の作業状態を開けませんでした（自動保存は停止中）';$('autoSaveTime').textContent='停止中';notify('前回の作業状態を開けませんでした: '+e.message+'\n上書きしないよう自動保存を止めています。「作業状態を端末に保存」を押すと再開します')}})();
