// 確認・入力の画面（ブラウザ標準の confirm / prompt の代わり）
// 標準の画面は OS によってボタンの並びが逆になる（Windows の Chrome は「OK・キャンセル」、iPhone・iPad は「キャンセル・OK」）。
// どの OS でも同じ並び（左：キャンセル、右：OK）にするため、自前の画面を使う。
//
//   if (!(await ask('削除しますか？'))) return;
//   const name = await askText('章の名前', '第一章');   // キャンセルなら null

// 消す・入れ替えるなど、取り消しにくい操作の確認は、OK ボタンを赤くし、最初にキャンセルを選んでおく
const DANGER = /削除|消し|消え|消す|入れ替え|上書き|破棄|止め/;

function open({ message, value = null, ok = 'OK', cancel = 'キャンセル', danger }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'ask-dialog';
    const form = Object.assign(document.createElement('form'), { method: 'dialog', className: 'dialog' });
    const text = Object.assign(document.createElement('p'), { className: 'ask-message', textContent: message });
    const input = value === null ? null : Object.assign(document.createElement('input'), { type: 'text', value, autocomplete: 'off' });
    const foot = Object.assign(document.createElement('div'), { className: 'dialog-foot' });
    const cancelBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: cancel });
    const okBtn = Object.assign(document.createElement('button'), { type: 'submit', value: 'ok', textContent: ok });
    const isDanger = danger ?? DANGER.test(message);
    okBtn.className = isDanger ? 'danger-solid' : 'primary';
    if (cancel === null) foot.append(okBtn); // お知らせだけ（OK のみ）
    else foot.append(cancelBtn, okBtn);
    form.append(text, ...(input ? [input] : []), foot);
    dlg.append(form);
    document.body.append(dlg);

    let answered = false;
    const finish = (result) => {
      if (answered) return;
      answered = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(result);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(input ? input.value : true);
    });
    cancelBtn.addEventListener('click', () => finish(input ? null : false));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(input ? null : false); }); // Esc
    dlg.addEventListener('close', () => finish(input ? null : false));

    dlg.showModal();
    if (input) { input.focus(); input.select(); } else if (isDanger) cancelBtn.focus(); else okBtn.focus();
  });
}

/** はい／いいえの確認。OK で true、キャンセル・Esc で false */
export function ask(message, opts = {}) {
  return open({ ...opts, message });
}

/** お知らせ（OK ボタンだけ）。閉じたら終わる */
export function inform(message, opts = {}) {
  return open({ ok: 'OK', ...opts, message, cancel: null, danger: false });
}

/**
 * いくつかの中から選んでもらう。押したボタンの value、キャンセル・Esc で null
 *   const where = await choose('保存先を選んでください', [{ value: 'gdrive', label: 'Google ドライブ', primary: true }, …]);
 * ボタンを押したその場で答えを返すので、続けて共有メニューやファイル選択を出せる（Safari は押した直後でないと出せない）。
 */
// select … { label, options: [{ value, label }], value }：プルダウンも出す。そのときの答えは { choice, value }（キャンセルは null）
export function choose(message, choices, { cancel = 'キャンセル', select = null } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'ask-dialog';
    const form = Object.assign(document.createElement('form'), { method: 'dialog', className: 'dialog' });
    const text = Object.assign(document.createElement('p'), { className: 'ask-message', textContent: message });
    const foot = Object.assign(document.createElement('div'), { className: 'dialog-foot choose-foot' });
    let sel = null;
    let selLabel = null;
    if (select) {
      sel = document.createElement('select');
      for (const o of select.options) sel.append(new Option(o.label, o.value));
      if (select.value !== undefined) sel.value = select.value;
      selLabel = Object.assign(document.createElement('label'), { className: 'ask-select' });
      selLabel.append(select.label || '', sel);
    }
    let answered = false;
    const finish = (result) => {
      if (answered) return;
      answered = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(result);
    };
    const cancelBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: cancel });
    cancelBtn.addEventListener('click', () => finish(null));
    foot.append(cancelBtn);
    let focusBtn = null;
    for (const c of choices) {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: c.label, className: c.primary ? 'primary' : c.danger ? 'danger-solid' : '' });
      b.dataset.choice = c.value;
      b.addEventListener('click', () => finish(sel ? { choice: c.value, value: sel.value } : c.value));
      foot.append(b);
      if (c.primary) focusBtn = b;
    }
    form.addEventListener('submit', (e) => e.preventDefault());
    form.append(text, ...(selLabel ? [selLabel] : []), foot);
    dlg.append(form);
    document.body.append(dlg);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener('close', () => finish(null));
    dlg.showModal();
    (focusBtn || cancelBtn).focus();
  });
}

/** 文字を入れてもらう。OK で入力した文字、キャンセル・Esc で null */
export function askText(message, value = '', opts = {}) {
  return open({ ...opts, message, value: String(value ?? ''), danger: opts.danger ?? false });
}
