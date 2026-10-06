/**
 * Pure helpers over the flat `groups[]` snapshot: hierarchy lives in `pid` ('' = root),
 * assets stay inside each folder's `nodes[]`. Main process owns the data; these functions
 * only read it.
 */

function childFolders(groups, pid) {
  const parent = pid || '';
  return (groups || []).filter((g) => (g.pid || '') === parent);
}

function findGroup(groups, gid) {
  return gid ? (groups || []).find((g) => g.id === gid) || null : null;
}

/** 从根到该文件夹父级的 id 列表，不含自己；遇到损坏的父级链时停止而不是死循环 */
function ancestorsOf(groups, gid) {
  const out = [];
  const seen = new Set([gid]);
  let cur = findGroup(groups, gid);
  while (cur && cur.pid) {
    if (seen.has(cur.pid)) break;
    seen.add(cur.pid);
    out.unshift(cur.pid);
    cur = findGroup(groups, cur.pid);
  }
  return out;
}

export function isDescendantOf(groups, gid, ancestorId) {
  if (!gid || !ancestorId) return false;
  return ancestorsOf(groups, gid).includes(ancestorId);
}

/** 自身 + 全部子孙文件夹的 id，用于删除前的占用判断和级联选项裁剪 */
export function subtreeIds(groups, gid) {
  const out = [gid];
  childFolders(groups, gid).forEach((c) => out.push(...subtreeIds(groups, c.id)));
  return out;
}

function folderName(groups, gid) {
  return (findGroup(groups, gid) || {}).name || '';
}

/** 从根到该文件夹的名称路径，供详情页与级联回显使用 */
function folderPath(groups, gid) {
  if (!gid) return [];
  return ancestorsOf(groups, gid)
    .concat(gid)
    .map((id) => folderName(groups, id))
    .filter((n) => n !== '');
}

export function folderPathText(groups, gid, sep = ' / ') {
  return folderPath(groups, gid).join(sep);
}

/** 从根到该文件夹的 id 路径，el-cascader 的 v-model 需要它 */
export function folderIdPath(groups, gid) {
  if (!gid) return [];
  return ancestorsOf(groups, gid).concat(gid);
}

/**
 * 级联选择用的树；omitIds 用于编辑文件夹时排除自身与子孙，避免把父级选成自己的后代。
 * value 取文件夹 id，因此即使同名文件夹也能唯一回显。
 */
export function cascaderOptions(groups, omitIds = []) {
  const skip = new Set(omitIds);
  const build = (pid) =>
    childFolders(groups, pid)
      .filter((g) => !skip.has(g.id))
      .map((g) => {
        const children = build(g.id);
        const node = { value: g.id, label: g.name || '' };
        if (children.length) node.children = children;
        return node;
      });
  return build('');
}

/**
 * el-tree 的数据：文件夹携带子文件夹与资产，资产以 kind 区分，顺序沿用持久化数组。
 * key 前缀 f:/a: 保证文件夹与资产 id 不会相撞；raw 挂原始对象供插槽渲染。
 * count 是本节点及以下全部资产数，folderCount 只记直接子分组（删除前的占用判断要用）。
 */
export function buildAssetTree(groups) {
  const build = (pid) =>
    childFolders(groups, pid).map((g) => {
      const folders = build(g.id);
      return {
        key: 'f:' + g.id,
        kind: 'folder',
        gid: g.id,
        pid: g.pid || '',
        name: g.name || '',
        color: g.color || '#409EFF',
        count: g.nodes.length + folders.reduce((sum, f) => sum + f.count, 0),
        folderCount: folders.length,
        raw: g,
        children: folders.concat(
          g.nodes.map((asset) => ({
            key: 'a:' + asset.id,
            kind: 'asset',
            id: asset.id,
            gid: g.id,
            name: asset.name || '',
            raw: asset,
          }))
        ),
      };
    });
  return build('');
}

/** 搜索时保留命中节点及其祖先链；文件夹自身命中则整棵子树留下 */
export function filterTree(nodes, keyword) {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return nodes;
  const walk = (list) => {
    const out = [];
    list.forEach((n) => {
      if (n.kind === 'asset') {
        const hit =
          (n.name || '').toLowerCase().includes(kw) ||
          ((n.raw.host || '') + ' ' + (n.raw.user || '')).toLowerCase().includes(kw);
        if (hit) out.push({ ...n, children: [] });
        return;
      }
      const selfHit = (n.name || '').toLowerCase().includes(kw);
      const kids = selfHit ? n.children : walk(n.children);
      if (selfHit || kids.length) out.push({ ...n, children: kids });
    });
    return out;
  };
  return walk(nodes);
}

/** 树中全部文件夹 key，供展开/折叠全部与命中祖先使用 */
export function folderKeys(nodes) {
  const out = [];
  const walk = (list) =>
    list.forEach((n) => {
      if (n.kind !== 'folder') return;
      out.push(n.key);
      walk(n.children);
    });
  walk(nodes);
  return out;
}
