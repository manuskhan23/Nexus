import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = String(children).replace(/\n$/, '');

  function handleCopy() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="my-3 max-w-full overflow-hidden rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-zinc-800 px-3 py-1.5 text-xs text-slate-500 dark:text-zinc-400">
        <span className="font-mono">{className?.replace('language-', '') || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-zinc-100 cursor-pointer"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto p-3 text-xs leading-relaxed text-slate-900 dark:text-zinc-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function normalizeMarkdown(raw: string): string {
  if (!raw) return '';
  let inFence = false;
  return raw
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      if (/^\s*\|.*\|\s*$/.test(line)) {
        return line.replace(/<br\s*\/?>/gi, ' · ');
      }
      return line.replace(/<br\s*\/?>/gi, '  \n');
    })
    .join('\n');
}

export function MarkdownContent({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  const normalized = normalizeMarkdown(content);

  return (
    <div
      className={`min-w-0 max-w-full space-y-2.5 break-words [overflow-wrap:anywhere]${
        streaming ? ' streaming-cursor' : ''
      }`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p({ children }) {
            return <p className="leading-relaxed">{children}</p>;
          },
          ul({ children }) {
            return <ul className="list-disc pl-5 space-y-1">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal pl-5 space-y-1">{children}</ol>;
          },
          h1({ children }) {
            return <h1 className="text-base font-semibold pt-1">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-sm font-semibold pt-1">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-sm font-semibold pt-1">{children}</h3>;
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 underline break-all hover:opacity-80"
              >
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="my-3 w-full max-w-full overflow-x-auto rounded-lg border border-slate-200 dark:border-zinc-800">
                <table className="w-full border-collapse text-left text-xs">{children}</table>
              </div>
            );
          },
          thead({ children }) {
            return (
              <thead className="bg-slate-50 dark:bg-zinc-950/60 border-b border-slate-200 dark:border-zinc-800">
                {children}
              </thead>
            );
          },
          tr({ children }) {
            return (
              <tr className="border-b border-slate-200 dark:border-zinc-800 last:border-b-0">
                {children}
              </tr>
            );
          },
          th({ children }) {
            return (
              <th className="px-3 py-2 font-semibold text-slate-700 dark:text-zinc-300 whitespace-nowrap">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="px-3 py-2 align-top text-slate-800 dark:text-zinc-200 break-words [overflow-wrap:anywhere]">
                {children}
              </td>
            );
          },
          code({ className, children }) {
            const isBlock = Boolean(className) || String(children).includes('\n');
            return isBlock ? (
              <CodeBlock className={className}>{children}</CodeBlock>
            ) : (
              <code className="rounded bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs font-mono break-all">
                {children}
              </code>
            );
          },
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
