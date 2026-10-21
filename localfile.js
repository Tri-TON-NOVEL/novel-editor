// ローカルファイルの読み書き。
// Chrome / Edge（Windows・Mac）は File System Access API で同じファイルへ上書き保存できる。
// Safari（Mac・iPad）は「書き出し（ダウンロード）」と「ファイル選択で読み込み」になる。
const hasFsa = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;

export const WORK_TYPES = [{ description: '小説ファイル', accept: { 'application/json': ['.json'] } }];
export const TEXT_TYPES = [{ description: 'テキスト', accept: { 'text/plain': ['.txt'] } }];

function isAbort(e) { return e && e.name === 'AbortError'; }

function download(text, name, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function ensureWritable(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission?.(opts)) === 'granted') return true;
  return (await handle.requestPermission?.(opts)) === 'granted';
}

export const localFile = {
  canOverwrite: hasFsa,

  // 戻り値: { name, text, handle } / キャンセル時は null
  async open() {
    if (hasFsa) {
      let handle;
      try {
        [handle] = await window.showOpenFilePicker({
          types: [{ description: '小説・テキスト', accept: { 'application/json': ['.json'], 'text/plain': ['.txt'] } }],
        });
      } catch (e) {
        if (isAbort(e)) return null;
        throw e;
      }
      const file = await handle.getFile();
      return { name: file.name, text: await file.text(), handle: /\.json$/i.test(file.name) ? handle : null };
    }
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.txt,application/json,text/plain';
      input.addEventListener('change', async () => {
        const file = input.files[0];
        resolve(file ? { name: file.name, text: await file.text(), handle: null } : null);
      });
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  },

  async write(handle, text) {
    if (!(await ensureWritable(handle))) throw new Error('ファイルへの書き込みが許可されませんでした');
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
  },

  // 戻り値: 保存先のハンドル / 'downloaded'（書き出しの場合） / キャンセル時は null
  async saveAs(text, suggestedName, types, mime) {
    if (hasFsa) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName, types });
        await this.write(handle, text);
        return handle;
      } catch (e) {
        if (isAbort(e)) return null;
        throw e;
      }
    }
    download(text, suggestedName, mime);
    return 'downloaded';
  },
};
