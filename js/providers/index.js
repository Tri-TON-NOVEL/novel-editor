// クラウド保存先の一覧。使うのは「設定」→「クラウド」で選んだ1つ（端末ごと：localStorage `novel-editor:cloud.provider`）。
// 新しいサービスは、gdrive.js・onedrive.js と同じ形のオブジェクトを作ってここに足す。
//   id, label, rootName, browseHint, settings, isConfigured(), isSignedIn(), canSaveSilently(), preload(), signIn(), signOut(),
//   ready?()（起動時にログインの結果を待つ）, takeRedirectResult(), onBeforeRedirect, silently(fn),
//   フォルダ：folders()（全部を一度に）か childFolders(parentId) ＋ folderPath(id)（開くたびに読む）, filesIn(id), makeFolder(name, parentId),
//   folderInfo(), setFolder(), resetFolder(), defaultFolderId(), backupFolderInfo(), setBackupFolder(),
//   load(fileId) → text, loadBytes(fileId) → ArrayBuffer, save(text, name, fileId, opts) → fileId か { id, name }（name：実際に保存した名前）, backups: { hasFolder, folderName, list, read, write, remove }
import { prefs } from '../db.js';
import { gdrive } from './gdrive.js';
import { onedrive } from './onedrive.js';

export const providers = [gdrive, onedrive];

// 今使うクラウド。「なし」のときは null。未設定の旧版は Google ドライブを引き継ぐ。
export function activeProvider() {
  const id = prefs.get('cloud.provider', 'gdrive');
  if (id === 'none') return null;
  return providers.find((p) => p.id === id) || providers[0];
}
