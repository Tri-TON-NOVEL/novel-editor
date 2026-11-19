// 投稿サイトの一覧（あや綴りの共通処理は、ここからサイトの情報を引く）
// サイトを足すときは、モジュールを作ってここに並べる。並びは、メインが決まっていないときのタブの順
import narou from './narou.js';
import kakuyomu from './kakuyomu.js';
import alpha from './alpha.js';

export const SITE_LIST = [narou, kakuyomu, alpha];
export const SITE_KEYS = SITE_LIST.map((s) => s.key);
export const SITES = Object.fromEntries(SITE_LIST.map((s) => [s.key, s]));

// その投稿先が、原稿の欄（title／foreword／body／afterword）を持つか
export const siteSupports = (site, field) => !!SITES[site]?.fields.includes(field);

// 作品で使う投稿先（メインを先頭に。残りは SITE_KEYS の順）
export function siteOrder(project) {
  const used = Array.isArray(project?.sites) ? project.sites.filter((s) => SITES[s]) : [];
  const list = used.length ? used : [project?.site || 'narou'];
  const main = list.includes(project?.site) ? project.site : list[0];
  return [main, ...SITE_KEYS.filter((s) => s !== main && list.includes(s))];
}
