import { describe, expect, it } from 'vitest';
import { layoutTree, relaxRing } from '../src/tree.ts';
import type { Tree, TreeNode } from '../src/types.ts';

function node(id: string, born: number, parents: string[] = [], status = 'live'): TreeNode {
  return { id, born, parents, status, died: null, ci: 0, origin: parents.length ? 'mutate' : 'seed' };
}

const sample: Tree = {
  nodes: [node('a', 0), node('b', 0), node('c', 1, ['a']), node('d', 1, ['a']), node('e', 2, ['c']), node('f', 2, [], 'rejected'), node('g', 3, ['e', 'd'])],
  bestId: 'g',
  bestLineage: ['a', 'c', 'e', 'g'],
};

describe('layoutTree', () => {
  it('places seeds on the inner ring and each cycle one ring further out', () => {
    const l = layoutTree(sample, 60);
    const r = (id: string) => Math.hypot(l.byId.get(id)!.x, l.byId.get(id)!.y);
    expect(r('a')).toBeCloseTo(33, 0);
    expect(r('c')).toBeCloseTo(93, 0);
    expect(r('e')).toBeCloseTo(153, 0);
    expect(r('g')).toBeCloseTo(213, 0);
    expect(l.rings).toBe(3);
    expect(l.maxRadius).toBeCloseTo(213, 0);
  });
  it('keeps children near their parent angle and marks the best lineage', () => {
    const l = layoutTree(sample, 60);
    const a = l.byId.get('a')!;
    const c = l.byId.get('c')!;
    const diff = Math.abs(Math.atan2(Math.sin(c.angle - a.angle), Math.cos(c.angle - a.angle)));
    expect(diff).toBeLessThan(0.6);
    expect(l.byId.get('g')!.best).toBe(true);
    expect(l.byId.get('b')!.best).toBe(false);
  });
  it('is deterministic', () => {
    const a = layoutTree(sample).nodes.map((n) => [n.id, n.x.toFixed(6), n.y.toFixed(6)]);
    const b = layoutTree(sample).nodes.map((n) => [n.id, n.x.toFixed(6), n.y.toFixed(6)]);
    expect(a).toEqual(b);
  });
  it('handles an empty tree and a single seed', () => {
    expect(layoutTree({ nodes: [], bestId: null, bestLineage: [] }).nodes).toEqual([]);
    const one = layoutTree({ nodes: [node('a', 0)], bestId: 'a', bestLineage: ['a'] });
    expect(one.byId.get('a')).toMatchObject({ x: 0, y: 0 });
  });
});

describe('relaxRing', () => {
  it('separates nodes that landed on the same angle', () => {
    const out = relaxRing([1, 1, 1, 1], 0.2);
    const sorted = [...out].sort((p, q) => p - q);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(0.199);
  });
  it('keeps the order of the input', () => {
    const out = relaxRing([0.5, 0.52, 2.0], 0.3);
    expect(out[0]!).toBeLessThan(out[1]!);
    expect(out[1]!).toBeLessThan(out[2]!);
  });
  it('never spreads past a full circle', () => {
    const out = relaxRing(Array.from({ length: 40 }, () => 0), 0.5);
    expect(Math.max(...out) - Math.min(...out)).toBeLessThan(Math.PI * 2);
  });
});
