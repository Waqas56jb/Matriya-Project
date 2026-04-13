import React from 'react';

/** Short display labels for decision_status (scientific decision surface — no prose answer). */
const STATUS_LABELS = {
  VALID_CONCLUSION: 'Valid conclusion',
  INSUFFICIENT_DATA: 'Insufficient data',
  INCONCLUSIVE: 'Inconclusive',
  REFERENCE_ONLY: 'Reference only',
  INVALID_EXPERIMENT: 'Invalid experiment',
  STRUCTURAL_INCOMPLETE: 'Structural incomplete'
};

/**
 * Decision-first: large status only. No long explanatory answer body.
 * Optional single-line gate (e.g. blocked_reason) — truncated.
 */
export default function DecisionHeader({ decisionStatus, gateLine, routing }) {
  const status = decisionStatus ?? '';
  const subtitle = STATUS_LABELS[status] || '';
  const gate =
    gateLine != null && String(gateLine).trim()
      ? String(gateLine).trim().slice(0, 220)
      : '';
  const route = routing != null && String(routing).trim() ? String(routing).trim() : '';

  return (
    <header className="ac-decision-header" data-decision-status={status}>
      <div className="ac-decision-header__bar" aria-hidden="true" />
      <div className="ac-decision-header__body">
        <p className="ac-decision-header__eyebrow">Decision</p>
        <h2 className="ac-decision-header__status" title={status}>
          {status}
        </h2>
        {subtitle && status !== subtitle ? (
          <p className="ac-decision-header__subtitle">{subtitle}</p>
        ) : null}
        {route ? <p className="ac-decision-header__routing">{route}</p> : null}
        {gate ? <p className="ac-decision-header__gate">{gate}</p> : null}
      </div>
    </header>
  );
}
