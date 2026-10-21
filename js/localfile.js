// ローカルファイルの読み書き。保存のしかたは、ブラウザにある機能で決める（OS の名前では分けない）。
//   Chrome / Edge（Windows・Mac）… File System Access API：保存先を選ぶ画面。同じファイルへ上書き保存もできる
//   iPhone・iPad（Safari・ホーム画面のアプリ）… 共有メニュー：「"ファイル"に保存」で保存先（iCloud Drive など）を選ぶ
//   それ以外（Mac の Safari、Android など）… ダウンロード（「ダウンロード」フォルダへ）
// 読み込みは、どれも「ファイルを選ぶ画面」。
const hasFsa = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
// iPadOS の Safari は Mac と名乗るので、タッチ対応かどうかでも見分ける
const isAppleTouch = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function canShareFile(file) {
  try { return !!navigator.canShare && navigator.canShare({ files: [file] }); } catch { return false; }
}

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

  // 保存のしかた（画面の案内に使う）：'picker' | 'share' | 'download'
  get saveMethod() {
    if (hasFsa) return 'picker';
    if (isAppleTouch && navigator.share) return 'share';
    return 'download';
  },

  // 戻り値: 保存先のハンドル / 'shared'（共有メニューで渡した） / 'downloaded'（ダウンロード） / キャンセル時は null
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
    if (isAppleTouch) {
      // iPhone・iPad：共有メニューを出す（「"ファイル"に保存」で保存先を選べる）。使えなければダウンロード
      const file = new File([text], suggestedName, { type: mime });
      if (canShareFile(file)) {
        try {
          await navigator.share({ files: [file] });
          return 'shared';
        } catch (e) {
          if (isAbort(e)) return null; // 共有メニューを閉じた
          // 押してから時間がたって共有できないときなどは、ダウンロードにする
        }
      }
    }
    download(text, suggestedName, mime);
    return 'downloaded';
  },
};
