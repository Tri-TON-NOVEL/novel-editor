// Preview sound through the Web Audio API. Each file's sound is decoded once into memory and the pieces on the
// timeline are scheduled on the audio hardware clock, so playback does not depend on how busy the page is.
// (Media elements corrected from script every frame stutter on iPad.)
// For MP4/MOV only the sound track is read (mp4-audio.js), so a large video costs a few MB, not its file size.
import {isMp4,extractMp4Audio} from './mp4-audio.js';
// 24 kHz stereo float is about 190 KB per second: 20 minutes is about 230 MB.
const RATE=24000,MAX_SECONDS=20*60,MAX_BYTES=300*1024*1024,LEAD=.06;
export class AudioMix{
  constructor(){this.ac=null;this.master=null;this.buffers=new Map();this.jobs=new Map();this.audioFiles=new Map();this.sources=[];this.anchor=null;this.muted=false}
  context(){if(!this.ac){const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return null;
      this.ac=new AC({latencyHint:'playback'});this.master=this.ac.createGain();this.master.gain.value=this.muted?0:1;this.master.connect(this.ac.destination)}
    return this.ac}
  // Call from the play button's click so iPad allows the sound to start (also plays with the silent switch on).
  unlock(){const ac=this.context();if(!ac)return;try{if(navigator.audioSession)navigator.audioSession.type='playback'}catch{}
    if(ac.state!=='running')ac.resume().catch(()=>{});
    try{const s=ac.createBufferSource();s.buffer=ac.createBuffer(1,1,ac.sampleRate);s.connect(ac.destination);s.start()}catch{}}
  get running(){return this.ac?.state==='running'}
  buffer(asset){return this.buffers.get(asset.id)||null}
  // Object URL of the sound-only copy of an MP4 (for an <audio> element when the sound is not decoded).
  audioUrl(asset){return this.audioFiles.get(asset.id)?.url||null}
  // Resolves when prepare() has finished with this file (whether or not it produced a buffer).
  ready(asset){this.prepare(asset);return this.jobs.get(asset.id)||Promise.resolve()}
  // Starts reading/decoding in the background (once per file). Files longer than 20 minutes, large non-MP4 files
  // and files the browser cannot decode get no buffer; the caller plays those with a media element instead.
  prepare(asset){if(!asset?.file||this.jobs.has(asset.id))return;const mp4=isMp4(asset.file);
    if(!mp4&&!asset.duration)return;   // duration not known yet: try again on a later call
    this.jobs.set(asset.id,(async()=>{try{let source=asset.file,duration=asset.duration||0;
        if(mp4){const audio=await extractMp4Audio(asset.file).catch(()=>null);if(!audio)return;source=audio.file;duration=audio.duration||duration;
          if(this.jobs.has(asset.id))this.audioFiles.set(asset.id,{url:URL.createObjectURL(source)})}
        else if(source.size>MAX_BYTES)return;
        if(!duration||duration>MAX_SECONDS)return;
        const bytes=await source.arrayBuffer(),OAC=window.OfflineAudioContext||window.webkitOfflineAudioContext,ctx=new OAC(2,1,RATE);
        const buf=await new Promise((resolve,reject)=>{const p=ctx.decodeAudioData(bytes,resolve,reject);p?.catch?.(reject)});
        if(this.jobs.has(asset.id))this.buffers.set(asset.id,buf)}catch{}})())}
  clear(){this.stop();for(const a of this.audioFiles.values())URL.revokeObjectURL(a.url);this.audioFiles.clear();this.buffers.clear();this.jobs.clear()}
  // pieces: [{buffer,start,duration,offset}] — timeline start/duration in seconds, offset into the buffer.
  // Schedules everything audible from timeline time t0 onwards.
  start(pieces,t0){this.stop();const ac=this.context();if(!ac)return;const c0=ac.currentTime+LEAD;this.anchor={c0,t0};
    for(const p of pieces){const end=p.start+p.duration;if(end<=t0)continue;const from=Math.max(t0,p.start),offset=p.offset+(from-p.start);if(offset>=p.buffer.duration)continue;
      const s=ac.createBufferSource();s.buffer=p.buffer;s.connect(this.master);s.start(c0+(from-t0),offset,Math.min(end-from,p.buffer.duration-offset));this.sources.push(s)}}
  stop(){for(const s of this.sources)try{s.stop()}catch{}this.sources=[];this.anchor=null}
  // Timeline time being heard now (output latency taken off), or null when the audio clock is not in use.
  timeNow(){const a=this.anchor;if(!a||!this.running)return null;const lat=this.ac.outputLatency||this.ac.baseLatency||0;return a.t0+Math.max(0,this.ac.currentTime-lat-a.c0)}
  setMuted(m){this.muted=m;if(this.master)this.master.gain.value=m?0:1}
}
