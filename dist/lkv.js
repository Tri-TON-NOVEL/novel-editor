// Secure Video Player / ScreenCaptureRecorder LKV v2 compatibility.
// AES-256-GCM with PBKDF2-SHA256, header as AAD, 1 MiB chunks.
const C=1048576,TAG=16,HEADER=128,ITER=600000,enc=new TextEncoder(),dec=new TextDecoder();
const number=(dv,p)=>dv.getUint32(p,false);
function nonce(prefix,index){const iv=new Uint8Array(12);iv.set(prefix);new DataView(iv.buffer).setUint32(8,index,false);return iv}
async function keyFor(password,salt,iterations){const base=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
function fileName(name){return(name||'video').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,100)||'video'}
function generatedId(){const alphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ',r=crypto.getRandomValues(new Uint8Array(8));return [...r].map(n=>alphabet[n&31]).join('')}
function parseHeader(h){if(h.length!==HEADER||String.fromCharCode(...h.slice(0,4))!=='LKVD')throw Error('LKV形式ではありません');const dv=new DataView(h.buffer,h.byteOffset,h.byteLength),version=h[4],method=h[5];if(![1,2].includes(version)||method!==1)throw Error('未対応のLKV形式');const size=Number(dv.getBigUint64(16,false)),chunkSize=number(dv,8),iterations=number(dv,12),metaLen=version>=2?number(dv,48):0;if(!Number.isSafeInteger(size)||chunkSize<1||chunkSize>1048576||iterations<1000||iterations>2000000||metaLen>1048576||metaLen&&metaLen<TAG)throw Error('LKVヘッダーの値が不正です');const mime=dec.decode(h.slice(65,65+Math.min(63,h[64])))||'video/mp4';return{size,chunkSize,iterations,metaLen,mime,salt:h.slice(24,40),prefix:h.slice(40,48),header:h}}
const seal=(key,iv,aad,data)=>crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,data);
const open=(key,iv,aad,data)=>crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,data);
export async function encryptLkv(blob,password,title,sourceName=title,onProgress=()=>{}){
  if(!password)throw Error('暗号化パスワードを入力してください');const size=blob.size,id=generatedId(),salt=crypto.getRandomValues(new Uint8Array(16)),prefix=crypto.getRandomValues(new Uint8Array(8));
  const json=enc.encode(JSON.stringify({id,title,originalName:sourceName,created:new Date().toISOString()}));const padded=new Uint8Array(Math.ceil((json.length+1)/256)*256);padded.fill(32);padded.set(json);
  const h=new Uint8Array(HEADER),dv=new DataView(h.buffer);h.set(enc.encode('LKVD'),0);h[4]=2;h[5]=1;dv.setUint32(8,C,false);dv.setUint32(12,ITER,false);dv.setBigUint64(16,BigInt(size),false);h.set(salt,24);h.set(prefix,40);dv.setUint32(48,padded.length+TAG,false);const mime=enc.encode(blob.type||'video/webm');h[64]=Math.min(63,mime.length);h.set(mime.slice(0,63),65);
  const key=await keyFor(password,salt,ITER),parts=[h,new Uint8Array(await seal(key,nonce(prefix,0xffffffff),h,padded))];const chunks=Math.ceil(size/C);
  for(let i=0;i<chunks;i++){const data=await blob.slice(i*C,(i+1)*C).arrayBuffer();parts.push(new Uint8Array(await seal(key,nonce(prefix,i),h,data)));onProgress((i+1)/Math.max(1,chunks));if(i%8===0)await new Promise(r=>setTimeout(r,0))}
  return{blob:new Blob(parts,{type:'application/octet-stream'}),id,hiddenName:`lkv_${id}.lkv`,readableName:fileName(title)+'.lkv'}
}
export async function decryptLkv(file,password,onProgress=()=>{}){
  if(!password)throw Error('復号パスワードが必要です');const h=parseHeader(new Uint8Array(await file.slice(0,HEADER).arrayBuffer()));const key=await keyFor(password,h.salt,h.iterations);let meta={};
  try{if(h.metaLen){const bytes=await file.slice(HEADER,HEADER+h.metaLen).arrayBuffer();meta=JSON.parse(dec.decode(await open(key,nonce(h.prefix,0xffffffff),h.header,bytes)).trim())}}
  catch{throw Error('パスワードが違うか、ファイルが壊れています')}
  const count=Math.ceil(h.size/h.chunkSize),parts=[];for(let i=0;i<count;i++){
    const length=Math.min(h.chunkSize,h.size-i*h.chunkSize),offset=HEADER+h.metaLen+i*(h.chunkSize+TAG);
    if(offset+length+TAG>file.size)throw Error('LKVファイルが途中で切れています');
    try{parts.push(new Uint8Array(await open(key,nonce(h.prefix,i),h.header,await file.slice(offset,offset+length+TAG).arrayBuffer())))}catch{throw Error('復号に失敗しました。パスワードかファイルを確認してください')}
    onProgress((i+1)/Math.max(1,count));if(i%8===0)await new Promise(r=>setTimeout(r,0));
  }
  let originalName=meta.originalName||meta.title||file.name.replace(/\.lkv$/i,'.mp4');if(!/\.[a-z0-9]{2,5}$/i.test(originalName))originalName+='.'+(h.mime.includes('webm')?'webm':'mp4');
  const decoded=new File(parts,originalName,{type:h.mime,lastModified:Date.now()});return{file:decoded,title:meta.title||originalName,meta}
}
