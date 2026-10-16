// Minimal Markdown → email-safe HTML (inline styles, no dependencies).
// Supports: headings, paragraphs, bold/italic/code, links, bare URLs,
// bullet/numbered lists, tables, blockquotes, horizontal rules, code blocks.

const STYLE = {
  h1: 'margin:0 0 12px;font-size:22px;line-height:1.3;color:#1f1e1c;',
  h2: 'margin:28px 0 10px;padding-bottom:6px;font-size:18px;line-height:1.3;color:#1f1e1c;border-bottom:2px solid #c2410c;',
  h3: 'margin:20px 0 8px;font-size:16px;line-height:1.3;color:#1f1e1c;',
  h4: 'margin:16px 0 6px;font-size:14px;color:#1f1e1c;',
  p: 'margin:0 0 12px;',
  ul: 'margin:0 0 12px;padding-left:22px;',
  ol: 'margin:0 0 12px;padding-left:22px;',
  li: 'margin:0 0 4px;',
  table: 'border-collapse:collapse;width:100%;margin:0 0 16px;font-size:13px;line-height:1.4;',
  th: 'background:#f0eee9;color:#1f1e1c;text-align:left;font-weight:600;padding:8px 10px;border:1px solid #e2dfd8;white-space:nowrap;',
  td: 'padding:8px 10px;border:1px solid #e2dfd8;vertical-align:top;',
  tdAlt: 'padding:8px 10px;border:1px solid #e2dfd8;vertical-align:top;background:#faf9f7;',
  a: 'color:#c2410c;font-weight:600;text-decoration:underline;',
  code: 'font-family:Menlo,Consolas,monospace;font-size:12px;background:#f0eee9;padding:1px 4px;border-radius:4px;',
  pre: 'font-family:Menlo,Consolas,monospace;font-size:12px;background:#f0eee9;padding:10px 12px;border-radius:6px;white-space:pre-wrap;margin:0 0 12px;',
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
      out.push(`<${tag} style="${STYLE[tag]}">${inline(h[2])}</${tag}>`);
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
      const th = head.map((c) => `<th style="${STYLE.th}">${inline(c)}</th>`).join('');
      const tb = rows.map((r, n) => {
        const st = n % 2 ? STYLE.tdAlt : STYLE.td;
        return `<tr>${head.map((_, k) => {
          const cell = r[k] ?? '';
          const nowrap = /^\d{4}-\d{2}-\d{2}$/.test(cell) ? 'white-space:nowrap;' : '';
          return `<td style="${st}${nowrap}">${inline(cell)}</td>`;
        }).join('')}</tr>`;
      }).join('');
      out.push(`<table role="presentation" cellspacing="0" cellpadding="0" style="${STYLE.table}"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
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

// Wrap rendered content in a full HTML email document.
export function emailDocument(bodyHtml, { title = '', footer = '' } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f6f5f2;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f5f2;"><tr><td align="center" style="padding:20px 10px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:960px;background:#ffffff;border:1px solid #e2dfd8;border-radius:10px;">
<tr><td style="padding:24px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f1e1c;">
${bodyHtml}
${footer ? `<p style="margin:24px 0 0;font-size:12px;color:#6b6862;">${esc(footer)}</p>` : ''}
</td></tr></table>
</td></tr></table>
</body></html>`;
}
