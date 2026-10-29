// Offline WebCodecs H.264 -> nonfragmented ISO-BMFF (.mp4).
// Video-only. Timestamps are generated independently of wall-clock playback.
const E = new TextEncoder();
const u8 = (...v) => new Uint8Array(v);
function join(...parts){const n=parts.reduce((s,p)=>s+p.byteLength,0),o=new Uint8Array(n);let i=0;for(const p of parts){o.set(p,i);i+=p.byteLength}return o}
function be(n,bytes=4){const a=new Uint8Array(bytes);for(let i=bytes-1;i>=0;i--){a[i]=n%256;n=Math.floor(n/256)}return a}
function box(name,...data){const payload=join(...data),size=payload.length+8;if(size>0xffffffff)throw Error('4GBを超えるMP4は現在未対応です');return join(be(size),E.encode(name),payload)}
const full=(name,version,flags,...data)=>box(name,u8(version,(flags>>16)&255,(flags>>8)&255,flags&255),...data);
const fixed=()=>join(be(0x00010000),be(0),be(0));
const matrix=()=>join(be(0x10000),be(0),be(0),be(0),be(0x10000),be(0),be(0),be(0),be(0x40000000));
function mvhd(timescale,duration){return full('mvhd',0,0,be(0),be(0),be(timescale),be(duration),be(0x10000),be(0x100,2),be(0,2),be(0),be(0),matrix(),new Uint8Array(24),be(2))}
function tkhd(duration,width,height){return full('tkhd',0,7,be(0),be(0),be(1),be(0),be(duration),be(0),be(0),be(0,2),be(0,2),be(0,2),be(0,2),matrix(),be(width*65536),be(height*65536))}
function mdhd(timescale,duration){return full('mdhd',0,0,be(0),be(0),be(timescale),be(duration),be(0x55c4,2),be(0,2))}
const hdlr=()=>full('hdlr',0,0,be(0),E.encode('vide'),be(0),be(0),be(0),E.encode('VideoHandler\0'));
function visualEntry(width,height,avcc){const compressor=new Uint8Array(32);return box('avc1',new Uint8Array(6),be(1,2),be(0,2),be(0,2),be(0),be(0),be(0),be(width,2),be(height,2),be(0x00480000),be(0x00480000),be(0),be(1,2),compressor,be(0x0018,2),be(0xffff,2),box('avcC',avcc))}
function sampleTable(frames,width,height,avcc,chunkOffset,timescale,fps){const step=Math.round(timescale/fps),duration=step*frames.length;
 const stsd=full('stsd',0,0,be(1),visualEntry(width,height,avcc));
 const stts=full('stts',0,0,be(1),be(frames.length),be(step));
 const stsc=full('stsc',0,0,be(1),be(1),be(frames.length),be(1));
 const stsz=full('stsz',0,0,be(0),be(frames.length),...frames.map(f=>be(f.data.length)));
 const stco=full('stco',0,0,be(1),be(chunkOffset));
 const key=frames.map((f,i)=>f.type==='key'?i+1:null).filter(Boolean);
 const stss=full('stss',0,0,be(key.length),...key.map(i=>be(i)));
 const stbl=box('stbl',stsd,stts,stsc,stsz,stco,stss);
 const dinf=box('dinf',full('dref',0,0,be(1),full('url ',0,1)));
 const minf=box('minf',full('vmhd',0,1,be(0,2),be(0,2),be(0,2),be(0,2)),dinf,stbl);
 const mdia=box('mdia',mdhd(timescale,duration),hdlr(),minf);
 return {duration,trak:box('trak',tkhd(duration,width,height),mdia)}
}
function mp4(frames,width,height,avcc,fps){if(!frames.length||!avcc?.length)throw Error('H.264の設定情報を取得できませんでした');
 const timescale=90000;
 const ftyp=box('ftyp',E.encode('isom'),be(0x200),E.encode('isom'),E.encode('iso2'),E.encode('avc1'),E.encode('mp41'));
 const makeMoov=offset=>{const table=sampleTable(frames,width,height,avcc,offset,timescale,fps);return box('moov',mvhd(timescale,table.duration),table.trak)};
 const preliminary=makeMoov(0),offset=ftyp.length+preliminary.length+8;
 const moov=makeMoov(offset);
 if(offset>0xffffffff)throw Error('MP4オフセット上限を超えました');
 const total=frames.reduce((n,f)=>n+f.data.length,0);if(total>0xffffffff-8)throw Error('4GBを超えるMP4は未対応です');
 return new Blob([ftyp,moov,be(total+8),E.encode('mdat'),...frames.map(f=>f.data)],{type:'video/mp4'})
}
export async function fastMp4Export(canvas,render,duration,fps=30,onProgress=()=>{}){
 if(!globalThis.VideoEncoder||!globalThis.VideoFrame)throw Error('WebCodecsが利用できません');
 const width=canvas.width,height=canvas.height;
 if(width%2||height%2)throw Error('H.264は偶数ピクセルの幅・高さが必要です');
 const candidates=['avc1.640028','avc1.4d4028','avc1.42001f'];let cfg;
 for(const acceleration of ['prefer-hardware','prefer-software']){for(const codec of candidates){const option={codec,width,height,bitrate:6000000,framerate:fps,latencyMode:'realtime',avc:{format:'avc'},hardwareAcceleration:acceleration};
 try{if((await VideoEncoder.isConfigSupported(option)).supported){cfg=option;break}}catch{}}if(cfg)break}
 if(!cfg)throw Error('このブラウザではH.264のWebCodecs高速エンコードに対応していません');
 let avcc,encoderError;const frames=[];
 const encoder=new VideoEncoder({output:(chunk,meta)=>{if(meta?.decoderConfig?.description)avcc=new Uint8Array(meta.decoderConfig.description);const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);frames.push({timestamp:chunk.timestamp,type:chunk.type,data})},error:e=>{encoderError=e}});
 encoder.configure(cfg);const count=Math.ceil(duration*fps);
 try{
  for(let i=0;i<count;i++){
   if(encoderError)throw encoderError;
   await render(i/fps);
   const frame=new VideoFrame(canvas,{timestamp:Math.round(i*1e6/fps),duration:Math.round(1e6/fps)});
   encoder.encode(frame,{keyFrame:i%Math.max(1,fps*2)===0});frame.close();
   if(encoder.encodeQueueSize>=8)await encoder.flush();
   if(i%5===0)onProgress(i/count);
  }
  await encoder.flush();if(encoderError)throw encoderError;
  frames.sort((a,b)=>a.timestamp-b.timestamp);
  onProgress(1);return mp4(frames,width,height,avcc,fps)
 }finally{encoder.close()}
}
