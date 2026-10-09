// Syntax highlighting without innerHTML: highlight.js produces escaped markup, which is parsed by DOMParser
// and rebuilt node by node, keeping only text and <span class="hljs-..."> elements.
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';

hljs.registerLanguage('typescript', typescript);

const CLASS_OK = /^(hljs-[\w-]+)( hljs-[\w-]+)*$/;

function rebuild(from: Node, into: Node): void {
  for (const child of Array.from(from.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(document.createTextNode(child.textContent ?? ''));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const e = child as Element;
      const cls = e.getAttribute('class') ?? '';
      if (e.tagName.toLowerCase() === 'span' && CLASS_OK.test(cls)) {
        const span = document.createElement('span');
        span.className = cls;
        rebuild(e, span);
        into.appendChild(span);
      } else {
        rebuild(e, into);
      }
    }
  }
}

/** Fill `target` (a <code> element) with highlighted TypeScript, as DOM nodes. */
export function highlightInto(target: HTMLElement, code: string): void {
  while (target.firstChild) target.removeChild(target.firstChild);
  let html: string;
  try {
    html = hljs.highlight(code, { language: 'typescript', ignoreIllegals: true }).value;
  } catch {
    target.appendChild(document.createTextNode(code));
    return;
  }
  const doc = new DOMParser().parseFromString(`<pre>${html}</pre>`, 'text/html');
  const pre = doc.body.firstElementChild;
  if (!pre) {
    target.appendChild(document.createTextNode(code));
    return;
  }
  rebuild(pre, target);
}
