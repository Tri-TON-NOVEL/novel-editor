// Line icons (24×24, drawn with currentColor) for the toolbar buttons, and the hover tooltip shared by
// every element that has a title. A button's former text becomes the first line of its tooltip.
const P={
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  filePlus:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15h6"/>',
  fileCode:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M10 13l-2 2 2 2M14 13l2 2-2 2"/>',
  folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen:'<path d="M3 18V6a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v2"/><path d="M3 18l2.6-6.5A2 2 0 0 1 7.5 10H21l-3 8.6a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2z"/>',
  save:'<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  export:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  slides:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4M8 21h8M7 13l3-3 2 2 4-4"/>',
  undo:'<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo:'<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  objectSelect:'<path d="M5 3H3v2M9 3h2M15 3h2M21 5V3h-2M3 9v2M3 15v2M5 21H3v-2M9 21h2M21 9v2"/><path d="m12 12 4 10 1.7-5.3L23 15z"/>',
  bookmark:'<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  bookmarkOn:'<path fill="currentColor" d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  scissors:'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  cutter:'<g transform="rotate(-38 12 12)"><rect x="1" y="9.5" width="14" height="6" rx="1.5"/><path d="M15 10.5h8l-4 4h-4"/><path d="M18 10.5l-1.6 4M20.6 10.5l-1.2 2"/><path d="M5 9.5V8h5v1.5"/></g>',
  eraser:'<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21"/><path d="M22 21H7M5 11l9 9"/>',
  copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  trash:'<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  audioOut:'<path d="M8 17V5l8-2v4"/><circle cx="5" cy="17" r="3"/><path d="M13 15h8M18 12l3 3-3 3"/>',
  audioLink:'<path d="M8 17V5l8-2v4"/><circle cx="5" cy="17" r="3"/><path d="M15 12h-1a2.5 2.5 0 0 0 0 5h1M19 12h1a2.5 2.5 0 0 1 0 5h-1M15.5 14.5h3"/>',
  camera:'<path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  monitor:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  addToTimeline:'<rect x="3" y="4" width="18" height="6" rx="1"/><path d="M3 15h7M3 19h7M17 13v8M13 17h8"/>',
  listRemove:'<path d="M3 6h12M3 12h12M3 18h7M15 15l6 6M21 15l-6 6"/>',
  record:'<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/>',
  stop:'<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  stopAdd:'<rect x="3" y="3" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/><path d="m13 18 3 3 6-7"/>',
  x:'<path d="M18 6 6 18M6 6l12 12"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  zoomIn:'<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
  zoomOut:'<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3M8 11h6"/>',
  fit:'<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  canvasSize:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 12V9h3M17 12v3h-3"/>',
  text:'<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  shapes:'<path d="M12 2.5 16.5 10h-9z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>',
  square:'<rect x="5" y="5" width="14" height="14" rx="1"/>',
  rect:'<rect x="3" y="7" width="18" height="10" rx="1"/>',
  star:'<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z"/>',
  circle:'<circle cx="12" cy="12" r="8"/>',
  ellipse:'<ellipse cx="12" cy="12" rx="10" ry="6"/>',
  line:'<path d="M4 20 20 4"/>',
  polyline:'<path d="M3 18 9 8l6 8 6-10"/>',
  curve:'<path d="M3 18C7 2 17 22 21 6"/>',
  polygon:'<path d="M12 3l8.5 6.2-3.2 10H6.7L3.5 9.2z"/>',
  freehand:'<path d="M3 17c3-6 5 2 8-3s4-6 6-3 3 4 4 3"/>',
  pointer:'<path d="m4 4 7 17 2.5-7.5L21 11z"/>',
  scale:'<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  rotate:'<path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.8 1 6.5 2.6L21 8"/><path d="M21 3v5h-5"/>',
  stretch:'<path d="M12 2v20M9 5l3-3 3 3M9 19l3 3 3-3M2 12h20M5 9l-3 3 3 3M19 9l3 3-3 3"/>',
  crop:'<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  skipBack:'<path d="M19 20 9 12l10-8z" fill="currentColor"/><path d="M5 19V5"/>',
  skipForward:'<path d="m5 4 10 8-10 8z" fill="currentColor"/><path d="M19 5v14"/>',
  play:'<path d="M7 4v16l13-8z" fill="currentColor"/>',
  pause:'<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
  arrowLeft:'<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowRight:'<path d="M5 12h14M12 5l7 7-7 7"/>',
  gauge:'<path d="m12 14 4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
  volume:'<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  volumeOff:'<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="m22 9-6 6M16 9l6 6"/>',
  sliders:'<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  layout:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  motion:'<circle cx="16" cy="12" r="5"/><path d="M2 8h6M3 12h5M2 16h6"/>',
  film:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 8h5M2 12h5M2 16h5M17 8h5M17 12h5M17 16h5"/>',
  rowHeight:'<path d="M3 4h18M3 20h18M12 7v10M9 10l3-3 3 3M9 14l3 3 3-3"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  widthScale:'<path d="M3 5v14M21 5v14M7 12h10M10 9l-3 3 3 3M14 9l3 3-3 3"/>',
  ticks:'<path d="M3 17h18M4 17v-5M8 17v-3M12 17v-6M16 17v-3M20 17v-5"/>',
  fitObject:'<rect x="6" y="6" width="12" height="12" rx="1"/><path d="m8.5 15.5 2.5-3 2 2 1.5-1.5 1.5 2.5"/><circle cx="14.5" cy="9.5" r="1"/><path d="M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4"/>',
  chevron:'<path d="m6 9 6 6 6-6"/>'
};
export function icon(name,cls='ico'){return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name]||''}</svg>`}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
// Show an icon in a button. text: label kept beside the icon; menu: add a ▾ mark; tip: tooltip text.
export function setIcon(el,name,{text='',tip,menu=false}={}){if(!el)return;
  el.innerHTML=icon(name)+(text?`<span class="ico-label">${esc(text)}</span>`:'')+(menu?icon('chevron','ico ico-caret'):'');
  el.classList.add('icon-btn');el.classList.toggle('icon-only',!text);
  if(tip!=null){el.dataset.tip=tip;el.setAttribute('aria-label',tip.split('\n')[0])}}
// [selector, icon, keep text beside the icon?] — menus and dialog answers keep their words.
const MAP=[
  ['#fileMenuButton','file',0,1],['#projectNew','filePlus',1],['#projectOpen','folderOpen',1],['#projectSave','fileCode',1],['#saveLocal','save',1],['#exportOpen','export',1],
  ['#timelineUndo','undo'],['#timelineRedo','redo'],['#objectMode','objectSelect'],['#bookmarkMode','bookmark'],['#split','scissors'],['#cutWithin','cutter'],['#removeWithin','eraser'],
  ['#duplicate','copy'],['#deleteLayer','trash'],['#detachAudio','audioOut'],['#relinkAudio','audioLink'],
  ['#importMenuButton','filePlus',0,1],['#chooseFiles','file',1],['#importPptx','slides',1],['#chooseFolder','folder',1],['#captureOpen','camera',0,1],
  ['#addSelectedAsset','addToTimeline'],['#removeSelectedAsset','listRemove'],
  ['#capturePrepare','monitor'],['#captureRecord','record'],['#captureFinish','stopAdd'],['#captureClose','x'],
  ['#viewMinus','zoomOut','','縮小'],['#viewPlus','zoomIn','','拡大'],['#viewFit','fit'],['#canvasSettingsToggle','canvasSize'],['#addText','text'],['#shapeMenuButton','shapes',0,1],['#addShape','shapes'],
  ['[data-shape="square"]','square',1],['[data-shape="rect"]','rect',1],['[data-shape="star"]','star',1],['[data-shape="circle"]','circle',1],['[data-shape="ellipse"]','ellipse',1],['[data-shape="line"]','line',1],['[data-shape="polyline"]','polyline',1],['[data-shape="curve"]','curve',1],
  ['[data-mode="select"]','pointer'],['[data-mode="resize"]','scale'],['#fitObject','fitObject'],['#canvasRotate','rotate'],['#clipStretch','stretch'],['#clipMenuButton','crop',0,1],
  ['[data-mode="rect"]','square',1],['[data-mode="circle"]','circle',1],['[data-mode="ellipse"]','ellipse',1],['[data-mode="polygon"]','polygon',1],['[data-mode="freehand"]','freehand',1],
  ['#finishShape','check'],['#cancelShape','trash','','切り抜き形状を削除'],
  ['#home','skipBack'],['#togglePlay','play'],['#stopPlay','stop'],['#end','skipForward'],['#stepBack','arrowLeft','','戻る'],['#stepForward','arrowRight','','進む'],['#masterMute','volume','','全ミュート'],['#speedButton','gauge','','再生速度'],
  ['#applyCanvasSize','check',1],['#speedClose','x'],
  ['[data-property-tab="general"]','sliders'],['[data-property-tab="layout"]','layout'],['[data-property-tab="animation"]','motion'],
  ['#previewAnimation','play',1],['button[value="cancel"]','x',1],['button[value="ok"]','export',1]
];
export function applyIcons(root=document){for(const el of root.querySelectorAll('[data-icon]'))el.outerHTML=icon(el.dataset.icon);for(const [sel,name,keep,menuOrName] of MAP)for(const el of root.querySelectorAll(sel)){
    const words=(typeof menuOrName==='string'&&menuOrName)||el.textContent.replace(/[▾]/g,'').replace(/^[^\p{L}\p{N}]+/u,'').trim();
    const desc=el.getAttribute('title')||'';el.removeAttribute('title');
    setIcon(el,name,{text:keep?words:'',menu:menuOrName===1,tip:keep?desc:(desc&&desc!==words?`${words}\n${desc}`:words)});
    if(keep&&!desc)delete el.dataset.tip}}
// One floating tooltip for anything with a title or data-tip. The native title is moved to data-tip on first hover
// so the browser's own tooltip does not show as well. First line is drawn bold as the name.
export function installTooltips(){const tip=document.createElement('div');tip.className='ui-tip';tip.setAttribute('role','tooltip');tip.hidden=true;document.body.append(tip);
  let target=null,timer=0;const hide=()=>{clearTimeout(timer);target=null;tip.hidden=true};
  const show=()=>{if(!target||!target.isConnected)return hide();const text=target.dataset.tip;if(!text)return hide();const [head,...rest]=text.split('\n');
    tip.innerHTML=`<b>${esc(head)}</b>${rest.length?`<span>${esc(rest.join('\n'))}</span>`:''}`;tip.hidden=false;
    const r=target.getBoundingClientRect(),w=tip.offsetWidth,h=tip.offsetHeight;let x=r.left+r.width/2-w/2,y=r.bottom+6;
    if(y+h>innerHeight-4)y=r.top-h-6;tip.style.left=Math.max(4,Math.min(innerWidth-w-4,x))+'px';tip.style.top=Math.max(4,y)+'px'};
  document.addEventListener('pointerover',e=>{const el=e.target.closest?.('[data-tip],[title]');if(el===target)return;if(!el)return hide();
    if(el.hasAttribute('title')){const t=el.getAttribute('title');el.removeAttribute('title');if(t)el.dataset.tip=t}
    target=el;clearTimeout(timer);if(tip.hidden)timer=setTimeout(show,350);else show()});
  document.addEventListener('pointerout',e=>{if(target&&!target.contains(e.relatedTarget))hide()});
  for(const ev of ['pointerdown','wheel','keydown'])document.addEventListener(ev,hide,true);addEventListener('blur',hide)}
