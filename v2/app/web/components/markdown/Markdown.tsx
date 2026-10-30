// A ticket's Markdown, drawn as elements (model.ts). A heading of the text stays
// under the card's own: every level is the same quiet heading, `headingFrom` the
// outline's level it starts at.
import { createElement, type ReactNode } from 'react';
import { blocksOf, type Run } from './model.ts';
import './markdown.css';

const Runs = ({ runs }: { readonly runs: readonly Run[] }) => (
  <>
    {runs.map((run, index): ReactNode => {
      switch (run.kind) {
        case 'text': return run.text;
        case 'code': return <code key={index}>{run.text}</code>;
        case 'strong': return <strong key={index}><Runs runs={run.runs} /></strong>;
        case 'em': return <em key={index}><Runs runs={run.runs} /></em>;
        case 'link': return <a key={index} href={run.href} target="_blank" rel="noopener noreferrer"><Runs runs={run.runs} /></a>;
      }
    })}
  </>
);

export function Markdown({ text, headingFrom = 3, className = '' }: { readonly text: string; readonly headingFrom?: number; readonly className?: string }) {
  return (
    <div className={`markdown ${className}`.trim()} data-markdown="">
      {blocksOf(text).map((block, index) => {
        switch (block.kind) {
          case 'heading': return createElement(`h${Math.min(6, headingFrom)}`, { key: index, className: 'markdown-heading' }, <Runs runs={block.runs} />);
          case 'paragraph': return <p key={index}><Runs runs={block.runs} /></p>;
          case 'code': return <pre key={index}><code>{block.text}</code></pre>;
          case 'list': {
            const items = block.items.map((item, at) => <li key={at}><Runs runs={item} /></li>);
            return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
          }
        }
      })}
    </div>
  );
}
