import React from 'react';

function compactRow(row, i) {
  if (row == null) return `Row ${i + 1}`;
  if (typeof row === 'string') return row.length > 160 ? `${row.slice(0, 157)}…` : row;
  if (typeof row === 'object') {
    const title = row.title || row.label || row.source || row.name;
    if (title) return String(title).slice(0, 160);
    try {
      const s = JSON.stringify(row);
      return s.length > 160 ? `${s.slice(0, 157)}…` : s;
    } catch {
      return `Row ${i + 1}`;
    }
  }
  return String(row).slice(0, 160);
}

/**
 * External context — optional, collapsed by default; not validated evidence.
 */
export default function ExternalContextBlock({ items }) {
  const list = Array.isArray(items) ? items : [];
  const count = list.length;
  if (count === 0) return null;

  return (
    <section className="ac-external-block" aria-labelledby="ac-external-heading">
      <details className="ac-external-details">
        <summary className="ac-external-summary" id="ac-external-heading">
          External context <span className="ac-external-count">({count})</span>
        </summary>
        <ul className="ac-external-list ac-external-list--compact">
          {list.map((row, i) => (
            <li key={i} className="ac-external-item">
              {compactRow(row, i)}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
