// Video-only offline WebCodecs VP8 + WebM muxing. Frames have explicit timestamps,
// so encoding speed is independent of real-time playback. No audio track here.
const e=new TextEncoder();
function concat(...arr){const n=arr.reduce((s,v)=>s+v.length,0),out=new Uint8Array(n);let at=0;for(const v of arr){out.set(v,at);at+=v.length}return out}
function integer(n){let size=1;while(n>=2**(size*8)&&size<8)size++;const a=new Uint8Array(size);for(let i=size-1;i>=0;i--){a[i]=n%256;n=Math.floor(n/256)}return a}
function vint(n){for(let size=1;size<=8;size++){const limit=2**(7*size)-1;if(n<limit){const a=new Uint8Array(size);for(let i=size-1;i>=0;i--){a[i]=n%256;n=Math.floor(n/256)}a[0]|=1<<(8-size);return a}}throw Error('WebMの要素が大きすぎます')}
function idBytes(hex){return new Uint8Array(hex.match(/../g).map(n=>parseInt(n,16)))}
const elem=(id,bytes)=>concat(idBytes(id),vint(bytes.length),bytes);
const num=(id,v)=>elem(id,integer(v));
const str=(id,v)=>elem(id,e.encode(v));
const master=(id,...children)=>elem(id,concat(...children));
function f64(id,v){const a=new Uint8Array(8);new DataView(a.buffer).setFloat64(0,v,false);return elem(id,a)}
function simpleBlock(frame,base){const time=Math.round(frame.timestamp/1000)-base,b=new Uint8Array(4+frame.data.length);b[0]=0x81;new DataView(b.buffer).setInt16(1,time,false);b[3]=frame.type==='key'?0x80:0;b.set(frame.data,4);return elem('A3',b)}
function webm(frames,width,height,duration){const ebml=master('1A45DFA3',num('4286',1),num('42F7',1),num('42F2',4),num('42F3',8),str('4282','webm'),num('4287',4),num('4285',2));
  const info=master('1549A966',num('2AD7B1',1000000),str('4D80','Tri-TON Video Studio'),str('5741','Tri-TON Video Studio'),f64('4489',duration*1000));
  const track=master('1654AE6B',master('AE',num('D7',1),num('73C5',1),num('83',1),str('86','V_VP8'),master('E0',num('B0',width),num('BA',height))));
  const clusters=[];let group=[],base=0;for(const frame of frames){const ms=Math.round(frame.timestamp/1000);if(!group.length)base=ms;if(ms-base>30000){clusters.push(master('1F43B675',num('E7',base),...group));group=[];base=ms}group.push(simpleBlock(frame,base))}if(group.length)clusters.push(master('1F43B675',num('E7',base),...group));
  // Eight-byte unknown segment size, with known-size children.
  return new Blob([ebml,idBytes('18538067'),new Uint8Array([1,255,255,255,255,255,255,255]),info,track,...clusters],{type:'video/webm'})
}
export async function fastExport(canvas,render,duration,fps=30,onProgress=()=>{}){
  if(!globalThis.VideoEncoder||!globalThis.VideoFrame)throw Error('WebCodecsが利用できません');const width=canvas.width,height=canvas.height;
  const cfg={codec:'vp8',width,height,bitrate:5000000,framerate:fps,latencyMode:'quality'};const supported=await VideoEncoder.isConfigSupported(cfg);if(!supported.supported)throw Error('VP8エンコーダーが利用できません');
  // An error thrown inside the callback would be lost; keep it and fail the export instead.
  let encoderError;const frames=[],encoder=new VideoEncoder({output:chunk=>{const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);frames.push({timestamp:chunk.timestamp,type:chunk.type,data})},error:err=>{encoderError=err}});
  encoder.configure(cfg);const count=Math.ceil(duration*fps);
  try{for(let i=0;i<count;i++){
    if(encoderError)throw encoderError;await render(i/fps);const v=new VideoFrame(canvas,{timestamp:Math.round(i*1e6/fps),duration:Math.round(1e6/fps)});
    encoder.encode(v,{keyFrame:i%Math.max(1,fps*2)===0});v.close();
    if(encoder.encodeQueueSize>=8)await encoder.flush();
    if(i%5===0)onProgress(i/count);
  }await encoder.flush();if(encoderError)throw encoderError;frames.sort((a,b)=>a.timestamp-b.timestamp);onProgress(1);return webm(frames,width,height,duration)}finally{encoder.close()}
}
