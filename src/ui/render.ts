const root = document.getElementById('root')!;

export function render(html: string) {
  root.innerHTML = html;
}

export function escapeHtml(s: string) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

export function escapeAttr(s: string) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
