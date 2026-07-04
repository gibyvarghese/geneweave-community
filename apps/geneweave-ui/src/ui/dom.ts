// DOM utilities: $ (query selector), $$ (query selector all), h (element factory)

export function $(selector: string): HTMLElement {
  return document.querySelector(selector) as HTMLElement;
}

export function $$(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(selector)) as HTMLElement[];
}

const SVG_TAGS = new Set(['svg', 'path', 'line', 'circle', 'rect', 'polygon', 'polyline', 'ellipse', 'g', 'defs', 'use', 'symbol', 'text', 'tspan', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop', 'pattern', 'image', 'foreignObject']);
const SVG_NS = 'http://www.w3.org/2000/svg';

// h() - JSX-like element factory for creating DOM elements
export function h(
  tag: string,
  attributes: Record<string, any> | null,
  ...children: (HTMLElement | SVGElement | string | null | undefined)[]
): HTMLElement {
  const isSvg = SVG_TAGS.has(tag);
  const el = (isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag)) as HTMLElement;

  if (attributes) {
    Object.entries(attributes).forEach(([key, value]) => {
      if (key === 'className') {
        el.className = value;
      } else if (key === 'style' && typeof value === 'string') {
        el.setAttribute('style', value);
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        const eventName = key.substring(2).toLowerCase();
        el.addEventListener(eventName, value);
      } else if (key === 'innerHTML') {
        el.innerHTML = value;
      } else if (key === 'value' && tag === 'textarea') {
        (el as any).value = value;
      } else if (key === 'checked' || key === 'selected') {
        (el as any)[key] = !!value;
      } else if (key === 'disabled') {
        if (value) el.setAttribute('disabled', '');
      } else {
        el.setAttribute(key, String(value ?? ''));
      }
    });
  }

  children.forEach((child) => {
    if (child) {
      if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child));
      } else if (child instanceof Element) {
        el.appendChild(child);
      }
    }
  });

  return el;
}
