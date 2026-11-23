import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/**
 * Rendu Markdown (GFM : tableaux, cases à cocher, texte barré) aux couleurs du thème.
 * Le HTML brut contenu dans le texte n'est pas interprété (comportement par défaut de react-markdown).
 */
const components: Components = {
  h1: ({ node: _node, ...props }) => <h3 className="mt-5 mb-2 text-lg font-semibold first:mt-0" {...props} />,
  h2: ({ node: _node, ...props }) => <h4 className="mt-5 mb-2 text-base font-semibold first:mt-0" {...props} />,
  h3: ({ node: _node, ...props }) => <h5 className="mt-4 mb-1.5 text-sm font-semibold first:mt-0" {...props} />,
  h4: ({ node: _node, ...props }) => <h6 className="mt-3 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  p: ({ node: _node, ...props }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-1 pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />,
  li: ({ node: _node, ...props }) => <li className="leading-relaxed [&>ol]:my-1 [&>ul]:my-1" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground" {...props} />
  ),
  hr: () => <hr className="my-4 border-border" />,
  // Pas de navigation : un clic dans la WebView remplacerait l'application par la page.
  a: ({ node: _node, href, children }) => (
    <span className="text-brand-text underline underline-offset-2" title={href}>
      {children}
    </span>
  ),
  code: ({ node: _node, className, ...props }) => (
    <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]', className)} {...props} />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0" {...props} />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th className="border border-border bg-muted px-2 py-1 text-left font-semibold" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-border px-2 py-1 align-top" {...props} />,
  input: ({ node: _node, ...props }) => <input {...props} disabled className="mr-1.5 align-middle accent-primary" />,
};

interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={cn('break-words text-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
