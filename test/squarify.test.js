// The squarified layout the usage map is drawn with (panel/treemap.js, copied from prifly-ext-perf).

import { describe, expect, test } from "bun:test";
import { squarify } from "../panel/treemap.js";

describe("squarify", () => {
  const items = [500, 300, 120, 60, 15, 5].map((value, i) => ({ key: `k${i}`, value }));
  const rect = { x: 10, y: 20, w: 600, h: 360 };
  const out = squarify(items, rect);

  test("every item gets a tile, as big as its share of the rect", () => {
    expect(out.length).toBe(items.length);
    const total = 1000;
    for (const t of out) expect(t.w * t.h).toBeCloseTo((rect.w * rect.h * t.item.value) / total, 6);
  });

  test("the tiles fill the rect and stay inside it", () => {
    const area = out.reduce((s, t) => s + t.w * t.h, 0);
    expect(area).toBeCloseTo(rect.w * rect.h, 6);
    for (const t of out) {
      expect(t.x).toBeGreaterThanOrEqual(rect.x - 1e-9);
      expect(t.y).toBeGreaterThanOrEqual(rect.y - 1e-9);
      expect(t.x + t.w).toBeLessThanOrEqual(rect.x + rect.w + 1e-9);
      expect(t.y + t.h).toBeLessThanOrEqual(rect.y + rect.h + 1e-9);
    }
  });

  test("no two tiles overlap", () => {
    for (const [i, a] of out.entries()) {
      for (const b of out.slice(i + 1)) {
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(w <= 1e-9 || h <= 1e-9).toBe(true);
      }
    }
  });

  test("a drive's top level lays out the same way, free tile included", () => {
    const top = [832, 62, 30, 26, 50].map((value, i) => ({ key: `t${i}`, value }));
    const laid = squarify(top, { x: 0, y: 0, w: 500, h: 300 });
    expect(laid.map((t) => t.item.key).sort()).toEqual(top.map((t) => t.key).sort());
    expect(laid.reduce((s, t) => s + t.w * t.h, 0)).toBeCloseTo(500 * 300, 6);
  });

  test("nothing to lay out, or no room, gives no tiles", () => {
    expect(squarify([], rect)).toEqual([]);
    expect(squarify([{ value: 0 }], rect)).toEqual([]);
    expect(squarify(items, { x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
  });
});
