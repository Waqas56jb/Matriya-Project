import React from 'react';

/** Next step: action-only line, no extra chrome. */
export default function NextStepBlock({ nextStep }) {
  const t = nextStep != null ? String(nextStep).trim() : '';
  if (!t) return null;
  return (
    <section className="ac-next-block" aria-labelledby="ac-next-heading">
      <h3 id="ac-next-heading" className="ac-block-title">
        Next step
      </h3>
      <p className="ac-next-action">{t}</p>
    </section>
  );
}
