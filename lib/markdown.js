/**
 * A small markdown renderer for the side panel.
 *
 * The answer is untrusted model output, so the source is escaped before any
 * tag is added. The subset is the one TerrierGPT actually returns: headings,
 * lists, bold, code, and links.
 */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function inline(escaped) {
  const codes = [];
  let text = escaped.replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000C${codes.length}\u0000`;
    codes.push(`<code>${code}</code>`);
    return token;
  });
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_, label, href) => `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`,
  );
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return text.replace(/\u0000C(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

export function renderMarkdown(raw) {
  const source = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!source) return '';

  const fences = [];
  const text = escapeHtml(source).replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    const token = `\u0000F${fences.length}\u0000`;
    fences.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\n${token}\n`;
  });

  const html = [];
  let list = null;
  const closeList = () => {
    if (!list) return;
    html.push(list === 'ol' ? '</ol>' : '</ul>');
    list = null;
  };

  for (const line of text.split('\n')) {
    const fence = line.match(/^\u0000F(\d+)\u0000$/);
    if (fence) {
      closeList();
      html.push(fences[Number(fence[1])]);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (list !== 'ul') {
        closeList();
        html.push('<ul>');
        list = 'ul';
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) {
      if (list !== 'ol') {
        closeList();
        html.push('<ol>');
        list = 'ol';
      }
      html.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return html.join('');
}
