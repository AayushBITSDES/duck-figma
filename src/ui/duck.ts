import { tpl } from './render';

let duckIdCounter = 0;

// The collapsed window is 70x70 and square, so this is the duck's head on its
// own, cropped square to fill the tile it is the whole of. The drawing itself
// is t-duck-head in ui.html; each copy gets its own filter id so two on one
// page never share one.
export function duckHeadSvg(size: number) {
  return tpl('t-duck-head', { size: size, fid: 'duckHead' + (duckIdCounter++) });
}
