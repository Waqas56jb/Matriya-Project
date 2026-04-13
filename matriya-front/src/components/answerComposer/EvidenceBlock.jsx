import React from 'react';

function formatChannels(deltaSummary) {
  const ds = deltaSummary && typeof deltaSummary === 'object' ? deltaSummary : {};
  const channels = Array.isArray(ds.channels) ? ds.channels : [];
  const lines = [];
  for (const ch of channels) {
    if (!ch || typeof ch !== 'object') continue;
    if (ch.status === 'COMPARED' && ch.channel != null) {
      const d = ch.delta_pct != null ? `Δ ${ch.delta_pct}%` : '';
      lines.push(`${ch.channel}: ${d}`.trim());
    }
  }
  return lines;
}

/**
 * Evidence: runs, baseline, grade, delta, threshold — no raw JSON dump.
 */
export default function EvidenceBlock({ evidence }) {
  const e = evidence && typeof evidence === 'object' ? evidence : {};
  const runIds = Array.isArray(e.run_ids) ? e.run_ids : [];
  const baseline = e.baseline_run_id ?? null;
  const grade = e.data_grade ?? '—';
  const threshold = e.threshold != null && e.threshold !== '' ? String(e.threshold) : '—';
  const maxDelta = e.delta_summary?.max_delta_pct;
  const maxDeltaStr = maxDelta != null && maxDelta !== '' ? String(maxDelta) : '—';
  const channelLines = formatChannels(e.delta_summary);

  return (
    <section className="ac-evidence-block" aria-labelledby="ac-evidence-heading">
      <h3 id="ac-evidence-heading" className="ac-block-title">
        Evidence
      </h3>
      <dl className="ac-evidence-grid">
        <div className="ac-evidence-row">
          <dt>Runs</dt>
          <dd>{runIds.length ? runIds.join(', ') : '—'}</dd>
        </div>
        <div className="ac-evidence-row">
          <dt>Baseline run</dt>
          <dd>{baseline != null ? String(baseline) : '—'}</dd>
        </div>
        <div className="ac-evidence-row">
          <dt>Data grade</dt>
          <dd>{String(grade)}</dd>
        </div>
        <div className="ac-evidence-row">
          <dt>Max delta %</dt>
          <dd>{maxDeltaStr}</dd>
        </div>
        <div className="ac-evidence-row">
          <dt>Threshold</dt>
          <dd>{threshold}</dd>
        </div>
      </dl>
      {channelLines.length > 0 ? (
        <ul className="ac-evidence-channels">
          {channelLines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
