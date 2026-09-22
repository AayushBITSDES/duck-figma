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

export function duckSvg(size: number) {
  const fid = 'duckSketch' + (duckIdCounter++);
  const h = Math.round(size * 1.3);
  return (
    '<svg width="' + size + '" height="' + h + '" viewBox="0 0 100 130" aria-hidden="true">' +
    '<defs><filter id="' + fid + '" x="-25%" y="-25%" width="150%" height="150%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="4" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="3"/>' +
    '</filter></defs>' +
    '<ellipse cx="50" cy="122" rx="26" ry="5" fill="#000000" opacity="0.08"/>' +
    '<g filter="url(#' + fid + ')" stroke="#C98A1F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
    '<ellipse cx="50" cy="86" rx="25" ry="27" fill="#FFD662"/>' +
    '<ellipse cx="50" cy="100" rx="19" ry="12" fill="#FFC531" opacity="0.5" stroke="none"/>' +
    '<path d="M25 76 Q13 82 19 98 Q27 92 30 80 Z" fill="#FFC531"/>' +
    '<path d="M75 76 Q87 82 81 98 Q73 92 70 80 Z" fill="#FFC531"/>' +
    '<path d="M70 60 Q84 52 79 70 Q73 66 70 60 Z" fill="#FFC531"/>' +
    '<line x1="40" y1="110" x2="38" y2="117"/>' +
    '<line x1="60" y1="110" x2="62" y2="117"/>' +
    '<ellipse cx="37" cy="120" rx="9" ry="4.5" fill="#FF9F40"/>' +
    '<ellipse cx="63" cy="120" rx="9" ry="4.5" fill="#FF9F40"/>' +
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
