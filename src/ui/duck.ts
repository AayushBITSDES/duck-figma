let duckIdCounter = 0;

// The collapsed window is 70x70 and square; the full duck is 1:1.3 and spends
// most of its height on a body that is three ellipses wide at that size. This
// is the same head, on its own, cropped square so it fills the tile it is the
// whole of.
export function duckHeadSvg(size: number) {
  const fid = 'duckHead' + (duckIdCounter++);
  return (
    '<svg width="' + size + '" height="' + size + '" viewBox="18 4 64 64" aria-hidden="true">' +
    '<defs><filter id="' + fid + '" x="-25%" y="-25%" width="150%" height="150%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="4" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="3"/>' +
    '</filter></defs>' +
    '<g filter="url(#' + fid + ')" stroke="#C98A1F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="50" cy="36" r="27" fill="#FFDD70"/>' +
    '<ellipse cx="49" cy="55" rx="13" ry="7" fill="#FF9F40"/>' +
    '<path d="M37 55 Q49 60 61 55" stroke="#C97116" stroke-width="2" fill="none"/>' +
    '<circle cx="40" cy="28" r="3.4" fill="#33261A" stroke="none"/>' +
    '<circle cx="60" cy="28" r="3.4" fill="#33261A" stroke="none"/>' +
    '<circle cx="41.2" cy="26.6" r="1" fill="#ffffff" stroke="none"/>' +
    '<circle cx="61.2" cy="26.6" r="1" fill="#ffffff" stroke="none"/>' +
    '<ellipse cx="31" cy="40" rx="6.5" ry="4.3" fill="#FFAFA0" stroke="none" opacity="0.6"/>' +
    '<ellipse cx="69" cy="40" rx="6.5" ry="4.3" fill="#FFAFA0" stroke="none" opacity="0.6"/>' +
    '</g>' +
    '</svg>'
  );
}
