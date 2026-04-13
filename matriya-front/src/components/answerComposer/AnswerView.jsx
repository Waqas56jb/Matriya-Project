import React, { useEffect } from 'react';
import DecisionHeader from './DecisionHeader';
import { assertSingleComposerDecision } from '../../utils/composerDecisionAssert';
import EvidenceBlock from './EvidenceBlock';
import ExternalContextBlock from './ExternalContextBlock';
import NextStepBlock from './NextStepBlock';
import './AnswerView.css';

/**
 * Decision-first layout (David): Decision → Evidence → Next step → External (optional).
 * No long answer prose, no separate blocked panel — gate is one line under Decision when present.
 */
export default function AnswerView({ data }) {
  useEffect(() => {
    assertSingleComposerDecision(data);
  }, [data]);

  if (!data || typeof data !== 'object') {
    return null;
  }

  const gateLine =
    data.blocked_reason != null && String(data.blocked_reason).trim()
      ? String(data.blocked_reason).trim()
      : null;

  const showExternal =
    data.decision_status !== 'VALID_CONCLUSION' &&
    Array.isArray(data.external_context) &&
    data.external_context.length > 0;

  return (
    <article className="answer-view" data-composer-view="1" data-layout="decision-first">
      <DecisionHeader
        decisionStatus={data.decision_status}
        gateLine={gateLine}
        routing={data.routing}
      />
      <EvidenceBlock evidence={data.evidence} />
      <NextStepBlock nextStep={data.next_step} />
      {showExternal ? <ExternalContextBlock items={data.external_context} /> : null}
    </article>
  );
}
