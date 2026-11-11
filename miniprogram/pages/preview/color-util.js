// hex 工具：rgb → '#rrggbb'（xr-frame material color 用）
function hex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

module.exports = { hex };
