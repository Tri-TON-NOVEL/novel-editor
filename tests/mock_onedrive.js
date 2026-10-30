// テスト用：OneDrive（Microsoft Graph とログインの窓口）の偽物。ブラウザの fetch を差し替える。
// 使い方（開発者ツールのコンソールで）：
//   const { installOneDriveMock } = await import('/tests/mock_onedrive.js');
//   const M = installOneDriveMock();   // M.items（ファイル・フォルダ）、M.log、M.tokenCalls
// 更新用の鍵 'R1' で鍵 'A2' がもらえる。'A2' 以外の鍵は 401 になる（期限切れの扱い）。
export function installOneDriveMock({ seed = true } = {}) {
  const M = { items: new Map(), sessions: new Map(), log: [], tokenCalls: [], seq: 1, validAccess: new Set() };
  const add = (o) => { const it = { mtime: new Date().toISOString(), ...o }; M.items.set(it.id, it); return it; };
  M.add = add;
  add({ id: 'ROOT', name: 'root', folder: {}, parentId: null, root: true });
  if (seed) {
    add({ id: 'F1', name: '小説', folder: {}, parentId: 'ROOT' });
    add({ id: 'F2', name: 'バックアップ', folder: {}, parentId: 'F1' });
  }
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
  const err = (s, code, msg) => J({ error: { code, message: msg } }, s);
  const view = (it) => ({
    id: it.id, name: it.name,
    ...(it.folder ? { folder: { childCount: 0 } } : {}), ...(it.file ? { file: {} } : {}), ...(it.root ? { root: {} } : {}),
    lastModifiedDateTime: it.mtime,
    parentReference: it.parentId ? { id: it.parentId, path: it.parentId === 'ROOT' ? '/drive/root:' : '/drive/root:/x' } : {},
    ...(it.file ? { '@microsoft.graph.downloadUrl': 'https://dl.mock/' + it.id } : {}),
  });
  const kids = (pid) => [...M.items.values()].filter((i) => i.parentId === pid);
  const byName = (pid, name) => kids(pid).find((i) => i.name === name);
  const bodyText = async (b) => (b instanceof Blob ? b.text() : String(b ?? ''));
  const realFetch = window.__realFetch || window.fetch;
  window.__realFetch = realFetch;
  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (opts.method || 'GET').toUpperCase();
    if (url.hostname === 'login.microsoftonline.com') {
      const p = new URLSearchParams(opts.body);
      M.tokenCalls.push(Object.fromEntries(p));
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'R1') { M.validAccess.add('A2'); return J({ access_token: 'A2', expires_in: 3600, refresh_token: 'R2' }); }
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'R2') { M.validAccess.add('A3'); return J({ access_token: 'A3', expires_in: 3600, refresh_token: 'R3' }); }
      return J({ error: 'invalid_grant', error_description: 'AADSTS70000: bad grant' }, 400);
    }
    if (url.hostname === 'dl.mock') {
      const it = M.items.get(url.pathname.slice(1));
      return it ? new Response(it.content) : new Response('', { status: 404 });
    }
    if (url.hostname === 'up.mock') {
      const s = M.sessions.get(url.pathname.slice(1));
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (opts.headers?.Authorization) return err(401, 'unauthenticated', 'auth header on upload url');
      const [, , b, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(opts.headers['Content-Range']).map(Number);
      // 本物と同じく、バイトのままつなぐ（文字の途中で分かれていてもよい）
      s.parts.push(opts.body instanceof Blob ? opts.body : new Blob([String(opts.body ?? '')]));
      s.chunks++;
      if (b + 1 < total) return J({ nextExpectedRanges: [`${b + 1}-`] }, 202);
      const content = await new Blob(s.parts).text();
      let it = s.targetId ? M.items.get(s.targetId) : byName(s.parentId, s.name);
      if (it) { it.content = content; it.mtime = new Date().toISOString(); } else it = add({ id: 'I' + (M.seq++), name: s.name, file: {}, parentId: s.parentId, content });
      M.log.push(`upload-session ${it.name} chunks=${s.chunks} size=${content.length}`);
      return J(view(it), 201);
    }
    if (url.hostname !== 'graph.microsoft.com') return realFetch(input, opts);
    const auth = (opts.headers || {}).Authorization || '';
    if (!M.validAccess.has(auth.replace('Bearer ', ''))) { M.log.push('401 ' + method + ' ' + url.pathname); return err(401, 'InvalidAuthenticationToken', 'expired'); }
    const path = url.pathname.replace(/^\/v1\.0/, '');
    const conflict = url.searchParams.get('@microsoft.graph.conflictBehavior');
    M.log.push(method + ' ' + decodeURIComponent(path));
    let m;
    if ((m = /^\/me\/drive\/(?:items\/([^/:]+)|root):\/(.+?):\/(content|createUploadSession)$/.exec(path))) {
      const pid = m[1] ? decodeURIComponent(m[1]) : 'ROOT';
      const name = decodeURIComponent(m[2]);
      if (m[3] === 'createUploadSession') { const id = 'S' + (M.seq++); M.sessions.set(id, { parentId: pid, name, parts: [], chunks: 0 }); return J({ uploadUrl: 'https://up.mock/' + id }); }
      const ex = byName(pid, name);
      if (ex && conflict === 'fail') return err(409, 'nameAlreadyExists', 'exists');
      const content = await bodyText(opts.body);
      if (ex) { ex.content = content; ex.mtime = new Date().toISOString(); return J(view(ex)); }
      return J(view(add({ id: 'I' + (M.seq++), name, file: {}, parentId: pid, content })), 201);
    }
    if ((m = /^\/me\/drive\/items\/([^/:]+)\/(content|createUploadSession)$/.exec(path))) {
      const it = M.items.get(decodeURIComponent(m[1]));
      if (!it) return err(404, 'itemNotFound', 'nf');
      if (m[2] === 'createUploadSession') { const id = 'S' + (M.seq++); M.sessions.set(id, { targetId: it.id, parts: [], chunks: 0 }); return J({ uploadUrl: 'https://up.mock/' + id }); }
      if (method === 'GET') return new Response(it.content);
      it.content = await bodyText(opts.body);
      it.mtime = new Date().toISOString();
      return J(view(it));
    }
    if ((m = /^\/me\/drive\/(?:items\/([^/:]+)|root)\/children$/.exec(path))) {
      const pid = m[1] ? decodeURIComponent(m[1]) : 'ROOT';
      if (method === 'POST') {
        const b = JSON.parse(opts.body);
        if (byName(pid, b.name)) return err(409, 'nameAlreadyExists', 'exists');
        return J(view(add({ id: 'D' + (M.seq++), name: b.name, folder: {}, parentId: pid })), 201);
      }
      return J({ value: kids(pid).map(view) });
    }
    if ((m = /^\/me\/drive\/(?:items\/([^/:]+)|root):\/(.+)$/.exec(path))) {
      const it = byName(m[1] ? decodeURIComponent(m[1]) : 'ROOT', decodeURIComponent(m[2]));
      return it ? J(view(it)) : err(404, 'itemNotFound', 'nf');
    }
    // 完全削除。M.personal = true のときは、個人用 OneDrive のように使えない（400）
    if ((m = /^\/me\/drive\/items\/([^/:]+)\/permanentDelete$/.exec(path)) && method === 'POST') {
      if (M.personal) return err(400, 'invalidRequest', 'permanentDelete is not supported');
      const it = M.items.get(decodeURIComponent(m[1]));
      if (!it) return err(404, 'itemNotFound', 'nf');
      M.items.delete(it.id);
      M.log.push('permanentDelete ' + it.name);
      return new Response(null, { status: 204 });
    }
    if ((m = /^\/me\/drive\/items\/([^/:]+)$/.exec(path))) {
      const it = M.items.get(decodeURIComponent(m[1]));
      if (!it) return err(404, 'itemNotFound', 'nf');
      if (method === 'DELETE') { M.items.delete(it.id); M.recycled = [...(M.recycled || []), it.name]; return new Response(null, { status: 204 }); }
      return J(view(it));
    }
    return err(400, 'unknown', 'unmocked ' + method + ' ' + path);
  };
  window.__od = M;
  return M;
}
