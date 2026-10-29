import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root=new URL('../dist/',import.meta.url);
const load=async name=>import('data:text/javascript;base64,'+Buffer.from(await fs.readFile(new URL(name,root))).toString('base64'));
const {encryptLkv,decryptLkv}=await load('lkv.js');
const original=new File([new TextEncoder().encode('test LKV bytes\0Hello!')],'original.webm',{type:'video/webm'});
const encrypted=await encryptLkv(original,'長いパスワード0123','暗号化した日本語の表示名','original.webm');
const header=new Uint8Array(await encrypted.blob.slice(0,128).arrayBuffer());
assert.equal(new TextDecoder().decode(header.slice(0,4)),'LKVD');
assert.equal(header[4],2);assert.equal(header[5],1);
const dv=new DataView(header.buffer);assert.equal(dv.getUint32(8),1048576);assert.equal(dv.getUint32(12),600000);
const opened=await decryptLkv(encrypted.blob,'長いパスワード0123');
assert.equal(opened.title,'暗号化した日本語の表示名');assert.equal(opened.file.name,'original.webm');assert.deepEqual(new Uint8Array(await opened.file.arrayBuffer()),new Uint8Array(await original.arrayBuffer()));
await assert.rejects(decryptLkv(encrypted.blob,'違うパスワード'));
const html=await fs.readFile(new URL('index.html',root),'utf8'),script=await fs.readFile(new URL('app.js',root),'utf8');
for(const match of script.matchAll(/\$\('([^']+)'\)/g))assert.ok(match[1]==='rulerNeedle'||html.includes('id="'+match[1]+'"'),'Missing DOM id: '+match[1]);
assert.match(html,/<b class="version">v\d+\.\d+<\/b>/);assert.match(script,/\[3,4,5,6\]\.includes\(d\.version\)/);assert.match(script,/fastExport/);assert.match(script,/fastMp4Export/);assert.match(html,/fast-mp4/);assert.match(script,/savedProject/);
console.log('PASS: LKV v2 header, round-trip, Japanese title, wrong password, app DOM references');
