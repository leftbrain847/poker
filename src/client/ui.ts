/** Tiny DOM helpers. No innerHTML anywhere: all text goes in as text, so nothing a player types can run as code. */
export interface ElOptions {
  text?: string;
  className?: string;
  onClick?: () => void;
  /** Plain attributes (aria-*, role, title, disabled, type...). */
  attrs?: Record<string, string>;
  /** CSS custom properties or properties set through the CSSOM (allowed under a 'self' style CSP). */
  style?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, opts: ElOptions = {}, children: (Node | null | false | undefined)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.className) node.className = opts.className;
  if (opts.onClick) node.addEventListener('click', opts.onClick);
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  if (opts.style) for (const [k, v] of Object.entries(opts.style)) node.style.setProperty(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

export function render(root: Node): void {
  const app = document.getElementById('app');
  if (app) app.replaceChildren(root);
}
