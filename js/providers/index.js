// クラウド保存先の一覧。
// 新しいサービス（OneDrive・Dropbox など）は、gdrive.js と同じ形のオブジェクトを作ってここに足す。
//   id, label, settings, isConfigured(), isSignedIn(), preload(), signIn(), signOut(),
//   list() → [{ id, name, modifiedTime }], load(fileId) → text, save(text, name, fileId) → fileId
import { gdrive } from './gdrive.js';

export const providers = [gdrive];
