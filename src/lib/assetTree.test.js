import { describe, it, expect } from 'vitest';
import {
  isDescendantOf,
  subtreeIds,
  folderPathText,
  folderIdPath,
  cascaderOptions,
  buildAssetTree,
  filterTree,
  folderKeys,
} from './assetTree';

const asset = (id, name, host) => ({ id, name, host });

const groups = [
  { id: 'a', pid: '', name: 'A', nodes: [asset('1', 'srv1', '10.0.0.1'), asset('2', 'srv2', '10.0.0.2')] },
  { id: 'b', pid: 'a', name: 'B', nodes: [asset('3', 'db1', '10.0.1.1')] },
  { id: 'c', pid: 'b', name: 'C', nodes: [] },
  { id: 'z', pid: '', name: 'Z', nodes: [] },
  // 损坏的父级链：互为父级，遍历必须停下来
  { id: 'cyc1', pid: 'cyc2', name: 'Cy1', nodes: [] },
  { id: 'cyc2', pid: 'cyc1', name: 'Cy2', nodes: [] },
];

describe('isDescendantOf', () => {
  it('沿 pid 链判断祖先关系', () => {
    expect(isDescendantOf(groups, 'c', 'a')).toBe(true);
    expect(isDescendantOf(groups, 'b', 'a')).toBe(true);
    expect(isDescendantOf(groups, 'a', 'c')).toBe(false);
    expect(isDescendantOf(groups, 'a', 'a')).toBe(false);
  });

  it('空 id 直接返回 false', () => {
    expect(isDescendantOf(groups, '', 'a')).toBe(false);
    expect(isDescendantOf(groups, 'a', '')).toBe(false);
  });

  it('父级成环时终止而不是死循环', () => {
    expect(isDescendantOf(groups, 'cyc1', 'cyc2')).toBe(true);
    expect(isDescendantOf(groups, 'cyc1', 'a')).toBe(false);
  });
});

describe('subtreeIds', () => {
  it('包含自身与全部子孙', () => {
    expect(subtreeIds(groups, 'a')).toEqual(['a', 'b', 'c']);
    expect(subtreeIds(groups, 'b')).toEqual(['b', 'c']);
    expect(subtreeIds(groups, 'c')).toEqual(['c']);
  });

  it('未知分组只返回自身', () => {
    expect(subtreeIds(groups, 'missing')).toEqual(['missing']);
  });
});

describe('folderPathText / folderIdPath', () => {
  it('按从根到自身的顺序拼接名称与 id', () => {
    expect(folderPathText(groups, 'c')).toBe('A / B / C');
    expect(folderPathText(groups, 'c', '>')).toBe('A>B>C');
    expect(folderIdPath(groups, 'c')).toEqual(['a', 'b', 'c']);
  });

  it('根级与空 id', () => {
    expect(folderPathText(groups, 'a')).toBe('A');
    expect(folderPathText(groups, '')).toBe('');
    expect(folderIdPath(groups, '')).toEqual([]);
  });
});

describe('cascaderOptions', () => {
  it('按 pid 构建级联树，value 用 id', () => {
    expect(cascaderOptions(groups)).toEqual([
      {
        value: 'a',
        label: 'A',
        children: [{ value: 'b', label: 'B', children: [{ value: 'c', label: 'C' }] }],
      },
      { value: 'z', label: 'Z' },
    ]);
  });

  it('omitIds 裁掉自身与子孙', () => {
    expect(cascaderOptions(groups, subtreeIds(groups, 'a'))).toEqual([{ value: 'z', label: 'Z' }]);
  });

  it('被裁掉子节点后不再带 children 字段', () => {
    expect(cascaderOptions(groups, ['b'])).toEqual([
      { value: 'a', label: 'A' },
      { value: 'z', label: 'Z' },
    ]);
  });
});

describe('buildAssetTree', () => {
  it('文件夹在前、资产在后，并统计子孙资产数', () => {
    const tree = buildAssetTree(groups);
    const a = tree[0];
    expect(a.key).toBe('f:a');
    expect(a.kind).toBe('folder');
    expect(a.count).toBe(3);
    expect(a.folderCount).toBe(1);
    expect(a.children.map((n) => n.kind)).toEqual(['folder', 'asset', 'asset']);
    expect(a.children[0].count).toBe(1);
    expect(tree[1].key).toBe('f:z');
  });

  it('资产节点携带所属文件夹 id 与原始对象', () => {
    const assetNode = buildAssetTree(groups)[0].children[1];
    expect(assetNode).toMatchObject({ key: 'a:1', kind: 'asset', id: '1', gid: 'a', name: 'srv1' });
    expect(assetNode.raw).toBe(groups[0].nodes[0]);
  });
});

describe('filterTree', () => {
  const tree = buildAssetTree(groups);
  const userOf = (a) => (a.id === '2' ? 'deploy' : '');

  it('空关键字返回原数组', () => {
    expect(filterTree(tree, '  ', userOf)).toBe(tree);
  });

  it('命中资产时保留祖先链', () => {
    const out = filterTree(tree, 'db1');
    expect(out).toHaveLength(1);
    expect(out[0].gid).toBe('a');
    expect(out[0].children).toHaveLength(1);
    expect(out[0].children[0].gid).toBe('b');
    expect(out[0].children[0].children.map((n) => n.id)).toEqual(['3']);
  });

  it('主机与回查用户名都参与匹配', () => {
    const out = filterTree(tree, '10.0.1.1');
    expect(out[0].children[0].children[0].id).toBe('3');
    const byUser = filterTree(tree, 'deploy', userOf);
    expect(byUser[0].children.map((n) => n.id)).toEqual(['2']);
  });

  it('文件夹自身命中时整棵子树保留', () => {
    const out = filterTree(tree, 'b');
    expect(out[0].children).toHaveLength(1);
    expect(out[0].children[0].key).toBe('f:b');
    expect(out[0].children[0].children.map((n) => n.key)).toEqual(['f:c', 'a:3']);
  });
});

describe('folderKeys', () => {
  it('深度优先收集全部文件夹 key', () => {
    expect(folderKeys(buildAssetTree(groups))).toEqual(['f:a', 'f:b', 'f:c', 'f:z']);
  });
});
