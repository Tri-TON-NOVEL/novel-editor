// Client-side FLV -> MP4 remux. Compressed audio/video data is copied as-is (no re-encoding).
// Supported: H.264 video with AAC or MP3 audio, the combination used by nearly all FLV files
// since 2008. Older Sorenson H.263 / VP6 / Screen video cannot be carried and is refused.
// All tracks use a 1 ms timescale, the native precision of FLV timestamps.
const E=new TextEncoder();
function join(parts){let n=0;for(const p of parts)n+=p.length;const o=new Uint8Array(n);let i=0;for(const p of parts){o.set(p,i);i+=p.length}return o}
const u16=n=>new Uint8Array([n>>8&255,n&255]);
const u32=n=>new Uint8Array([n>>>24&255,n>>>16&255,n>>>8&255,n&255]);
const u64=n=>join([u32(Math.floor(n/4294967296)),u32(n%4294967296)]);
function words(values,width=4){const a=new Uint8Array(values.length*width),d=new DataView(a.buffer);
  values.forEach((v,i)=>width===8?d.setBigUint64(i*8,BigInt(v)):d.setUint32(i*4,v>>>0));return a}
function box(type,...parts){const body=join(parts);if(body.length+8>0xffffffff)throw Error('MP4の管理情報が大きすぎます');return join([u32(body.length+8),E.encode(type),body])}
const full=(type,version,flags,...parts)=>box(type,new Uint8Array([version,flags>>16&255,flags>>8&255,flags&255]),...parts);
const MATRIX=join([u32(0x10000),u32(0),u32(0),u32(0),u32(0x10000),u32(0),u32(0),u32(0),u32(0x40000000)]);
const VIDEO_CODECS={2:'Sorenson H.263',3:'Screen Video',4:'On2 VP6',5:'On2 VP6 (アルファ付き)',6:'Screen Video v2',12:'HEVC'};
const AUDIO_CODECS={0:'PCM',1:'ADPCM',3:'PCM',4:'Nellymoser',5:'Nellymoser',6:'Nellymoser',7:'G.711',8:'G.711',11:'Speex'};

export const isFlv=file=>/\.flv$/i.test(file.name||'')||file.type==='video/x-flv';

// Width/height from the first SPS of an AVCDecoderConfigurationRecord (crop applied).
function avcSize(avcc){try{
  if(avcc.length<9||!(avcc[5]&0x1f))return null;
  const len=(avcc[6]<<8)|avcc[7],nal=avcc.subarray(9,8+len),r=[];let zeros=0;
  for(const v of nal){if(zeros>=2&&v===3){zeros=0;continue}zeros=v===0?zeros+1:0;r.push(v)}
  let bit=0;const u=n=>{let v=0;for(let k=0;k<n;k++){if(bit>>3>=r.length)throw Error('SPS');v=v*2+((r[bit>>3]>>(7-(bit&7)))&1);bit++}return v};
  const ue=()=>{let z=0;while(u(1)===0)if(++z>31)throw Error('SPS');return 2**z-1+u(z)},se=()=>{const k=ue();return k&1?(k+1)/2:-k/2};
  const profile=u(8);u(16);ue();let chroma=1;
  if([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)){chroma=ue();if(chroma===3)u(1);ue();ue();u(1);
    if(u(1))for(let i=0;i<(chroma===3?12:8);i++)if(u(1)){let last=8,next=8;for(let j=0;j<(i<6?16:64);j++){if(next!==0)next=(last+se()+256)%256;last=next===0?last:next}}}
  ue();const poc=ue();if(poc===0)ue();else if(poc===1){u(1);se();se();const n=ue();for(let i=0;i<n;i++)se()}
  ue();u(1);const wm=ue(),hm=ue(),frameMbsOnly=u(1);if(!frameMbsOnly)u(1);u(1);
  let cl=0,cr=0,ct=0,cb=0;if(u(1)){cl=ue();cr=ue();ct=ue();cb=ue()}
  const cx=chroma===1||chroma===2?2:1,cy=(chroma===1?2:1)*(2-frameMbsOnly);
  const width=(wm+1)*16-cx*(cl+cr),height=(2-frameMbsOnly)*(hm+1)*16-cy*(ct+cb);
  return width>0&&height>0?{width,height}:null
}catch{return null}}
function aacInfo(asc){const rates=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
  if(!asc||asc.length<2)return{rate:44100,channels:2};const idx=((asc[0]&7)<<1)|(asc[1]>>7);
  if(idx===15&&asc.length>=5)return{rate:((asc[1]&127)<<17)|(asc[2]<<9)|(asc[3]<<1)|(asc[4]>>7),channels:(asc[4]>>3)&15||2};
  return{rate:rates[idx]||44100,channels:(asc[1]>>3)&15||2}}
function mp3Info(frame,flvHead){const rates={3:[44100,48000,32000],2:[22050,24000,16000],0:[11025,12000,8000]};
  if(frame?.length>=4&&frame[0]===0xff&&(frame[1]&0xe0)===0xe0){const version=(frame[1]>>3)&3,rate=rates[version]?.[(frame[2]>>2)&3];
    if(rate)return{rate,channels:(frame[3]>>6)===3?1:2}}
  return{rate:[5512,11025,22050,44100][(flvHead>>2)&3],channels:flvHead&1?2:1}}

async function demux(bytes,onProgress){
  if(bytes.length<13||bytes[0]!==0x46||bytes[1]!==0x4c||bytes[2]!==0x56)throw Error('FLV形式ではありません');
  const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const video={samples:[],config:null},audio={samples:[],config:null,codec:null,head:0};let badVideo=null,badAudio=null,tags=0;
  for(let p=dv.getUint32(5)+4;p+11<=bytes.length;){
    const type=bytes[p]&0x1f,size=(bytes[p+1]<<16)|(bytes[p+2]<<8)|bytes[p+3];
    const ts=bytes[p+7]*16777216+((bytes[p+4]<<16)|(bytes[p+5]<<8)|bytes[p+6]),start=p+11,end=start+size;
    if(end>bytes.length)break;// truncated recording: keep what is complete
    if(type===9&&size>0){const head=bytes[start],codec=head&15;
      if(head&0x80||codec!==7)badVideo=head&0x80?'拡張FLV（HEVC/AV1等）':VIDEO_CODECS[codec]||`映像コーデック${codec}`;
      else if(size>=5){const kind=bytes[start+1],raw=(bytes[start+2]<<16)|(bytes[start+3]<<8)|bytes[start+4];
        if(kind===0)video.config??=bytes.slice(start+5,end);
        else if(kind===1&&end>start+5)video.samples.push({dts:ts,cto:raw&0x800000?raw-0x1000000:raw,key:head>>4===1,data:bytes.subarray(start+5,end)})}}
    else if(type===8&&size>0){const head=bytes[start],format=head>>4;
      if(format===10&&size>=2){audio.codec??='aac';if(audio.codec==='aac'){if(bytes[start+1]===0)audio.config??=bytes.slice(start+2,end);else if(end>start+2)audio.samples.push({dts:ts,data:bytes.subarray(start+2,end)})}}
      else if(format===2||format===14){audio.codec??='mp3';if(audio.codec==='mp3'&&end>start+1){if(!audio.samples.length)audio.head=head;audio.samples.push({dts:ts,data:bytes.subarray(start+1,end)})}}
      else badAudio=AUDIO_CODECS[format]||`音声コーデック${format}`}
    p=end+4;if(++tags%4000===0){onProgress(p/bytes.length);await new Promise(r=>setTimeout(r,0))}
  }
  return{video,audio,badVideo,badAudio}
}

// FLV timestamps are integer ms and may repeat; make each track strictly increasing.
function retime(samples,base,fallback){let prev=-Infinity;for(const s of samples){let t=s.dts-base;if(t<=prev)t=prev+1;s.time=t;prev=t}
  samples.forEach((s,i)=>s.dur=i+1<samples.length?samples[i+1].time-s.time:i?samples[i-1].dur:fallback)}
function runs(values){const out=[];for(const v of values){const last=out.at(-1);if(last&&last[1]===v)last[0]++;else out.push([1,v])}return out}

function videoEntry(t){const compressor=new Uint8Array(32);
  return box('avc1',new Uint8Array(6),u16(1),new Uint8Array(16),u16(t.width),u16(t.height),u32(0x480000),u32(0x480000),u32(0),u16(1),compressor,u16(0x18),u16(0xffff),box('avcC',t.config))}
function descriptor(tag,body){const n=body.length;return join([new Uint8Array([tag,0x80|(n>>21&127),0x80|(n>>14&127),0x80|(n>>7&127),n&127]),body])}
function audioEntry(t){const decoder=join([new Uint8Array([t.objectType,0x15,0,0,0]),u32(0),u32(0),t.config?descriptor(5,t.config):new Uint8Array(0)]);
  const es=descriptor(3,join([u16(2),new Uint8Array([0]),descriptor(4,decoder),descriptor(6,new Uint8Array([2]))]));
  return box('mp4a',new Uint8Array(6),u16(1),new Uint8Array(8),u16(t.channels),u16(16),u16(0),u16(0),u32(Math.min(65535,t.rate)*65536),full('esds',0,0,es))}

function trak(t,id,chunks,wide){
  const n=t.samples.length,mediaDuration=t.samples.reduce((s,x)=>s+x.dur,0),video=t.kind==='video';
  const stts=runs(t.samples.map(s=>s.dur)),table=[full('stsd',0,0,u32(1),video?videoEntry(t):audioEntry(t)),full('stts',0,0,u32(stts.length),words(stts.flat()))];
  if(video&&t.samples.some(s=>s.cto)){const c=runs(t.samples.map(s=>Math.max(0,s.cto)));table.push(full('ctts',0,0,u32(c.length),words(c.flat())))}
  const stsc=[];chunks.forEach((c,i)=>{if(stsc.at(-1)?.[1]!==c.count)stsc.push([i+1,c.count,1])});
  table.push(full('stsc',0,0,u32(stsc.length),words(stsc.flat())),full('stsz',0,0,u32(0),u32(n),words(t.samples.map(s=>s.data.length))));
  table.push(wide?full('co64',0,0,u32(chunks.length),words(chunks.map(c=>c.offset),8)):full('stco',0,0,u32(chunks.length),words(chunks.map(c=>c.offset))));
  if(video&&!t.samples.every(s=>s.key)){const keys=[];t.samples.forEach((s,i)=>{if(s.key)keys.push(i+1)});table.push(full('stss',0,0,u32(keys.length),words(keys)))}
  // A track that starts later than the movie gets an empty edit for the gap, keeping A/V sync.
  const edits=t.delay>0?[[t.delay,0xffffffff],[mediaDuration,0]]:[[mediaDuration,0]];
  const elst=full('elst',0,0,u32(edits.length),...edits.map(([d,m])=>join([u32(d),u32(m),u32(0x10000)])));
  const header=video?full('vmhd',0,1,new Uint8Array(8)):full('smhd',0,0,new Uint8Array(4));
  const minf=box('minf',header,box('dinf',full('dref',0,0,u32(1),full('url ',0,1))),box('stbl',...table));
  const mdia=box('mdia',full('mdhd',0,0,u32(0),u32(0),u32(1000),u32(mediaDuration),u16(0x55c4),u16(0)),
    full('hdlr',0,0,u32(0),E.encode(video?'vide':'soun'),new Uint8Array(12),E.encode(video?'VideoHandler\0':'SoundHandler\0')),minf);
  const tkhd=full('tkhd',0,3,u32(0),u32(0),u32(id),u32(0),u32(t.delay+mediaDuration),new Uint8Array(8),u16(0),u16(0),u16(video?0:0x100),u16(0),MATRIX,u32(video?t.width*65536:0),u32(video?t.height*65536:0));
  return box('trak',tkhd,box('edts',elst),mdia)
}

// Interleave tracks in ~0.5 s chunks so playback and seeking read nearby bytes.
function interleave(tracks){const cursor=tracks.map(()=>0),chunks=[];
  for(let until=500;;){let next=Infinity;
    tracks.forEach((t,k)=>{const first=cursor[k];let i=first;while(i<t.samples.length&&t.samples[i].time<until)i++;
      if(i>first){chunks.push({track:k,first,count:i-first,size:t.samples.slice(first,i).reduce((s,x)=>s+x.data.length,0)});cursor[k]=i}
      if(i<t.samples.length)next=Math.min(next,t.samples[i].time)});
    if(next===Infinity)return chunks;until=Math.max(until+500,next+1)}}

// Old ".flv" downloads are often something else inside: MP4/F4V, WebM/MKV, AVI, or even a saved error page.
// Returns {kind,label} for the real container, or null when it does look like FLV.
function sniff(bytes){const at=(i,s)=>[...s].every((c,k)=>bytes[i+k]===c.charCodeAt(0)),head=bytes.subarray(0,4);
  if(!bytes.length)return{kind:'broken',label:'空のファイル（0バイト）'};
  if(at(0,'FLV'))return null;
  if(['ftyp','moov','mdat','free','wide','skip'].some(t=>at(4,t)))return{kind:'mp4',label:at(8,'f4v')||at(8,'F4V')?'F4V（MP4の仲間）':'MP4'};
  if(head[0]===0x1a&&head[1]===0x45&&head[2]===0xdf&&head[3]===0xa3)return{kind:'webm',label:'WebM / MKV'};
  if(at(0,'RIFF')&&at(8,'AVI '))return{kind:'other',label:'AVI'};
  if(head[0]===0x30&&head[1]===0x26&&head[2]===0xb2&&head[3]===0x75)return{kind:'other',label:'WMV / ASF'};
  if(at(0,'.RMF'))return{kind:'other',label:'RealMedia'};
  if(head[0]===0&&head[1]===0&&head[2]===1&&head[3]===0xba)return{kind:'other',label:'MPEG-PS（MPEG-1/2）'};
  if(bytes[0]===0x47&&bytes[188]===0x47&&bytes[376]===0x47)return{kind:'other',label:'MPEG-TS'};
  if(at(0,'ID3')||(bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0))return{kind:'other',label:'MP3音声'};
  const text=new TextDecoder().decode(bytes.subarray(0,512)).trimStart().toLowerCase();
  if(/^(<!doctype|<html|<\?xml|<head|<body|\{|http\/)/.test(text))return{kind:'broken',label:'Webページや文字のデータ（動画が入っていません。ダウンロードに失敗したときの画面が保存された可能性があります）'};
  const hex=[...bytes.subarray(0,8)].map(b=>b.toString(16).padStart(2,'0')).join(' ');return{kind:'other',label:`不明な形式（先頭: ${hex}）`}}
// Some files carry a few junk bytes before the FLV header; find the header within the first 1 KB.
function flvStart(bytes){for(let i=1;i<=Math.min(bytes.length-13,1024);i++)if(bytes[i]===0x46&&bytes[i+1]===0x4c&&bytes[i+2]===0x56&&bytes[i+3]===1&&bytes[i+5]===0&&bytes[i+6]===0&&bytes[i+7]===0&&bytes[i+8]===9)return i;return -1}
export async function flvToMp4(file,onProgress=()=>{}){
  let bytes=new Uint8Array(await file.arrayBuffer());onProgress(.05);const stem=file.name.replace(/\.flv$/i,'');
  const real=sniff(bytes);
  if(real){const shift=flvStart(bytes);
    if(shift>0)bytes=bytes.subarray(shift);
    else if(real.kind==='mp4')return{file:new File([file],stem+'.mp4',{type:'video/mp4'}),warnings:[`${file.name} は拡張子がFLVですが、中身は${real.label}でした。変換せずそのまま読み込みました`]};
    else if(real.kind==='webm')return{file:new File([file],stem+'.webm',{type:'video/webm'}),warnings:[`${file.name} は拡張子がFLVですが、中身は${real.label}でした。変換せずそのまま読み込みました`]};
    else if(real.kind==='broken')throw Error(`拡張子はFLVですが、中身は${real.label}です`);
    else throw Error(`拡張子はFLVですが、中身は${real.label}です。この形式はブラウザで読み込めないため、変換ソフトでMP4にしてから読み込んでください`)}
  const {video,audio,badVideo,badAudio}=await demux(bytes,p=>onProgress(.05+p*.8));
  const warnings=[],tracks=[];
  if(video.samples.length&&video.config){const size=avcSize(video.config);if(!size)warnings.push('映像サイズを読み取れないため640×360として扱います');
    tracks.push({kind:'video',samples:video.samples,config:video.config,...(size||{width:640,height:360})})}
  else if(badVideo)throw Error(`このFLVの映像形式（${badVideo}）は変換できません。H.264のFLVのみ対応しています`);
  if(audio.samples.length&&(audio.codec==='mp3'||audio.config)){const info=audio.codec==='aac'?aacInfo(audio.config):mp3Info(audio.samples[0].data,audio.head);
    tracks.push({kind:'audio',samples:audio.samples,config:audio.codec==='aac'?audio.config:null,objectType:audio.codec==='aac'?0x40:0x6b,...info})}
  else if(badAudio)warnings.push(`音声形式（${badAudio}）は変換できないため、映像のみ取り込みます`);
  if(!tracks.length)throw Error('FLV内に変換できる映像・音声が見つかりません');
  const base=Math.min(...tracks.map(t=>t.samples[0].dts));
  // Times stay on the shared movie clock for interleaving; each track's media timeline starts at
  // its first sample and the edit list's empty edit re-inserts the delay.
  for(const t of tracks){retime(t.samples,base,t.kind==='video'?33:23);t.delay=t.samples[0].time}
  const chunks=interleave(tracks),dataSize=chunks.reduce((s,c)=>s+c.size,0),wide=dataSize+16>0xffffffff;
  const ftyp=box('ftyp',E.encode('isom'),u32(0x200),E.encode('isomiso2avc1mp41'));
  const mdatHead=wide?join([u32(1),E.encode('mdat'),u64(dataSize+16)]):join([u32(dataSize+8),E.encode('mdat')]);
  const moov=()=>{const duration=Math.max(...tracks.map(t=>t.delay+t.samples.reduce((s,x)=>s+x.dur,0)));
    return box('moov',full('mvhd',0,0,u32(0),u32(0),u32(1000),u32(duration),u32(0x10000),u16(0x100),new Uint8Array(10),MATRIX,new Uint8Array(24),u32(tracks.length+1)),
      ...tracks.map((t,k)=>trak(t,k+1,chunks.filter(c=>c.track===k),wide)))};
  // moov size does not depend on the offset values, so measure it once with zeros.
  for(const c of chunks)c.offset=0;
  let offset=ftyp.length+moov().length+mdatHead.length;for(const c of chunks){c.offset=offset;offset+=c.size}
  const parts=[ftyp,moov(),mdatHead];for(const c of chunks){const t=tracks[c.track];for(let i=c.first;i<c.first+c.count;i++)parts.push(t.samples[i].data)}
  onProgress(1);
  const name=(file.name||'video.flv').replace(/\.flv$/i,'')+'.mp4',hasVideo=tracks.some(t=>t.kind==='video');
  return{file:new File(parts,name,{type:hasVideo?'video/mp4':'audio/mp4',lastModified:file.lastModified||Date.now()}),warnings}
}
