// How the Disk space window writes numbers and builds its elements: what
// app.js, the map (usagemap.js) and the treemap copied from the Performance
// window (treemap.js, which imports `bytes`, `el` and `spark` from here) share.

/** In 1000s, as drives are sold and as Windows' Explorer rounds them. */
export function bytes(n) {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = value >= 100 ? Math.round(value).toString() : value.toPrecision(2);
  return `${shown} ${units[unit]}`;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

/**
 * A line of `values`, scaled to `max` (or to its own peak). The Performance
 * window's, here only because treemap.js's pressure strip imports it; the
 * Disk space window draws no strip.
 */
export function spark(values, max) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", "0 0 132 28");
  if (values.length < 2) return svg;
  const top = max ?? Math.max(...values, 1);
  const step = 132 / (values.length - 1);
  const d = values
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${(26 - (24 * Math.min(v, top)) / top).toFixed(1)}`,
    )
    .join(" ");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
