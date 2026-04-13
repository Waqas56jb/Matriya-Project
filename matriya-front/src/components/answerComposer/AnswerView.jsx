import React, { useEffect } from 'react';
import DecisionHeader from './DecisionHeader';
import { assertSingleComposerDecision } from '../../utils/composerDecisionAssert';
import EvidenceBlock from './EvidenceBlock';
import ExternalContextBlock from './ExternalContextBlock';
import BlockedReasonBlock from './BlockedReasonBlock';
import NextStepBlock from './NextStepBlock';
import './AnswerView.css';

/**
 * Pure representation of composeAnswer JSON. Pass API response as-is (data prop).
 */
export default function AnswerView({ data }) {
  useEffect(() => {
    assertSingleComposerDecision(data);
  }, [data]);

  if (!data || typeof data !== 'object') {
    return null;
  }

  // Milestone 2 (David): do not surface external_context for VALID_CONCLUSION unless product explicitly allows it later.
  const showExternal =
    data.decision_status !== 'VALID_CONCLUSION' &&
    Array.isArray(data.external_context);

  return (
    <article className="answer-view" data-composer-view="1">
      <DecisionHeader decisionStatus={data.decision_status} answer={data.answer} />
      <EvidenceBlock evidence={data.evidence} />
      {showExternal ? <ExternalContextBlock items={data.external_context} /> : null}
      <BlockedReasonBlock blockedReason={data.blocked_reason} />
      <NextStepBlock nextStep={data.next_step} />
    </article>
  );
}
