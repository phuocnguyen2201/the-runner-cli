// Minimal Markdown → email-safe HTML (inline styles, no dependencies).
// Supports: headings, paragraphs, bold/italic/code, links, bare URLs,
// bullet/numbered lists, tables, blockquotes, horizontal rules, code blocks.

const STYLE = {
  h1: 'margin:0 0 12px;font-size:22px;line-height:1.3;color:#1f1e1c;',
  h2: 'margin:28px 0 10px;padding-bottom:6px;font-size:18px;line-height:1.3;color:#1f1e1c;border-bottom:2px solid #c2410c;',
  h3: 'margin:20px 0 8px;font-size:16px;line-height:1.3;color:#1f1e1c;',
  h4: 'margin:16px 0 6px;font-size:14px;color:#1f1e1c;',
  p: 'margin:0 0 12px;line-height:1.55;',
  ul: 'margin:0 0 12px;padding-left:22px;',
  ol: 'margin:0 0 12px;padding-left:22px;',
  li: 'margin:0 0 6px;line-height:1.55;',
  table: 'border-collapse:collapse;width:100%;margin:0 0 16px;font-size:13px;line-height:1.4;',
  th: 'background:#f0eee9;color:#1f1e1c;text-align:left;font-weight:600;padding:8px 10px;border:1px solid #e2dfd8;',
  td: 'padding:8px 10px;border:1px solid #e2dfd8;vertical-align:top;',
  tdAlt: 'padding:8px 10px;border:1px solid #e2dfd8;vertical-align:top;background:#faf9f7;',
  a: 'color:#c2410c;font-weight:600;text-decoration:underline;',
  code: 'font-family:Menlo,Consolas,monospace;font-size:12px;background:#f0eee9;padding:1px 4px;border-radius:4px;word-break:break-word;',
  label: 'display:none;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b6862;margin:0 0 2px;',
  pre: 'font-family:Menlo,Consolas,monospace;font-size:12px;background:#f0eee9;padding:10px 12px;border-radius:6px;white-space:pre-wrap;word-break:break-word;margin:0 0 12px;',
  blockquote: 'margin:0 0 12px;padding:6px 12px;border-left:3px solid #e2dfd8;color:#6b6862;',
  hr: 'border:0;border-top:1px solid #e2dfd8;margin:20px 0;',
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  let s = text
    .replace(/`([^`]+)`/g, (_, c) => keep(`<code style="${STYLE.code}">${esc(c)}</code>`))
    .replace(/\[([^\]]+)\]\(\s*(https?:\/\/[^\s)]+|mailto:[^\s)]+)\s*\)/g, (_, label, url) =>
      keep(`<a href="${esc(url)}" style="${STYLE.a}">${inline(label)}</a>`))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, pre, url) =>
      pre + keep(`<a href="${esc(url)}" style="${STYLE.a}">${esc(url)}</a>`));

  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableSep = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

export function markdownToHtml(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // fenced code
    if (/^\s*```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre style="${STYLE.pre}">${esc(body.join('\n'))}</pre>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const tag = `h${Math.min(h[1].length, 4)}`;
      out.push(`<${tag} class="em-h" style="${STYLE[tag]}">${inline(h[2])}</${tag}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(`<hr style="${STYLE.hr}">`);
      i++;
      continue;
    }

    // table
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const th = head.map((c) => `<th class="em-th" style="${STYLE.th}">${inline(c)}</th>`).join('');
      const tb = rows.map((r, n) => {
        const st = n % 2 ? STYLE.tdAlt : STYLE.td;
        return `<tr class="em-tr">${head.map((h, k) => {
          const cell = r[k] ?? '';
          const nowrap = /^\d{4}-\d{2}-\d{2}$/.test(cell) ? 'white-space:nowrap;' : '';
          // The label is hidden on desktop; on narrow screens rows become cards and it names each field.
          const label = h ? `<div class="em-lbl" style="${STYLE.label}">${inline(h)}</div>` : '';
          return `<td class="em-td${cell ? '' : ' em-empty'}" style="${st}${nowrap}">${label}${inline(cell)}</td>`;
        }).join('')}</tr>`;
      }).join('');
      out.push(`<table class="em-table" role="presentation" cellspacing="0" cellpadding="0" style="${STYLE.table}"><thead class="em-thead"><tr>${th}</tr></thead><tbody class="em-tbody">${tb}</tbody></table>`);
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote style="${STYLE.blockquote}">${inline(body.join(' '))}</blockquote>`);
      continue;
    }

    // lists
    const listRe = /^\s*([-*+]|\d+[.)])\s+/;
    if (listRe.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && (listRe.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (listRe.test(lines[i])) items.push(lines[i].replace(listRe, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag} style="${STYLE[tag]}">${items.map((t) => `<li style="${STYLE.li}">${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // paragraph
    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) para.push(lines[i++].trim());
    out.push(`<p style="${STYLE.p}">${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

// Responsive + dark-mode rules. Gmail (web and apps), Apple Mail and most mobile
// clients honour <style> media queries; clients that don't still get readable
// inline-styled output that wraps instead of overflowing.
const HEAD_CSS = `
:root{color-scheme:light dark;supported-color-schemes:light dark;}
body,table,td,p,a,li{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
.em-content{word-wrap:break-word;overflow-wrap:break-word;}
@media only screen and (max-width:620px){
  .em-outer{padding:0 !important;}
  .em-card{border-radius:0 !important;border-left:0 !important;border-right:0 !important;}
  .em-content{padding:18px 16px !important;font-size:15px !important;}
  .em-h{word-break:break-word !important;}
  .em-table,.em-tbody,.em-tr,.em-td{display:block !important;width:100% !important;box-sizing:border-box !important;}
  .em-thead{display:none !important;}
  .em-tr{border:1px solid #e2dfd8 !important;border-radius:8px !important;margin:0 0 12px !important;overflow:hidden !important;}
  .em-td{border:0 !important;border-bottom:1px solid #eeece7 !important;padding:8px 12px !important;white-space:normal !important;}
  .em-td:last-child{border-bottom:0 !important;}
  .em-empty{display:none !important;}
  .em-lbl{display:block !important;}
}
@media (prefers-color-scheme:dark){
  .em-bg{background:#1b1a18 !important;}
  .em-card{background:#252422 !important;border-color:#3a3835 !important;}
  .em-content,.em-h,.em-th{color:#ecebe8 !important;}
  .em-th{background:#2f2e2b !important;border-color:#3a3835 !important;}
  .em-td{background:#252422 !important;border-color:#3a3835 !important;}
  .em-tr{border-color:#3a3835 !important;}
  .em-lbl,.em-foot{color:#a3a09a !important;}
  code,pre{background:#2f2e2b !important;color:#ecebe8 !important;}
  a{color:#fb923c !important;}
}`;

// Wrap rendered content in a full HTML email document.
export function emailDocument(bodyHtml, { title = '', footer = '' } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(title)}</title>
<style>${HEAD_CSS}</style></head>
<body class="em-bg" style="margin:0;padding:0;width:100%;background:#f6f5f2;">
<table class="em-bg" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f5f2;"><tr><td class="em-outer" align="center" style="padding:20px 10px;">
<table class="em-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:960px;background:#ffffff;border:1px solid #e2dfd8;border-radius:10px;">
<tr><td class="em-content" style="padding:24px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f1e1c;word-wrap:break-word;overflow-wrap:break-word;">
${bodyHtml}
${footer ? `<p class="em-foot" style="margin:24px 0 0;font-size:12px;color:#6b6862;">${esc(footer)}</p>` : ''}
</td></tr></table>
</td></tr></table>
</body></html>`;
}
