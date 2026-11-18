/**
 * AIMarkdownRenderer.tsx
 * Zero-dependency React JSX Markdown renderer for internal AI assistant responses.
 * Supports headings, lists, GFM tables (scrollable + copyable), fenced code blocks (with copy),
 * blockquotes, inline formatting (**bold**, *italic*, ~~strike~~, `code`), links, and images.
 */
import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { CheckIcon, ClipboardListIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';

interface AIMarkdownRendererProps {
  content: string;
  segments?: Array<{ type: 'text' | 'image'; content: any }>;
  isUser?: boolean;
}

function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function openExternalUrl(url: string) {
  const clean = url.trim();
  if (!isSafeHttpUrl(clean)) return;
  if (ipc.shell?.openExternal) {
    ipc.shell.openExternal(clean);
  } else {
    window.open(clean, '_blank', 'noopener,noreferrer');
  }
}

/** Inline tokenizer for bold, italic, strike, code, images, markdown links, and bare URLs */
function renderInline(text: string, isUser?: boolean): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const pattern =
    /(`[^`\n]+`|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|https?:\/\/[^\s<>()]+)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `inl_${keyIdx++}`;

    if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
      tokens.push(
        <code
          key={key}
          className={`px-1.5 py-0.5 rounded text-[12px] font-mono ${
            isUser ? 'bg-white/20 text-white' : 'bg-muted text-amber-300 border border-border/60'
          }`}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('![')) {
      const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token);
      if (m && isSafeHttpUrl(m[2])) {
        tokens.push(
          <img
            key={key}
            src={m[2].trim()}
            alt={m[1] || ''}
            className="max-w-full max-h-56 rounded-lg my-1.5 border border-border/60 object-contain"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        );
      } else {
        tokens.push(token);
      }
    } else if (token.startsWith('[')) {
      const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (m && isSafeHttpUrl(m[2])) {
        const href = m[2].trim();
        tokens.push(
          <button
            key={key}
            type="button"
            onClick={() => openExternalUrl(href)}
            className={`underline underline-offset-2 text-left hover:opacity-80 ${
              isUser ? 'text-blue-100' : 'text-blue-400'
            }`}
            title={href}
          >
            {m[1]}
          </button>
        );
      } else {
        tokens.push(token);
      }
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      tokens.push(<strong key={key} className="font-semibold">{renderInline(token.slice(2, -2), isUser)}</strong>);
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      tokens.push(<del key={key} className="opacity-75">{renderInline(token.slice(2, -2), isUser)}</del>);
    } else if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      tokens.push(<em key={key} className="italic">{renderInline(token.slice(1, -1), isUser)}</em>);
    } else if (isSafeHttpUrl(token)) {
      tokens.push(
        <button
          key={key}
          type="button"
          onClick={() => openExternalUrl(token)}
          className={`underline underline-offset-2 break-all text-left hover:opacity-80 ${
            isUser ? 'text-blue-100' : 'text-blue-400'
          }`}
        >
          {token}
        </button>
      );
    } else {
      tokens.push(token);
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }
  return tokens;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="my-2 rounded-lg border border-border overflow-hidden bg-background/80">
      <div className="flex items-center justify-between px-3 py-1 bg-muted/70 border-b border-border/70 text-[11px] text-muted-foreground">
        <span className="font-mono uppercase tracking-wider">{lang || 'text'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
        >
          {copied ? <CheckIcon className="w-3.5 h-3.5 text-green-400" /> : <ClipboardListIcon className="w-3.5 h-3.5" />}
          <span>{copied ? tr('Đã copy') : tr('Copy')}</span>
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-xs font-mono leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const stripped = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return stripped.split('|').map(c => c.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') && !trimmed.includes('-')) return false;
  const cells = parseTableRow(trimmed);
  return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c));
}

function TableBlock({ lines, isUser }: { lines: string[]; isUser?: boolean }) {
  const [copied, setCopied] = useState(false);
  const headers = parseTableRow(lines[0]);
  const bodyRows = lines.slice(2).map(parseTableRow);

  const handleCopyTsv = () => {
    const tsv = [headers, ...bodyRows].map(r => r.join('\t')).join('\n');
    navigator.clipboard.writeText(tsv);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-2 rounded-lg border border-border overflow-hidden bg-background/60">
      <div className="flex items-center justify-end px-2.5 py-1 bg-muted/50 border-b border-border/60">
        <button
          type="button"
          onClick={handleCopyTsv}
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? <CheckIcon className="w-3 h-3 text-green-400" /> : <ClipboardListIcon className="w-3 h-3" />}
          <span>{copied ? tr('Đã copy bảng') : tr('Copy bảng')}</span>
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-muted/70 border-b border-border">
              {headers.map((h, i) => (
                <th key={i} className="px-3 py-2 text-left font-semibold text-foreground whitespace-nowrap">
                  {renderInline(h, isUser)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, ri) => (
              <tr key={ri} className="border-b border-border/50 last:border-b-0 hover:bg-muted/30">
                {headers.map((_, ci) => (
                  <td key={ci} className="px-3 py-1.5 align-top text-foreground/90">
                    {renderInline(row[ci] ?? '', isUser)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderMarkdownBlocks(markdown: string, isUser?: boolean): React.ReactNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 1. Fenced code block ```
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(<CodeBlock key={`b_${blockKey++}`} lang={lang} code={codeLines.join('\n')} />);
      continue;
    }

    // 2. GFM Table
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push(<TableBlock key={`b_${blockKey++}`} lines={tableLines} isUser={isUser} />);
      continue;
    }

    // 3. Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(<hr key={`b_${blockKey++}`} className="my-2.5 border-border/70" />);
      i++;
      continue;
    }

    // 4. Headings (# to ####)
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const cls =
        level === 1 ? 'text-base font-bold mt-2.5 mb-1'
        : level === 2 ? 'text-sm font-bold mt-2 mb-1'
        : 'text-[13px] font-semibold mt-1.5 mb-0.5';
      blocks.push(
        <div key={`b_${blockKey++}`} className={cls}>
          {renderInline(headingMatch[2], isUser)}
        </div>
      );
      i++;
      continue;
    }

    // 5. Blockquote (>)
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={`b_${blockKey++}`}
          className={`my-1.5 pl-3 border-l-2 italic ${
            isUser ? 'border-white/50 text-blue-50' : 'border-blue-500/70 text-muted-foreground'
          }`}
        >
          {quoteLines.map((ql, idx) => (
            <div key={idx}>{renderInline(ql, isUser)}</div>
          ))}
        </blockquote>
      );
      continue;
    }

    // 6. Unordered list (-, *, •)
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={`b_${blockKey++}`} className="list-disc pl-5 my-1.5 space-y-1">
          {items.map((item, idx) => (
            <li key={idx} className="leading-relaxed">{renderInline(item, isUser)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // 7. Ordered list (1. or 1))
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={`b_${blockKey++}`} className="list-decimal pl-5 my-1.5 space-y-1">
          {items.map((item, idx) => (
            <li key={idx} className="leading-relaxed">{renderInline(item, isUser)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // 8. Paragraph lines until blank line or structural marker
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      const curTrim = cur.trim();
      if (!curTrim) break;
      if (
        curTrim.startsWith('```') ||
        curTrim.startsWith('>') ||
        /^#{1,4}\s+/.test(curTrim) ||
        /^[-*•]\s+/.test(curTrim) ||
        /^\d+[.)]\s+/.test(curTrim) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(curTrim) ||
        (curTrim.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        break;
      }
      paraLines.push(cur);
      i++;
    }
    blocks.push(
      <p key={`b_${blockKey++}`} className="my-1 leading-relaxed whitespace-pre-wrap break-words">
        {renderInline(paraLines.join('\n'), isUser)}
      </p>
    );
  }

  return blocks;
}

export default function AIMarkdownRenderer({ content, segments, isUser }: AIMarkdownRendererProps) {
  if (segments && segments.length > 0) {
    return (
      <div className="space-y-2 text-[13px]">
        {segments.map((seg, si) =>
          seg.type === 'image' && Array.isArray(seg.content) ? (
            <div key={si} className="flex flex-wrap gap-1.5">
              {seg.content.map((url: string, ui: number) => (
                <img
                  key={ui}
                  src={url}
                  alt=""
                  className="max-w-full max-h-48 rounded-lg object-cover border border-input/30"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ))}
            </div>
          ) : seg.type === 'text' && seg.content ? (
            <div key={si}>{renderMarkdownBlocks(String(seg.content), isUser)}</div>
          ) : null
        )}
      </div>
    );
  }

  return (
    <div className="text-[13px] space-y-1">
      {renderMarkdownBlocks(content || '', isUser)}
    </div>
  );
}
