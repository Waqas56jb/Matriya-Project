/**
 * Dev-time UI integrity: composer answer must not advertise a second efficacy label
 * (VALID_CONCLUSION vs INCONCLUSIVE) different from decision_status.
 */
const EFFICACY = ['VALID_CONCLUSION', 'INCONCLUSIVE'];

export function assertSingleComposerDecision(data) {
  if (!data || typeof data !== 'object') return;
  const d = data.decision_status;
  if (typeof d !== 'string' || !EFFICACY.includes(d)) return;

  const answer = String(data.answer || '');
  const alt = d === 'VALID_CONCLUSION' ? 'INCONCLUSIVE' : 'VALID_CONCLUSION';
  const re = new RegExp(`\\b${alt}\\b`);
  if (re.test(answer)) {
    console.error('[Matriya] Composer UI integrity: answer text must not name alternate efficacy decision', {
      decision_status: d,
      forbidden_in_answer: alt,
    });
  }
  console.assert(
    !re.test(answer),
    '[Matriya] answer text must not contain alternate efficacy decision label'
  );
}
