// 通信の結果（Response）の、先頭の maxBytes ほどだけを文字として読む（残りは受け取らずに切る）。
// バックアップの一覧では、ファイルの先頭にある管理情報だけが要る。全作品のパックのような大きいファイルを
// 丸ごと読むと、iPhone ではメモリが足りずに落ちる（「問題が繰り返し起きました」）ため。
// 戻り値：{ text, complete }。complete … ファイルの終わりまで読めた
export async function readStart(res, maxBytes) {
  if (!res.body?.getReader) {
    // 少しずつ読めない環境：全部読む
    const text = await res.text();
    return { text, complete: true };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let got = 0;
  let complete = false;
  while (got < maxBytes) {
    const { done, value } = await reader.read();
    if (done) { complete = true; break; }
    got += value.length;
    text += decoder.decode(value, { stream: true });
  }
  if (complete) text += decoder.decode();
  else reader.cancel().catch(() => {});
  return { text, complete };
}
