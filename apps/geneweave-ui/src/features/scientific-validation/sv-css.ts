let injected = false;

export function ensureSVStyles(): void {
  if (injected || document.getElementById('sv-stylesheet')) return;
  injected = true;
  const link = document.createElement('link');
  link.id = 'sv-stylesheet';
  link.rel = 'stylesheet';
  link.href = '/ui/sv.css';
  document.head.appendChild(link);
}
