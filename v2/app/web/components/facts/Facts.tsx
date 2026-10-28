// A line of facts the models join with " · " (a session's state, a plan's
// progress, the tower's summary), drawn as cells parted by a hairline, never
// as a string of middle dots (Hallmark's gate 63, lane j6-ui-hallmark): each
// fact is kept whole on a line, and a screen reader hears them parted by a
// comma. A leading figure ("4 sessions running") is set as a figure.
import { Fragment } from 'react';

const FIGURE = /^(\d[\d\s  .,]*(?:\s?[% ]?%)?)(\s.+)$/u;

export function Facts({ text, figures = false }: { readonly text: string; readonly figures?: boolean }) {
  return (
    <>
      {text.split(' · ').map((fact, i) => {
        const figure = figures ? FIGURE.exec(fact) : null;
        return (
          <Fragment key={i}>
            {i > 0 ? <span className="fact-sep"><span className="sr-only">, </span></span> : null}
            <span className="fact">{figure ? <><b className="fact-figure">{figure[1]}</b>{figure[2]}</> : fact}</span>
          </Fragment>
        );
      })}
    </>
  );
}
