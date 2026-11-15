'use strict';

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function safeHref(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^(https?:\/\/|\/(?!\/)|#|mailto:)/i.test(value)) return value;
  return null;
}

/**
 * Small, dependency-free Markdown renderer for portal messages.
 *
 * Supported in addition to the usual inline emphasis:
 *   [Form Helper]{color=#7c3aed}
 *
 * Only literal hex colours are accepted. The colour decision belongs to the
 * sender; the portal only renders it.
 */
function renderInline(source) {
  const code = [];
  let value = escapeHtml(source);

  // Protect inline code before formatting markers are interpreted.
  value = value.replace(/`([^`\n]+)`/g, (_, inner) => {
    code.push(`<code>${inner}</code>`);
    return `\u0000${code.length - 1}\u0000`;
  });

  // Colour directive: [text]{color=#rgb} or [text]{color=#rrggbb}
  value = value.replace(
    /\[([^\]]+)\]\{color=(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\}/g,
    (_, text, color) => `<span class="md-color" style="color:${color}">${text}</span>`
  );

  // Safe links only.
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text, href) => {
    const safe = safeHref(href);
    return safe
      ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`
      : match;
  });

  value = value.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  return value.replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)]);
}

function renderMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';

  const lines = text.split('\n');
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Fenced code block.
    if (line.trim().startsWith('```')) {
      index += 1;
      const body = [];
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      output.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Headings.
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    // Unordered lists.
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(/^\s*[-*]\s+/, ''))}</li>`);
        index += 1;
      }
      output.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered lists.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        index += 1;
      }
      output.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Blockquotes.
    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      output.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    // Paragraph: gather consecutive plain lines.
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (
        !next.trim() ||
        /^(#{1,6})\s+/.test(next) ||
        /^\s*[-*]\s+/.test(next) ||
        /^\s*\d+\.\s+/.test(next) ||
        /^\s*>\s?/.test(next) ||
        next.trim().startsWith('```')
      ) {
        break;
      }
      paragraph.push(next.trim());
      index += 1;
    }
    output.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }

  return output.join('\n');
}

function plainMarkdown(source) {
  return String(source ?? '')
    .replace(/\[([^\]]+)\]\{color=#[0-9a-fA-F]{3,6}\}/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { renderMarkdown, plainMarkdown };
