// Copies the sound track of an MP4/MOV into a small audio-only .m4a without reading the video data: only the
// moov box and the audio chunks are read from the file. The track's tables are kept as they are (timing, edit
// list, codec setup); only the chunk offsets are rewritten for the new layout.
const T=new TextDecoder('latin1'),E=new TextEncoder();
const read=async(file,start,end)=>new Uint8Array(await file.slice(start,end).arrayBuffer());
function boxes(buf,start,end){const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength),out=[];let p=start;
  while(p+8<=end){let size=dv.getUint32(p),head=8;const type=T.decode(buf.subarray(p+4,p+8));
    if(size===1){if(p+16>end)break;size=Number(dv.getBigUint64(p+8));head=16}else if(size===0)size=end-p;
    if(size<head||p+size>end)break;out.push({type,start:p,head,end:p+size});p+=size}
  return out}
const child=(buf,b,type)=>b&&boxes(buf,b.start+b.head,b.end).find(x=>x.type===type);
const u32=n=>new Uint8Array([n>>>24&255,n>>>16&255,n>>>8&255,n&255]);

export const isMp4=file=>/\.(mp4|m4v|mov|m4a|3gp)$/i.test(file?.name||'')||/^(video|audio)\/(mp4|quicktime|x-m4v|3gpp)/.test(file?.type||'');

// Returns {file, duration} or null when the file has no readable sound track.
export async function extractMp4Audio(file){
  // moov may sit at the start or the end; walk the top-level boxes reading only their headers.
  let p=0,moov=null;
  while(p+8<=file.size){const h=await read(file,p,Math.min(file.size,p+16)),dv=new DataView(h.buffer);let s=dv.getUint32(0);
    if(s===1&&h.length>=16)s=Number(dv.getBigUint64(8));else if(s===0)s=file.size-p;if(s<8)return null;
    if(T.decode(h.subarray(4,8))==='moov'){moov={start:p,size:s};break}p+=s}
  if(!moov||moov.size>64*1024*1024)return null;
  const buf=await read(file,moov.start,moov.start+moov.size),dv=new DataView(buf.buffer);
  const root={type:'moov',start:0,head:dv.getUint32(0)===1?16:8,end:buf.length},mvhd=child(buf,root,'mvhd');
  let trak=null;for(const t of boxes(buf,root.start+root.head,root.end))if(t.type==='trak'){const hdlr=child(buf,child(buf,t,'mdia'),'hdlr');
    if(hdlr&&T.decode(buf.subarray(hdlr.start+hdlr.head+8,hdlr.start+hdlr.head+12))==='soun'){trak=t;break}}
  // Fragmented MP4 (browser recordings, some streaming downloads) keeps its tables in moof boxes: not handled here.
  if(!mvhd||!trak||child(buf,root,'mvex'))return null;
  const mdia=child(buf,trak,'mdia'),mdhd=child(buf,mdia,'mdhd'),stbl=child(buf,child(buf,mdia,'minf'),'stbl');
  const stsc=child(buf,stbl,'stsc'),stsz=child(buf,stbl,'stsz'),co=child(buf,stbl,'stco')||child(buf,stbl,'co64');if(!mdhd||!stsc||!stsz||!co)return null;
  const m=mdhd.start+mdhd.head,v1=buf[m]===1,scale=dv.getUint32(m+(v1?20:12)),length=v1?Number(dv.getBigUint64(m+24)):dv.getUint32(m+16);
  // Byte length of every chunk: samples per chunk (stsc runs) × sample sizes (stsz).
  const z=stsz.start+stsz.head+4,fixed=dv.getUint32(z),count=dv.getUint32(z+4),wide=co.type==='co64',c=co.start+co.head+4,chunks=dv.getUint32(c);
  if(!count||!chunks)return null;
  const offsets=Array.from({length:chunks},(_,i)=>wide?Number(dv.getBigUint64(c+4+i*8)):dv.getUint32(c+4+i*4));
  const s=stsc.start+stsc.head+4,runs=dv.getUint32(s),per=new Array(chunks).fill(0);
  for(let r=0;r<runs;r++){const first=dv.getUint32(s+4+r*12)-1,n=dv.getUint32(s+8+r*12),next=r+1<runs?dv.getUint32(s+4+(r+1)*12)-1:chunks;for(let k=Math.max(0,first);k<next&&k<chunks;k++)per[k]=n}
  const lengths=[];let sample=0;for(let k=0;k<chunks;k++){let len=0;for(let j=0;j<per[k]&&sample<count;j++,sample++)len+=fixed||dv.getUint32(z+8+sample*4);lengths.push(len)}
  const parts=new Array(chunks);for(let k=0;k<chunks;k+=64)await Promise.all(offsets.slice(k,k+64).map((o,j)=>read(file,o,o+lengths[k+j]).then(b=>{parts[k+j]=b})));
  // New layout: ftyp, moov (mvhd + this trak), mdat with the chunks back to back.
  const ftyp=new Uint8Array([...u32(28),...E.encode('ftypM4A '),...u32(0),...E.encode('M4A isommp42')]);
  const mv=buf.slice(mvhd.start,mvhd.end),tk=buf.slice(trak.start,trak.end),total=lengths.reduce((a,b)=>a+b,0);
  const moovLen=8+mv.length+tk.length,dataStart=ftyp.length+moovLen+8;if(!wide&&dataStart+total>0xffffffff)return null;
  const tdv=new DataView(tk.buffer),at=c-trak.start;let off=dataStart;
  for(let k=0;k<chunks;k++){if(wide)tdv.setBigUint64(at+4+k*8,BigInt(off));else tdv.setUint32(at+4+k*4,off);off+=lengths[k]}
  const name=(file.name||'audio').replace(/\.[^.]+$/,'')+'.m4a';
  return{file:new File([ftyp,u32(moovLen),E.encode('moov'),mv,tk,u32(total+8),E.encode('mdat'),...parts],name,{type:'audio/mp4'}),duration:scale?length/scale:0}}
