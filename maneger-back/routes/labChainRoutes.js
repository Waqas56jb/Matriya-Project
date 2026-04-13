/**
 * Lab Chain API — management-back
 *
 * System of record for lab chain UI operations (management-front → LabTab).
 * Shares the same Supabase PostgreSQL DB as matriya-back.
 *
 * ENDPOINT MAP
 *   GET  /api/lab/formulations              list formulations
 *   GET  /api/lab/formulations/:id          single formulation + materials + runs
 *   GET  /api/lab/runs                      list production runs
 *   GET  /api/lab/runs/:id                  single run + steps + measurements + outcomes
 *   GET  /api/lab/measurements              list measurements
 *   GET  /api/lab/runs/:id/fsctm            FSCTM completeness + OVAT status
 *
 *   POST  /api/lab/runs                      create REAL run (enters DRAFT)
 *   PATCH /api/lab/runs/:id                 update run metadata (DRAFT or SUBMITTED only)
 *   POST  /api/lab/runs/:id/measurements    add measurement + outcome data (with FSCTM fields)
 *   POST  /api/lab/runs/:id/submit          DRAFT → SUBMITTED
 *   POST  /api/lab/runs/:id/review          SUBMITTED → REVIEWED
 *   POST  /api/lab/runs/:id/approve         REVIEWED → APPROVED (hard-blocks on OVAT + FSCTM)
 *   POST  /api/lab/runs/:id/evaluate        APPROVED → sets VALID_CONCLUSION or INCONCLUSIVE
 *                                           based on viscosity delta vs baseline threshold
 *
 * WORKFLOW STATE MACHINE (REAL runs only)
 *   DRAFT → SUBMITTED → REVIEWED → APPROVED → INGESTED → LOCKED
 *   HISTORICAL is read-only. No transition allowed.
 *
 * CONCLUSION STATES (exactly 6, no others)
 *   VALID_CONCLUSION          OVAT valid, FSCTM complete, delta above threshold
 *   INCONCLUSIVE              OVAT valid, FSCTM complete, delta below threshold
 *   INVALID_EXPERIMENT        NON_CONTROLLED run (>1 variable changed)
 *   INSUFFICIENT_DATA         Required measurement values missing
 *   STRUCTURAL_INCOMPLETE     K/C/B/L mapping missing
 *   REFERENCE_ONLY            HISTORICAL run — cannot support causal conclusion
 *
 * ENFORCEMENT (hard blocks — return 400, never bypass)
 *   D3:   operator_name, production_date, production_temperature_c required for REAL
 *   D3:   mixing_speed_rpm + mixing_duration_min required on every step for REAL
 *   OVAT: baseline_run_id required before approval
 *   OVAT: declared_changed_variable required before approval
 *   FSCTM: K (load_type) required on run before approval
 *   FSCTM: C (capacity_ratings, all 5 keys, valid structure) required on outcome
 *   FSCTM: B (failure_signature) required on outcome before approval
 *   FSCTM: L (stability_classification) required on outcome before approval
 */

import pg from 'pg';
import express from 'express';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// DB POOL
// ─────────────────────────────────────────────────────────────────────────────
function buildPool() {
  const connStr = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connStr) throw new Error('POSTGRES_URL is not set — lab chain DB unavailable');
  return new pg.Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
  });
}
let _pool = null;
function pool() {
  if (!_pool) _pool = buildPool();
  return _pool;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const VALID_LOAD_TYPES = ['THERMAL', 'MOISTURE', 'MECHANICAL', 'CHEMICAL', 'CYCLIC'];

const CAPACITY_KEYS = ['A', 'D', 'G', 'R', 'T'];

const VALID_CONCLUSION_STATES = [
  'VALID_CONCLUSION',
  'INCONCLUSIVE',
  'INVALID_EXPERIMENT',
  'INSUFFICIENT_DATA',
  'STRUCTURAL_INCOMPLETE',
  'REFERENCE_ONLY',
];

/**
 * VALID_DECLARED_VARIABLES
 *
 * The only process variables that may be declared as the single changed variable
 * in an OVAT experiment. This list is derived from measurable fields in the
 * production_runs + production_steps schema.
 *
 * Rules:
 *   - declared_changed_variable must be one of these exact strings
 *   - The system compares the corresponding field(s) against the baseline at approval
 *   - "material_substitution" covers a material_name change in any step
 */
const VALID_DECLARED_VARIABLES = [
  'mixing_speed_rpm',         // step-level: one or more steps with different rpm
  'mixing_duration_min',      // step-level: one or more steps with different duration
  'production_temperature_c', // run-level: temperature during production
  'order_of_addition',        // step-level: order of material addition changed
  'material_substitution',    // step-level: material_name changed in one step
  'batch_size_g',             // run-level: batch size changed
];

/**
 * VALID_STABILITY_CLASSIFICATIONS
 *
 * Values for outcomes.stability_classification (L in FSCTM).
 * Represents how the material behaves across repeated measurements or aging.
 *
 *   STABLE              measurements consistent across time points
 *   DEGRADING           properties worsen over time (viscosity drop, pH shift)
 *   IMPROVING           properties improve over time (post-cure, continued reaction)
 *   VARIABLE            inconsistent — no clear trend detected
 *   SINGLE_POINT        only one measurement; stability cannot be assessed
 */
const VALID_STABILITY_CLASSIFICATIONS = [
  'STABLE',
  'DEGRADING',
  'IMPROVING',
  'VARIABLE',
  'SINGLE_POINT',
];

/**
 * DEFAULT_VISCOSITY_THRESHOLD_PCT
 *
 * Minimum % change in viscosity (any rpm channel) required to classify an
 * outcome as VALID_CONCLUSION rather than INCONCLUSIVE.
 *
 * Overridable per request via body.threshold_pct.
 * Rationale: changes below this level are within typical measurement noise for
 * Brookfield viscometry at the rpm values used in INTUMESCENT formulations.
 */
const DEFAULT_VISCOSITY_THRESHOLD_PCT = 10;

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Lab chain DB unavailable. Set POSTGRES_URL.' });
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * D3 enforcement — REAL run body validation.
 * Returns array of error strings (empty = pass).
 */
function validateRealRunBody(body) {
  const errors = [];

  if (!body.batch_id || typeof body.batch_id !== 'string') {
    errors.push('batch_id is required');
  }
  if (!body.formulation_id || typeof body.formulation_id !== 'string') {
    errors.push('formulation_id (UUID) is required');
  }
  if (!body.operator_name || typeof body.operator_name !== 'string') {
    errors.push('operator_name is required for REAL runs (D3)');
  }
  if (!body.production_date || typeof body.production_date !== 'string') {
    errors.push('production_date (YYYY-MM-DD) is required for REAL runs');
  }
  if (body.production_temperature_c == null) {
    errors.push('production_temperature_c is required for REAL runs');
  }
  if (!Array.isArray(body.steps) || body.steps.length === 0) {
    errors.push('steps[] is required and must be non-empty for REAL runs');
  } else {
    body.steps.forEach((step, i) => {
      const idx = `steps[${i}]`;
      if (!step.material_name) errors.push(`${idx}: material_name is required`);
      if (step.step_sequence == null) errors.push(`${idx}: step_sequence is required`);
      if (step.mixing_speed_rpm == null) errors.push(`${idx}: mixing_speed_rpm is required (D3)`);
      if (step.mixing_duration_min == null) errors.push(`${idx}: mixing_duration_min is required (D3)`);
    });
  }

  // declared_changed_variable — optional at creation, but must be from the allowed list if provided
  if (body.declared_changed_variable != null) {
    if (!VALID_DECLARED_VARIABLES.includes(body.declared_changed_variable)) {
      errors.push(
        `declared_changed_variable "${body.declared_changed_variable}" is not in the allowed list. ` +
        `Allowed: ${VALID_DECLARED_VARIABLES.join(', ')}`
      );
    }
  }

  return errors;
}

/**
 * Validate capacity_ratings JSONB structure.
 * Rules:
 *   - Must be a plain object (not array, not null)
 *   - Must contain exactly all 5 keys: A, D, G, R, T
 *   - Each key must have: { value (non-null), scale ("raw"|"score_0_10"), unit (string) }
 *   - No mixing raw/score without labeling (scale field is mandatory)
 *
 * Returns array of error strings (empty = valid).
 */
function validateCapacityRatings(cr) {
  if (typeof cr !== 'object' || cr === null || Array.isArray(cr)) {
    return ['capacity_ratings must be a JSON object'];
  }

  const errors = [];

  for (const key of CAPACITY_KEYS) {
    if (!(key in cr)) {
      errors.push(`capacity_ratings.${key} is missing (required: A=Adhesion, D=Durability, G=Growth, R=Reaction, T=Thermal)`);
      continue;
    }
    const entry = cr[key];
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`capacity_ratings.${key} must be an object with {value, scale, unit}`);
      continue;
    }
    if (entry.value === undefined || entry.value === null) {
      errors.push(`capacity_ratings.${key}.value is required`);
    }
    if (!['raw', 'score_0_10'].includes(entry.scale)) {
      errors.push(`capacity_ratings.${key}.scale must be "raw" or "score_0_10", got: "${entry.scale}"`);
    }
    if (!entry.unit || typeof entry.unit !== 'string' || entry.unit.trim() === '') {
      errors.push(`capacity_ratings.${key}.unit is required (use "N/A" if no unit)`);
    }
  }

  return errors;
}

/**
 * OVAT enforcement — compare REAL run vs baseline.
 * Returns { run_type, changed_variables[] }
 *
 * run_type values:
 *   CONTROLLED_OVAT   exactly 1 variable changed vs baseline
 *   NON_CONTROLLED    >1 variables changed — causal conclusion is INVALID
 *   REPLICATION       0 variables changed
 *   NO_BASELINE       baseline_run_id not set (blocked before this call)
 */
async function evaluateOVAT(runId, client) {
  const { rows: [run] } = await client.query(
    `SELECT * FROM production_runs WHERE id = $1`, [runId]
  );

  if (!run?.baseline_run_id) {
    return { run_type: 'NO_BASELINE', changed_variables: [] };
  }

  const [{ rows: runSteps }, { rows: baseSteps }, { rows: [baseline] }] = await Promise.all([
    client.query(
      `SELECT step_sequence, mixing_speed_rpm, mixing_duration_min, material_name, order_of_addition
       FROM production_steps WHERE production_run_id = $1 ORDER BY step_sequence`, [runId]
    ),
    client.query(
      `SELECT step_sequence, mixing_speed_rpm, mixing_duration_min, material_name, order_of_addition
       FROM production_steps WHERE production_run_id = $1 ORDER BY step_sequence`, [run.baseline_run_id]
    ),
    client.query(
      `SELECT production_temperature_c, batch_size_g FROM production_runs WHERE id = $1`,
      [run.baseline_run_id]
    ),
  ]);

  const changed = [];

  if (baseline) {
    if (String(run.production_temperature_c) !== String(baseline.production_temperature_c)) {
      changed.push('production_temperature_c');
    }
    if (run.batch_size_g != null && baseline.batch_size_g != null &&
        String(run.batch_size_g) !== String(baseline.batch_size_g)) {
      changed.push('batch_size_g');
    }
  }

  const baseMap = Object.fromEntries(baseSteps.map(s => [s.step_sequence, s]));
  for (const step of runSteps) {
    const b = baseMap[step.step_sequence];
    if (!b) continue;
    if (String(step.mixing_speed_rpm) !== String(b.mixing_speed_rpm)) {
      changed.push(`step_${step.step_sequence}:mixing_speed_rpm`);
    }
    if (String(step.mixing_duration_min) !== String(b.mixing_duration_min)) {
      changed.push(`step_${step.step_sequence}:mixing_duration_min`);
    }
    if (step.material_name !== b.material_name) {
      changed.push(`step_${step.step_sequence}:material_name`);
    }
    if (step.order_of_addition !== b.order_of_addition) {
      changed.push(`step_${step.step_sequence}:order_of_addition`);
    }
  }

  const unique = [...new Set(changed)];
  const declared = run.declared_changed_variable;

  let run_type;
  if (unique.length === 0) {
    run_type = 'REPLICATION';
  } else if (unique.length === 1) {
    run_type = 'CONTROLLED_OVAT';
  } else {
    // If every detected change belongs to the declared variable (e.g. multiple steps
    // all changed the same rpm), still count as OVAT.
    const allMatchDeclared = !!declared && unique.every(v => v.includes(declared));
    run_type = allMatchDeclared ? 'CONTROLLED_OVAT' : 'NON_CONTROLLED';
  }

  return { run_type, changed_variables: unique };
}

/**
 * FSCTM completeness check.
 * Validates that all four model components are present AND structurally valid.
 *
 * K — load_type on production_runs (must be a valid load type)
 * C — capacity_ratings on outcomes (must pass validateCapacityRatings)
 * B — failure_signature on outcomes (must be non-empty string)
 * L — stability_classification on outcomes (must be non-empty string)
 *
 * Returns { complete: bool, blocking_errors: string[] }
 * blocking_errors is empty when complete = true.
 */
async function checkFSCTMCompleteness(runId, client) {
  const { rows: [run] } = await client.query(
    `SELECT load_type FROM production_runs WHERE id = $1`, [runId]
  );

  const { rows: outcomes } = await client.query(
    `SELECT o.capacity_ratings, o.failure_signature, o.stability_classification
     FROM measurements m
     JOIN outcomes o ON o.measurement_id = m.id
     WHERE m.production_run_id = $1`, [runId]
  );

  const errors = [];

  // K — load_type
  if (!run?.load_type) {
    errors.push('K missing: load_type is required on production_runs before approval');
  } else if (!VALID_LOAD_TYPES.includes(run.load_type)) {
    errors.push(`K invalid: load_type "${run.load_type}" must be one of ${VALID_LOAD_TYPES.join(', ')}`);
  }

  // C, B, L — require at least one outcome
  if (outcomes.length === 0) {
    errors.push('C missing: capacity_ratings requires at least one linked outcome (submit measurements first)');
    errors.push('B missing: failure_signature requires at least one linked outcome');
    errors.push('L missing: stability_classification requires at least one linked outcome');
  } else {
    const o = outcomes[0];

    // C — capacity_ratings structural validation
    if (!o.capacity_ratings) {
      errors.push('C missing: capacity_ratings is required on outcome');
    } else {
      const crErrors = validateCapacityRatings(o.capacity_ratings);
      crErrors.forEach(e => errors.push(`C invalid: ${e}`));
    }

    // B — failure_signature
    if (!o.failure_signature || o.failure_signature.trim() === '') {
      errors.push('B missing: failure_signature is required on outcome');
    }

    // L — stability_classification
    if (!o.stability_classification || o.stability_classification.trim() === '') {
      errors.push('L missing: stability_classification is required on outcome');
    }
  }

  return { complete: errors.length === 0, blocking_errors: errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lab/formulations
// ─────────────────────────────────────────────────────────────────────────────
router.get('/formulations', async (req, res) => {
  try {
    const { base_id, source_file, limit = 50, offset = 0 } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (base_id) { params.push(base_id); where += ` AND f.base_id = $${params.length}`; }
    if (source_file) { params.push(source_file); where += ` AND f.source_file = $${params.length}`; }
    params.push(parseInt(limit, 10));
    params.push(parseInt(offset, 10));

    const { rows } = await pool().query(`
      SELECT f.id, f.source_id, f.raw_source_id, f.id_suffix,
             f.base_id, f.version, f.product_name,
             f.source_file, f.source_sheet,
             f.composition_scale, f.created_at,
             COUNT(fm.id)::int AS material_count
      FROM formulations f
      LEFT JOIN formulation_materials fm ON fm.formulation_id = f.id
      ${where}
      GROUP BY f.id
      ORDER BY f.base_id, f.version NULLS FIRST, f.source_id
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ data: rows, count: rows.length });
  } catch (err) {
    console.error('[GET /api/lab/formulations]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lab/formulations/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/formulations/:id', async (req, res) => {
  try {
    const { rows: [formulation] } = await pool().query(
      `SELECT * FROM formulations WHERE id = $1`, [req.params.id]
    );
    if (!formulation) return res.status(404).json({ error: 'Formulation not found' });

    const { rows: materials } = await pool().query(
      `SELECT id, material_name, fraction, functional_group, col_index, recommended_material
       FROM formulation_materials WHERE formulation_id = $1 ORDER BY col_index`,
      [req.params.id]
    );

    const { rows: runs } = await pool().query(
      `SELECT id, batch_id, run_origin, workflow_state, run_type,
              production_date, operator_name, prep_location,
              production_temperature_c, batch_size_g,
              baseline_run_id, declared_changed_variable, hypothesis, load_type
       FROM production_runs WHERE formulation_id = $1
       ORDER BY production_date NULLS LAST, created_at`,
      [req.params.id]
    );

    res.json({ ...formulation, materials, runs });
  } catch (err) {
    console.error('[GET /api/lab/formulations/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lab/runs
// ─────────────────────────────────────────────────────────────────────────────
router.get('/runs', async (req, res) => {
  try {
    const { formulation_id, run_origin, workflow_state, limit = 50, offset = 0 } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (formulation_id) { params.push(formulation_id); where += ` AND pr.formulation_id = $${params.length}`; }
    if (run_origin) { params.push(run_origin.toUpperCase()); where += ` AND pr.run_origin = $${params.length}`; }
    if (workflow_state) { params.push(workflow_state.toUpperCase()); where += ` AND pr.workflow_state = $${params.length}`; }
    params.push(parseInt(limit, 10));
    params.push(parseInt(offset, 10));

    const { rows } = await pool().query(`
      SELECT pr.id, pr.batch_id, pr.run_origin, pr.workflow_state, pr.run_type,
             pr.production_date, pr.operator_name, pr.prep_location,
             pr.production_temperature_c, pr.batch_size_g,
             pr.baseline_run_id, pr.declared_changed_variable, pr.hypothesis, pr.load_type,
             f.source_id AS formulation_source_id, f.base_id, f.version,
             pr.created_at
      FROM production_runs pr
      JOIN formulations f ON f.id = pr.formulation_id
      ${where}
      ORDER BY pr.production_date NULLS LAST, pr.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ data: rows, count: rows.length });
  } catch (err) {
    console.error('[GET /api/lab/runs]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lab/runs/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/runs/:id', async (req, res) => {
  try {
    const { rows: [run] } = await pool().query(
      `SELECT pr.*, f.source_id AS formulation_source_id, f.base_id, f.version, f.product_name
       FROM production_runs pr
       JOIN formulations f ON f.id = pr.formulation_id
       WHERE pr.id = $1`, [req.params.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const { rows: steps } = await pool().query(
      `SELECT * FROM production_steps WHERE production_run_id = $1 ORDER BY step_sequence`,
      [req.params.id]
    );

    const { rows: measurements } = await pool().query(
      `SELECT m.id, m.test_date, m.days_since_production, m.linkage_confidence, m.raw_test_notes,
              o.id AS outcome_id, o.ph, o.v6, o.v12, o.v30, o.v60, o.test_date AS outcome_test_date,
              o.capacity_ratings, o.failure_signature,
              o.stability_classification, o.mechanism_tag, o.conclusion_status
       FROM measurements m
       LEFT JOIN outcomes o ON o.measurement_id = m.id
       WHERE m.production_run_id = $1
       ORDER BY m.test_date NULLS LAST`,
      [req.params.id]
    );

    res.json({ ...run, steps, measurements });
  } catch (err) {
    console.error('[GET /api/lab/runs/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lab/measurements
// ─────────────────────────────────────────────────────────────────────────────
router.get('/measurements', async (req, res) => {
  try {
    const { run_id, limit = 100, offset = 0 } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (run_id) { params.push(run_id); where += ` AND m.production_run_id = $${params.length}`; }
    params.push(parseInt(limit, 10));
    params.push(parseInt(offset, 10));

    const { rows } = await pool().query(`
      SELECT m.id, m.production_run_id, m.test_date, m.days_since_production,
             m.linkage_confidence, m.raw_test_notes,
             o.ph, o.v6, o.v12, o.v30, o.v60,
             o.capacity_ratings, o.failure_signature,
             o.stability_classification, o.mechanism_tag, o.conclusion_status
      FROM measurements m
      LEFT JOIN outcomes o ON o.measurement_id = m.id
      ${where}
      ORDER BY m.test_date NULLS LAST
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ data: rows, count: rows.length });
  } catch (err) {
    console.error('[GET /api/lab/measurements]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lab/runs/:id/fsctm  — FSCTM + OVAT status (read-only diagnostic)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/runs/:id/fsctm', async (req, res) => {
  const client = await pool().connect();
  try {
    const { rows: [run] } = await client.query(
      `SELECT id, batch_id, workflow_state, run_origin, run_type,
              baseline_run_id, declared_changed_variable
       FROM production_runs WHERE id = $1`, [req.params.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const { complete, blocking_errors } = await checkFSCTMCompleteness(req.params.id, client);

    let ovat = { run_type: 'HISTORICAL_REFERENCE', changed_variables: [] };
    if (run.run_origin === 'REAL') {
      ovat = await evaluateOVAT(req.params.id, client);
    }

    res.json({
      ...run,
      fsctm_complete: complete,
      fsctm_status: complete ? 'FSCTM_COMPLETE' : 'STRUCTURAL_INCOMPLETE',
      fsctm_blocking_errors: blocking_errors,
      ovat_run_type: ovat.run_type,
      ovat_changed_variables: ovat.changed_variables,
    });
  } catch (err) {
    console.error('[GET /api/lab/runs/:id/fsctm]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lab/runs  — create REAL run (enters DRAFT)
//
// Required body:
//   formulation_id, batch_id, operator_name, production_date,
//   production_temperature_c, steps[]
//   Each step: step_sequence, material_name, mixing_speed_rpm, mixing_duration_min
//
// Optional body:
//   batch_size_g, prep_location, baseline_run_id, declared_changed_variable,
//   hypothesis, load_type, load_conditions, raw_process_notes
//
// Returns: { id, batch_id, workflow_state: "DRAFT", steps_created }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/runs', async (req, res) => {
  const d3Errors = validateRealRunBody(req.body);
  if (d3Errors.length) {
    return res.status(400).json({ error: 'Validation failed (D3)', details: d3Errors });
  }

  if (req.body.load_type && !VALID_LOAD_TYPES.includes(req.body.load_type.toUpperCase())) {
    return res.status(400).json({
      error: `Invalid load_type "${req.body.load_type}". Must be one of: ${VALID_LOAD_TYPES.join(', ')}`
    });
  }

  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    const { rows: [form] } = await client.query(
      `SELECT id FROM formulations WHERE id = $1`, [req.body.formulation_id]
    );
    if (!form) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `formulation_id not found: ${req.body.formulation_id}` });
    }

    if (req.body.baseline_run_id) {
      // Self-reference guard: a run cannot be its own baseline
      // (newRun.id not yet assigned here — self-ref is impossible on CREATE; guard is in PATCH)
      const { rows: [brun] } = await client.query(
        `SELECT id FROM production_runs WHERE id = $1`, [req.body.baseline_run_id]
      );
      if (!brun) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `baseline_run_id not found: ${req.body.baseline_run_id}` });
      }
    }

    const { rows: [newRun] } = await client.query(`
      INSERT INTO production_runs (
        formulation_id, batch_id, run_origin, workflow_state,
        production_date, operator_name, prep_location,
        production_temperature_c, batch_size_g,
        baseline_run_id, declared_changed_variable, hypothesis,
        load_type, load_conditions, raw_process_notes
      ) VALUES ($1,$2,'REAL','DRAFT',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id, batch_id, workflow_state, run_origin, created_at
    `, [
      req.body.formulation_id,
      req.body.batch_id,
      req.body.production_date,
      req.body.operator_name,
      req.body.prep_location || null,
      req.body.production_temperature_c,
      req.body.batch_size_g || null,
      req.body.baseline_run_id || null,
      req.body.declared_changed_variable || null,
      req.body.hypothesis || null,
      req.body.load_type ? req.body.load_type.toUpperCase() : null,
      req.body.load_conditions ? JSON.stringify(req.body.load_conditions) : null,
      req.body.raw_process_notes || null,
    ]);

    const stepsInserted = [];
    for (const step of req.body.steps) {
      const { rows: [s] } = await client.query(`
        INSERT INTO production_steps (
          production_run_id, step_sequence, material_name,
          mixing_duration_min, mixing_speed_rpm,
          order_of_addition, raw_step_instruction
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id, step_sequence, material_name
      `, [
        newRun.id,
        step.step_sequence,
        step.material_name,
        step.mixing_duration_min,
        step.mixing_speed_rpm,
        step.order_of_addition || null,
        step.raw_step_instruction || null,
      ]);
      stepsInserted.push(s);
    }

    await client.query('COMMIT');

    res.status(201).json({
      ...newRun,
      steps_created: stepsInserted.length,
      next_step: `POST /api/lab/runs/${newRun.id}/measurements — add measurement + FSCTM outcome data`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: `batch_id "${req.body.batch_id}" already exists` });
    }
    console.error('[POST /api/lab/runs]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lab/runs/:id/measurements  — add measurement + outcome (FSCTM fields)
//
// Required body:
//   test_date, days_since_production
//   outcome: { ph, v6, v12, v30, v60,
//              failure_signature, stability_classification,
//              capacity_ratings: { A:{value,scale,unit}, D:..., G:..., R:..., T:... } }
//
// Optional body:
//   raw_test_notes, outcome.mechanism_tag
//
// Validates capacity_ratings structure before insert.
// Does NOT change workflow_state.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/runs/:id/measurements', async (req, res) => {
  const { test_date, outcome, raw_test_notes, days_since_production } = req.body;

  const bodyErrors = [];
  if (!test_date) bodyErrors.push('test_date is required');
  if (days_since_production == null) bodyErrors.push('days_since_production is required');
  if (!outcome || typeof outcome !== 'object') {
    bodyErrors.push('outcome object is required');
  } else {
    if (outcome.v6 == null && outcome.v12 == null && outcome.v30 == null && outcome.v60 == null) {
      bodyErrors.push('outcome must have at least one viscosity value (v6, v12, v30, or v60)');
    }
    if (!outcome.failure_signature || outcome.failure_signature.trim() === '') {
      bodyErrors.push('outcome.failure_signature is required (B — failure signature)');
    }
    if (!outcome.stability_classification || outcome.stability_classification.trim() === '') {
      bodyErrors.push('outcome.stability_classification is required (L — stability)');
    } else if (!VALID_STABILITY_CLASSIFICATIONS.includes(outcome.stability_classification)) {
      bodyErrors.push(
        `outcome.stability_classification "${outcome.stability_classification}" is not valid. ` +
        `Allowed: ${VALID_STABILITY_CLASSIFICATIONS.join(', ')}`
      );
    }
    if (!outcome.capacity_ratings) {
      bodyErrors.push('outcome.capacity_ratings is required (C — capacity vector)');
    } else {
      const crErrors = validateCapacityRatings(outcome.capacity_ratings);
      crErrors.forEach(e => bodyErrors.push(e));
    }
  }

  if (bodyErrors.length) {
    return res.status(400).json({ error: 'Measurement validation failed', details: bodyErrors });
  }

  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    const { rows: [run] } = await client.query(
      `SELECT id, run_origin, workflow_state FROM production_runs WHERE id = $1`, [req.params.id]
    );
    if (!run) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Run not found' });
    }
    if (run.run_origin !== 'REAL') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Measurements can only be added to REAL runs' });
    }
    if (run.workflow_state === 'LOCKED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Run is LOCKED. No further modifications allowed.' });
    }

    const { rows: [meas] } = await client.query(`
      INSERT INTO measurements (production_run_id, test_date, days_since_production,
                                linkage_confidence, raw_test_notes)
      VALUES ($1, $2, $3, 'HIGH', $4)
      RETURNING id
    `, [run.id, test_date, days_since_production, raw_test_notes || null]);

    const { rows: [out] } = await client.query(`
      INSERT INTO outcomes (measurement_id, test_date, ph, v6, v12, v30, v60,
                            capacity_ratings, failure_signature,
                            stability_classification, mechanism_tag, conclusion_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)
      RETURNING id
    `, [
      meas.id,
      test_date,
      outcome.ph || null,
      outcome.v6 || null,
      outcome.v12 || null,
      outcome.v30 || null,
      outcome.v60 || null,
      JSON.stringify(outcome.capacity_ratings),
      outcome.failure_signature,
      outcome.stability_classification,
      outcome.mechanism_tag || null,
    ]);

    await client.query('COMMIT');

    res.status(201).json({
      measurement_id: meas.id,
      outcome_id: out.id,
      run_id: run.id,
      workflow_state: run.workflow_state,
      fsctm_fields_recorded: {
        C: 'capacity_ratings ✓',
        B: 'failure_signature ✓',
        L: 'stability_classification ✓',
      },
      next_step: run.workflow_state === 'DRAFT'
        ? `POST /api/lab/runs/${run.id}/submit`
        : `Run is ${run.workflow_state}`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /api/lab/runs/:id/measurements]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lab/runs/:id/submit  — DRAFT → SUBMITTED
// ─────────────────────────────────────────────────────────────────────────────
router.post('/runs/:id/submit', async (req, res) => {
  const client = await pool().connect();
  try {
    const { rows: [run] } = await client.query(
      `SELECT id, workflow_state, run_origin FROM production_runs WHERE id = $1`, [req.params.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.run_origin !== 'REAL') {
      return res.status(400).json({ error: 'Only REAL runs can be submitted' });
    }
    if (run.workflow_state !== 'DRAFT') {
      return res.status(400).json({
        error: `Cannot submit. Current state: ${run.workflow_state}. Required: DRAFT`
      });
    }

    await client.query(
      `UPDATE production_runs SET workflow_state = 'SUBMITTED' WHERE id = $1`, [req.params.id]
    );

    res.json({
      id: req.params.id,
      workflow_state: 'SUBMITTED',
      next_step: `POST /api/lab/runs/${req.params.id}/review`,
    });
  } catch (err) {
    console.error('[POST /api/lab/runs/:id/submit]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lab/runs/:id/review  — SUBMITTED → REVIEWED
//
// Body (optional):
//   { "reviewer": "name", "review_note": "..." }
//
// Checks that measurement data exists before allowing REVIEWED state.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/runs/:id/review', async (req, res) => {
  const client = await pool().connect();
  try {
    const { rows: [run] } = await client.query(
      `SELECT id, workflow_state, run_origin FROM production_runs WHERE id = $1`, [req.params.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.run_origin !== 'REAL') {
      return res.status(400).json({ error: 'Only REAL runs can be reviewed' });
    }
    if (run.workflow_state !== 'SUBMITTED') {
      return res.status(400).json({
        error: `Cannot review. Current state: ${run.workflow_state}. Required: SUBMITTED`
      });
    }

    // Require at least one measurement before REVIEWED
    const { rows: measRows } = await client.query(
      `SELECT id FROM measurements WHERE production_run_id = $1 LIMIT 1`, [req.params.id]
    );
    if (measRows.length === 0) {
      return res.status(400).json({
        error: 'Cannot mark as REVIEWED: no measurements found. Submit measurement data first (POST /api/lab/runs/:id/measurements).'
      });
    }

    await client.query(
      `UPDATE production_runs SET workflow_state = 'REVIEWED' WHERE id = $1`, [req.params.id]
    );

    res.json({
      id: req.params.id,
      workflow_state: 'REVIEWED',
      reviewer: req.body?.reviewer || null,
      review_note: req.body?.review_note || null,
      next_step: `POST /api/lab/runs/${req.params.id}/approve`,
    });
  } catch (err) {
    console.error('[POST /api/lab/runs/:id/review]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lab/runs/:id/approve  — REVIEWED → APPROVED
//
// HARD BLOCKS (return 400, workflow does NOT advance):
//   1. Run is not in REVIEWED state
//   2. baseline_run_id is NULL (OVAT requirement)
//   3. declared_changed_variable is NULL (OVAT requirement)
//   4. Any FSCTM component missing or invalid (K/C/B/L)
//
// ALLOWED but sets conclusion_status = INVALID_EXPERIMENT:
//   5. NON_CONTROLLED run (>1 variable changed vs baseline)
//      — run is still APPROVED but causal conclusion is blocked
//
// Body (optional):
//   { "reviewer": "name", "review_note": "..." }
//
// On success:
//   - Sets workflow_state = APPROVED
//   - Sets run_type (CONTROLLED_OVAT / NON_CONTROLLED / REPLICATION)
//   - Sets conclusion_status on linked outcomes (one of the 6 valid states)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/runs/:id/approve', async (req, res) => {
  const client = await pool().connect();
  try {
    const { rows: [run] } = await client.query(
      `SELECT id, workflow_state, run_origin, baseline_run_id, declared_changed_variable
       FROM production_runs WHERE id = $1`, [req.params.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.run_origin !== 'REAL') {
      return res.status(400).json({ error: 'Only REAL runs can be approved' });
    }
    if (run.workflow_state !== 'REVIEWED') {
      return res.status(400).json({
        error: `Cannot approve. Current state: ${run.workflow_state}. Required: REVIEWED. Full path: DRAFT → SUBMITTED → REVIEWED → APPROVED`
      });
    }

    // ── BLOCK 1: OVAT prerequisites ─────────────────────────────────────────
    const ovatPreErrors = [];
    if (!run.baseline_run_id) {
      ovatPreErrors.push('baseline_run_id is required before approval (OVAT rule)');
    } else if (run.baseline_run_id === req.params.id) {
      ovatPreErrors.push('baseline_run_id cannot reference the run itself (self-reference detected)');
    }
    if (!run.declared_changed_variable) {
      ovatPreErrors.push('declared_changed_variable is required before approval (OVAT rule)');
    }
    if (ovatPreErrors.length) {
      return res.status(400).json({
        error: 'Approval blocked: OVAT prerequisites not met',
        details: ovatPreErrors,
        resolution: 'Update the run via PATCH or create a new run with these fields populated.',
      });
    }

    // ── BLOCK 2: FSCTM completeness ─────────────────────────────────────────
    const { complete: fsctm_complete, blocking_errors: fsctm_errors } =
      await checkFSCTMCompleteness(req.params.id, client);

    if (!fsctm_complete) {
      return res.status(400).json({
        error: 'Approval blocked: FSCTM model incomplete',
        details: fsctm_errors,
        resolution: 'Ensure load_type is set on the run and all FSCTM outcome fields (capacity_ratings, failure_signature, stability_classification) are provided via POST /api/lab/runs/:id/measurements.',
      });
    }

    // ── OVAT evaluation ─────────────────────────────────────────────────────
    const { run_type, changed_variables } = await evaluateOVAT(req.params.id, client);

    // ── Determine conclusion_status ─────────────────────────────────────────
    // NON_CONTROLLED → INVALID_EXPERIMENT (run is approved, but conclusion is blocked)
    // CONTROLLED_OVAT / REPLICATION → INCONCLUSIVE (valid structure; threshold eval is next step)
    const conclusion_status = run_type === 'NON_CONTROLLED'
      ? 'INVALID_EXPERIMENT'
      : 'INCONCLUSIVE';

    // ── Write to DB ─────────────────────────────────────────────────────────
    await client.query(
      `UPDATE production_runs SET workflow_state = 'APPROVED', run_type = $2 WHERE id = $1`,
      [req.params.id, run_type]
    );

    await client.query(`
      UPDATE outcomes o
      SET conclusion_status = $1
      FROM measurements m
      WHERE o.measurement_id = m.id AND m.production_run_id = $2
    `, [conclusion_status, req.params.id]);

    res.json({
      id: req.params.id,
      workflow_state: 'APPROVED',
      run_type,
      changed_variables,
      conclusion_status,
      ovat_status: run_type === 'NON_CONTROLLED'
        ? 'CONCLUSION_BLOCKED — NON_CONTROLLED run'
        : 'ELIGIBLE_FOR_CONCLUSION',
      fsctm_status: 'FSCTM_COMPLETE',
      causal_conclusion_allowed: run_type !== 'NON_CONTROLLED',
      reviewer: req.body?.reviewer || null,
    });
  } catch (err) {
    console.error('[POST /api/lab/runs/:id/approve]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/lab/runs/:id  — update run metadata
//
// Only allowed in DRAFT or SUBMITTED states.
// REVIEWED / APPROVED / INGESTED / LOCKED / HISTORICAL → 400.
//
// Updatable fields (all optional in body):
//   operator_name, prep_location, production_date, production_temperature_c,
//   batch_size_g, baseline_run_id, declared_changed_variable,
//   hypothesis, load_type, load_conditions, raw_process_notes
//
// NOT updatable: formulation_id, batch_id, run_origin, workflow_state
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/runs/:id', async (req, res) => {
  const PATCHABLE_STATES = ['DRAFT', 'SUBMITTED'];

  const client = await pool().connect();
  try {
    const { rows: [run] } = await client.query(
      `SELECT id, workflow_state, run_origin FROM production_runs WHERE id = $1`, [req.params.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.run_origin !== 'REAL') {
      return res.status(400).json({ error: 'Only REAL runs can be updated via PATCH' });
    }
    if (!PATCHABLE_STATES.includes(run.workflow_state)) {
      return res.status(400).json({
        error: `Run cannot be updated in state "${run.workflow_state}". ` +
               `PATCH is only allowed in: ${PATCHABLE_STATES.join(', ')}`,
      });
    }

    const body = req.body;
    const patchErrors = [];

    // Validate declared_changed_variable if provided
    if (body.declared_changed_variable != null) {
      if (!VALID_DECLARED_VARIABLES.includes(body.declared_changed_variable)) {
        patchErrors.push(
          `declared_changed_variable "${body.declared_changed_variable}" is not in the allowed list. ` +
          `Allowed: ${VALID_DECLARED_VARIABLES.join(', ')}`
        );
      }
    }

    // Validate load_type if provided
    if (body.load_type != null) {
      const lt = body.load_type.toUpperCase();
      if (!VALID_LOAD_TYPES.includes(lt)) {
        patchErrors.push(
          `load_type "${body.load_type}" is not valid. Allowed: ${VALID_LOAD_TYPES.join(', ')}`
        );
      }
    }

    // Validate baseline_run_id exists and is not self-referential
    if (body.baseline_run_id != null) {
      if (body.baseline_run_id === req.params.id) {
        patchErrors.push('baseline_run_id cannot reference the run itself');
      } else {
        const { rows: [brun] } = await client.query(
          `SELECT id FROM production_runs WHERE id = $1`, [body.baseline_run_id]
        );
        if (!brun) patchErrors.push(`baseline_run_id not found: ${body.baseline_run_id}`);
      }
    }

    if (patchErrors.length) {
      return res.status(400).json({ error: 'PATCH validation failed', details: patchErrors });
    }

    // Build dynamic SET clause — only fields present in body
    const ALLOWED_FIELDS = [
      'operator_name', 'prep_location', 'production_date', 'production_temperature_c',
      'batch_size_g', 'baseline_run_id', 'declared_changed_variable',
      'hypothesis', 'load_type', 'load_conditions', 'raw_process_notes',
    ];

    const setClauses = [];
    const values = [];

    for (const field of ALLOWED_FIELDS) {
      if (!(field in body)) continue;
      values.push(
        field === 'load_type' && body[field] != null
          ? body[field].toUpperCase()
          : field === 'load_conditions' && body[field] != null
            ? JSON.stringify(body[field])
            : body[field] ?? null
      );
      setClauses.push(`${field} = $${values.length}`);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided in request body' });
    }

    values.push(req.params.id);
    const { rows: [updated] } = await client.query(
      `UPDATE production_runs SET ${setClauses.join(', ')} WHERE id = $${values.length}
       RETURNING id, batch_id, workflow_state, operator_name, prep_location,
                 production_date, production_temperature_c, batch_size_g,
                 baseline_run_id, declared_changed_variable, hypothesis,
                 load_type, load_conditions, raw_process_notes`,
      values
    );

    res.json({
      ...updated,
      fields_updated: setClauses.length,
    });
  } catch (err) {
    console.error('[PATCH /api/lab/runs/:id]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lab/runs/:id/evaluate  — threshold evaluation
//
// Moves outcome conclusion_status from INCONCLUSIVE to VALID_CONCLUSION or
// keeps INCONCLUSIVE based on viscosity delta vs baseline.
//
// Rules:
//   - Run must be APPROVED
//   - conclusion_status must be INCONCLUSIVE (NON_CONTROLLED → INVALID_EXPERIMENT,
//     not eligible; STRUCTURAL_INCOMPLETE → approval was blocked, cannot reach here)
//   - Run must have baseline_run_id
//   - Both run and baseline must have at least one outcome with viscosity values
//   - If any required viscosity channel missing on either side → INSUFFICIENT_DATA
//   - Delta computed as: max( |run_v - base_v| / base_v * 100 ) across all rpm channels
//   - If max delta >= threshold_pct → VALID_CONCLUSION
//   - If max delta < threshold_pct  → stays INCONCLUSIVE
//
// Body (optional):
//   { threshold_pct: number }  — default: DEFAULT_VISCOSITY_THRESHOLD_PCT (10%)
//
// Returns:
//   { conclusion_status, delta_pct, threshold_pct, channels_evaluated[], baseline_run_id }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/runs/:id/evaluate', async (req, res) => {
  const threshold_pct = (
    req.body?.threshold_pct != null
      ? parseFloat(req.body.threshold_pct)
      : DEFAULT_VISCOSITY_THRESHOLD_PCT
  );

  if (isNaN(threshold_pct) || threshold_pct <= 0 || threshold_pct > 100) {
    return res.status(400).json({
      error: `threshold_pct must be a number between 0 and 100, got: ${req.body?.threshold_pct}`
    });
  }

  const client = await pool().connect();
  try {
    const { rows: [run] } = await client.query(
      `SELECT id, workflow_state, run_origin, baseline_run_id FROM production_runs WHERE id = $1`,
      [req.params.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.run_origin !== 'REAL') {
      return res.status(400).json({ error: 'Only REAL runs can be evaluated' });
    }
    if (run.workflow_state !== 'APPROVED') {
      return res.status(400).json({
        error: `Threshold evaluation requires APPROVED state. Current: ${run.workflow_state}`
      });
    }
    if (!run.baseline_run_id) {
      return res.status(400).json({
        error: 'baseline_run_id is required for threshold evaluation'
      });
    }

    // Fetch outcomes for this run and baseline
    const fetchOutcome = async (runId) => {
      const { rows } = await client.query(`
        SELECT o.v6, o.v12, o.v30, o.v60, o.conclusion_status
        FROM measurements m
        JOIN outcomes o ON o.measurement_id = m.id
        WHERE m.production_run_id = $1
        ORDER BY m.test_date NULLS LAST
        LIMIT 1
      `, [runId]);
      return rows[0] || null;
    };

    const [runOutcome, baseOutcome] = await Promise.all([
      fetchOutcome(req.params.id),
      fetchOutcome(run.baseline_run_id),
    ]);

    // Check current conclusion state is eligible
    if (!runOutcome) {
      return res.status(400).json({
        error: 'No outcome found for this run. Submit measurements before evaluating.',
      });
    }
    if (!['INCONCLUSIVE'].includes(runOutcome.conclusion_status)) {
      return res.status(400).json({
        error: `Threshold evaluation only applies to INCONCLUSIVE outcomes. ` +
               `Current conclusion_status: "${runOutcome.conclusion_status}"`,
      });
    }
    if (!baseOutcome) {
      return res.status(400).json({
        error: `No outcome found for baseline run ${run.baseline_run_id}. Baseline must have measurement data.`
      });
    }

    // Compute per-channel deltas (only channels where both sides have values)
    const CHANNELS = ['v6', 'v12', 'v30', 'v60'];
    const deltas = [];
    const channels_evaluated = [];
    const channels_missing = [];

    for (const ch of CHANNELS) {
      const rv = parseFloat(runOutcome[ch]);
      const bv = parseFloat(baseOutcome[ch]);
      if (isNaN(rv) || isNaN(bv)) {
        channels_missing.push(ch);
        continue;
      }
      if (bv === 0) {
        channels_missing.push(`${ch}(baseline=0)`);
        continue;
      }
      const pct = Math.abs((rv - bv) / bv) * 100;
      deltas.push({ channel: ch, run_value: rv, baseline_value: bv, delta_pct: pct });
      channels_evaluated.push(ch);
    }

    // If no channel could be evaluated → INSUFFICIENT_DATA
    if (deltas.length === 0) {
      await client.query(`
        UPDATE outcomes o SET conclusion_status = 'INSUFFICIENT_DATA'
        FROM measurements m
        WHERE o.measurement_id = m.id AND m.production_run_id = $1
      `, [req.params.id]);

      return res.json({
        id: req.params.id,
        conclusion_status: 'INSUFFICIENT_DATA',
        reason: 'No viscosity channel had comparable values in both run and baseline',
        channels_missing,
        threshold_pct,
        baseline_run_id: run.baseline_run_id,
      });
    }

    const max_delta_pct = Math.max(...deltas.map(d => d.delta_pct));
    const new_status = max_delta_pct >= threshold_pct ? 'VALID_CONCLUSION' : 'INCONCLUSIVE';

    await client.query(`
      UPDATE outcomes o SET conclusion_status = $1
      FROM measurements m
      WHERE o.measurement_id = m.id AND m.production_run_id = $2
    `, [new_status, req.params.id]);

    res.json({
      id: req.params.id,
      conclusion_status: new_status,
      max_delta_pct: parseFloat(max_delta_pct.toFixed(2)),
      threshold_pct,
      threshold_met: max_delta_pct >= threshold_pct,
      channels_evaluated: deltas.map(d => ({
        channel: d.channel,
        run_value: d.run_value,
        baseline_value: d.baseline_value,
        delta_pct: parseFloat(d.delta_pct.toFixed(2)),
      })),
      channels_missing: channels_missing.length ? channels_missing : null,
      baseline_run_id: run.baseline_run_id,
    });
  } catch (err) {
    console.error('[POST /api/lab/runs/:id/evaluate]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// =============================================================================
// MATRIYA BRIDGE — Structured Lab Data Query Layer
//
// Purpose:
//   Serve MATRIYA's lab-related questions from structured DB data only.
//   No document RAG is used when structured data exists.
//   Every response carries the mandatory output contract.
//
// Query types:
//   run_comparison          — specific run vs its baseline
//   version_comparison      — version A vs version B of same base formulation
//   variable_identification — what process variables changed between two runs/versions
//   delta_calculation       — viscosity / pH / process delta table
//   missing_variable_detection — what data is absent, blocking causal analysis
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT CONTRACT BUILDER
// Every bridge response must include all mandatory fields.
// ─────────────────────────────────────────────────────────────────────────────
function buildOutputContract({
  query_type,
  source_run_ids,
  baseline_run_id = null,
  data_grade,        // 'REAL' | 'HISTORICAL_REFERENCE' | 'MIXED' | 'NO_DATA'
  run_type = null,   // CONTROLLED_OVAT | NON_CONTROLLED | REPLICATION | NO_BASELINE | null
  conclusion_status, // one of the 6 valid states, or null
  delta_summary = null,
  blocked_reason = null,
  source_metadata = {},
  detail = null,     // additional payload (depends on query_type)
}) {
  return {
    query_type,
    source_run_ids,
    baseline_run_id,
    data_grade,
    run_type,
    conclusion_status,
    delta_summary,
    blocked_reason,
    source_metadata,
    ...(detail ? { detail } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DELTA HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function computeViscosityDelta(runOutcome, baseOutcome) {
  const CHANNELS = ['v6', 'v12', 'v30', 'v60'];
  const channels = [];
  let max_delta_pct = null;
  let dominant_channel = null;

  for (const ch of CHANNELS) {
    const rv = parseFloat(runOutcome?.[ch]);
    const bv = parseFloat(baseOutcome?.[ch]);
    if (isNaN(rv) || isNaN(bv) || bv === 0) {
      channels.push({ channel: ch, run_value: runOutcome?.[ch] ?? null, baseline_value: baseOutcome?.[ch] ?? null, delta_pct: null, status: 'NOT_COMPARABLE' });
      continue;
    }
    const d = parseFloat(((rv - bv) / bv * 100).toFixed(2));
    const abs_d = Math.abs(d);
    if (max_delta_pct === null || abs_d > max_delta_pct) {
      max_delta_pct = abs_d;
      dominant_channel = ch;
    }
    channels.push({ channel: ch, run_value: rv, baseline_value: bv, delta_pct: d, abs_delta_pct: abs_d, status: 'COMPARED' });
  }

  return {
    channels,
    max_delta_pct: max_delta_pct !== null ? parseFloat(max_delta_pct.toFixed(2)) : null,
    dominant_channel,
    ph_run: runOutcome?.ph ?? null,
    ph_baseline: baseOutcome?.ph ?? null,
    ph_delta: (runOutcome?.ph != null && baseOutcome?.ph != null)
      ? parseFloat((runOutcome.ph - baseOutcome.ph).toFixed(3))
      : null,
  };
}

function computeProcessDelta(runSteps, baseSteps) {
  const baseMap = Object.fromEntries((baseSteps || []).map(s => [s.step_sequence, s]));
  const changes = [];
  const unchanged = [];

  for (const step of (runSteps || [])) {
    const b = baseMap[step.step_sequence];
    if (!b) {
      changes.push({ step_sequence: step.step_sequence, field: 'step_existence', run: 'PRESENT', baseline: 'ABSENT' });
      continue;
    }
    const fields = ['mixing_speed_rpm', 'mixing_duration_min', 'material_name', 'order_of_addition'];
    let stepChanged = false;
    for (const f of fields) {
      if (String(step[f] ?? '') !== String(b[f] ?? '')) {
        changes.push({ step_sequence: step.step_sequence, field: f, run: step[f], baseline: b[f] });
        stepChanged = true;
      }
    }
    if (!stepChanged) unchanged.push(step.step_sequence);
  }

  return { changed_steps: changes, unchanged_step_sequences: unchanged };
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA GRADE RESOLVER
// ─────────────────────────────────────────────────────────────────────────────
function resolveDataGrade(runA, runB) {
  const isRealA = runA?.run_origin === 'REAL';
  const isRealB = !runB || runB?.run_origin === 'REAL';
  if (isRealA && isRealB) return 'REAL';
  if (!isRealA && (!runB || !isRealB)) return 'HISTORICAL_REFERENCE';
  return 'MIXED';
}

// ─────────────────────────────────────────────────────────────────────────────
// BEST RUN SELECTOR
// For a given formulation, select the most authoritative run:
//   Priority: REAL+LOCKED > REAL+APPROVED > REAL+REVIEWED > REAL+SUBMITTED > REAL+DRAFT > HISTORICAL
// ─────────────────────────────────────────────────────────────────────────────
const RUN_PRIORITY = { LOCKED: 0, APPROVED: 1, REVIEWED: 2, SUBMITTED: 3, DRAFT: 4, HISTORICAL: 5 };

function bestRun(runs) {
  if (!runs || runs.length === 0) return null;
  return runs.slice().sort((a, b) => {
    const pa = a.run_origin === 'REAL' ? (RUN_PRIORITY[a.workflow_state] ?? 9) : 10;
    const pb = b.run_origin === 'REAL' ? (RUN_PRIORITY[b.workflow_state] ?? 9) : 10;
    return pa - pb;
  })[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH HELPERS (used by query handlers)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchRunFull(runId, client) {
  const { rows: [run] } = await client.query(
    `SELECT pr.*, f.source_id AS formulation_source_id, f.base_id, f.version, f.product_name
     FROM production_runs pr JOIN formulations f ON f.id = pr.formulation_id
     WHERE pr.id = $1`, [runId]
  );
  if (!run) return null;

  const [{ rows: steps }, { rows: outcomes }] = await Promise.all([
    client.query(`SELECT * FROM production_steps WHERE production_run_id = $1 ORDER BY step_sequence`, [runId]),
    client.query(
      `SELECT o.* FROM measurements m JOIN outcomes o ON o.measurement_id = m.id
       WHERE m.production_run_id = $1 ORDER BY m.test_date NULLS LAST LIMIT 1`, [runId]
    ),
  ]);

  return { run, steps, outcome: outcomes[0] || null };
}

async function fetchRunsByVersion(baseId, version, client) {
  const { rows } = await client.query(
    `SELECT pr.id, pr.run_origin, pr.workflow_state, pr.batch_id, pr.production_date,
            pr.formulation_id, pr.baseline_run_id, pr.declared_changed_variable, pr.run_type,
            f.source_id AS formulation_source_id, f.version, f.base_id
     FROM production_runs pr
     JOIN formulations f ON f.id = pr.formulation_id
     WHERE f.base_id = $1 AND f.version = $2
     ORDER BY pr.production_date NULLS LAST`, [baseId, version]
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY HANDLER: run_comparison
// Compare a specific run against its baseline (or a provided baseline).
// ─────────────────────────────────────────────────────────────────────────────
async function handleRunComparison(params, client) {
  const { run_id, baseline_run_id: override_baseline } = params;

  if (!run_id) {
    return buildOutputContract({
      query_type: 'run_comparison', source_run_ids: [], data_grade: 'NO_DATA',
      conclusion_status: 'INSUFFICIENT_DATA',
      blocked_reason: 'run_id is required for run_comparison',
    });
  }

  const runFull = await fetchRunFull(run_id, client);
  if (!runFull) {
    return buildOutputContract({
      query_type: 'run_comparison', source_run_ids: [run_id], data_grade: 'NO_DATA',
      conclusion_status: 'INSUFFICIENT_DATA',
      blocked_reason: `run_id "${run_id}" not found`,
    });
  }

  const effectiveBaselineId = override_baseline || runFull.run.baseline_run_id;
  let baseFull = null;
  if (effectiveBaselineId) baseFull = await fetchRunFull(effectiveBaselineId, client);

  const data_grade = resolveDataGrade(runFull.run, baseFull?.run);
  const conclusion_status = runFull.outcome?.conclusion_status || 'INSUFFICIENT_DATA';
  const run_type = runFull.run.run_type || null;

  // Determine blocked reason
  let blocked_reason = null;
  if (data_grade === 'HISTORICAL_REFERENCE' || data_grade === 'MIXED') {
    blocked_reason = 'HISTORICAL data cannot support causal conclusions. Only REAL validated runs are eligible for causal interpretation.';
  } else if (run_type === 'NON_CONTROLLED') {
    blocked_reason = 'NON_CONTROLLED run: more than one variable changed vs baseline. Causal conclusion is INVALID.';
  } else if (conclusion_status === 'STRUCTURAL_INCOMPLETE') {
    blocked_reason = 'FSCTM model incomplete: K/C/B/L fields not fully populated. Run requires approval with complete FSCTM data.';
  } else if (!effectiveBaselineId) {
    blocked_reason = 'No baseline_run_id set on this run. OVAT comparison requires a baseline.';
  } else if (!baseFull) {
    blocked_reason = `Baseline run "${effectiveBaselineId}" not found.`;
  }

  const delta_summary = (runFull.outcome && baseFull?.outcome)
    ? computeViscosityDelta(runFull.outcome, baseFull.outcome)
    : null;

  const process_delta = (runFull.steps.length && baseFull?.steps.length)
    ? computeProcessDelta(runFull.steps, baseFull.steps)
    : null;

  return buildOutputContract({
    query_type: 'run_comparison',
    source_run_ids: [run_id],
    baseline_run_id: effectiveBaselineId || null,
    data_grade,
    run_type,
    conclusion_status,
    delta_summary,
    blocked_reason,
    source_metadata: {
      batch_id: runFull.run.batch_id,
      test_date: runFull.outcome?.test_date || null,
      formulation_source_id: runFull.run.formulation_source_id,
      base_id: runFull.run.base_id,
      version: runFull.run.version,
      workflow_state: runFull.run.workflow_state,
      operator_name: runFull.run.operator_name,
      baseline_batch_id: baseFull?.run.batch_id || null,
    },
    detail: { process_delta },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY HANDLER: version_comparison
// Compare version A vs version B of the same base formulation.
// ─────────────────────────────────────────────────────────────────────────────
async function handleVersionComparison(params, client) {
  const { base_id, version_a, version_b } = params;

  if (!base_id || !version_a || !version_b) {
    return buildOutputContract({
      query_type: 'version_comparison', source_run_ids: [], data_grade: 'NO_DATA',
      conclusion_status: 'INSUFFICIENT_DATA',
      blocked_reason: 'base_id, version_a, and version_b are all required for version_comparison',
    });
  }

  const [runsA, runsB] = await Promise.all([
    fetchRunsByVersion(base_id, version_a, client),
    fetchRunsByVersion(base_id, version_b, client),
  ]);

  if (!runsA.length && !runsB.length) {
    return buildOutputContract({
      query_type: 'version_comparison', source_run_ids: [], data_grade: 'NO_DATA',
      conclusion_status: 'INSUFFICIENT_DATA',
      blocked_reason: `No runs found for ${base_id} versions "${version_a}" or "${version_b}"`,
    });
  }

  const runA = bestRun(runsA);
  const runB = bestRun(runsB);

  const [fullA, fullB] = await Promise.all([
    runA ? fetchRunFull(runA.id, client) : null,
    runB ? fetchRunFull(runB.id, client) : null,
  ]);

  const data_grade = resolveDataGrade(fullA?.run, fullB?.run);

  const delta_summary = (fullA?.outcome && fullB?.outcome)
    ? computeViscosityDelta(fullA.outcome, fullB.outcome)
    : null;

  const process_delta = (fullA?.steps && fullB?.steps)
    ? computeProcessDelta(fullA.steps, fullB.steps)
    : null;

  const material_delta = await computeMaterialDelta(
    fullA?.run.formulation_id, fullB?.run.formulation_id, client
  );

  // Conclusion status: use version B's outcome status as the primary result
  const conclusion_status = fullB?.outcome?.conclusion_status
    || (data_grade === 'HISTORICAL_REFERENCE' ? 'REFERENCE_ONLY' : 'INSUFFICIENT_DATA');

  let blocked_reason = null;
  if (data_grade === 'HISTORICAL_REFERENCE') {
    blocked_reason = `Both versions are HISTORICAL. Data is reference only. No causal conclusion is possible without REAL validated runs for both versions.`;
  } else if (data_grade === 'MIXED') {
    blocked_reason = `Mixed data grades: ${version_a} is ${fullA?.run.run_origin}, ${version_b} is ${fullB?.run.run_origin}. Causal conclusions require REAL runs on both sides.`;
  }

  return buildOutputContract({
    query_type: 'version_comparison',
    source_run_ids: [fullB?.run.id, fullA?.run.id].filter(Boolean),
    baseline_run_id: fullA?.run.id || null,
    data_grade,
    run_type: fullB?.run.run_type || null,
    conclusion_status,
    delta_summary,
    blocked_reason,
    source_metadata: {
      version_a: { version: version_a, batch_id: fullA?.run.batch_id || null, run_origin: fullA?.run.run_origin || 'NOT_FOUND', workflow_state: fullA?.run.workflow_state || null },
      version_b: { version: version_b, batch_id: fullB?.run.batch_id || null, run_origin: fullB?.run.run_origin || 'NOT_FOUND', workflow_state: fullB?.run.workflow_state || null },
      base_id,
    },
    detail: { process_delta, material_delta },
  });
}

async function computeMaterialDelta(formIdA, formIdB, client) {
  if (!formIdA || !formIdB) return null;
  const [{ rows: matsA }, { rows: matsB }] = await Promise.all([
    client.query(`SELECT material_name, fraction FROM formulation_materials WHERE formulation_id = $1`, [formIdA]),
    client.query(`SELECT material_name, fraction FROM formulation_materials WHERE formulation_id = $1`, [formIdB]),
  ]);
  const mapA = Object.fromEntries(matsA.map(m => [m.material_name, parseFloat(m.fraction)]));
  const mapB = Object.fromEntries(matsB.map(m => [m.material_name, parseFloat(m.fraction)]));
  const allMaterials = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);
  const changes = [];
  for (const mat of allMaterials) {
    const va = mapA[mat] ?? null;
    const vb = mapB[mat] ?? null;
    if (va !== vb) changes.push({ material_name: mat, version_a_fraction: va, version_b_fraction: vb });
  }
  return { changed_materials: changes, identical: changes.length === 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY HANDLER: variable_identification
// What process variables changed between two runs or versions?
// ─────────────────────────────────────────────────────────────────────────────
async function handleVariableIdentification(params, client) {
  const { run_id, baseline_run_id, base_id, version_a, version_b } = params;

  let fullA = null, fullB = null;

  if (run_id) {
    fullB = await fetchRunFull(run_id, client);
    const bId = baseline_run_id || fullB?.run.baseline_run_id;
    if (bId) fullA = await fetchRunFull(bId, client);
  } else if (base_id && version_a && version_b) {
    const [runsA, runsB] = await Promise.all([
      fetchRunsByVersion(base_id, version_a, client),
      fetchRunsByVersion(base_id, version_b, client),
    ]);
    const rA = bestRun(runsA); const rB = bestRun(runsB);
    [fullA, fullB] = await Promise.all([
      rA ? fetchRunFull(rA.id, client) : null,
      rB ? fetchRunFull(rB.id, client) : null,
    ]);
  }

  if (!fullB) {
    return buildOutputContract({
      query_type: 'variable_identification', source_run_ids: [], data_grade: 'NO_DATA',
      conclusion_status: 'INSUFFICIENT_DATA',
      blocked_reason: 'Could not resolve run(s) for variable identification. Provide run_id or base_id+version_a+version_b.',
    });
  }

  const data_grade = resolveDataGrade(fullB.run, fullA?.run);
  const process_delta = fullA
    ? computeProcessDelta(fullB.steps, fullA.steps)
    : { changed_steps: [], unchanged_step_sequences: [], note: 'No baseline run available for comparison' };

  const material_delta = fullA
    ? await computeMaterialDelta(fullA.run.formulation_id, fullB.run.formulation_id, client)
    : null;

  const changed_variable_names = [...new Set(process_delta.changed_steps.map(c => c.field))];

  // Classify the change
  let conclusion_status = 'INSUFFICIENT_DATA';
  let blocked_reason = null;

  if (!fullA) {
    blocked_reason = 'No baseline available for variable identification.';
  } else if (data_grade === 'HISTORICAL_REFERENCE') {
    conclusion_status = 'REFERENCE_ONLY';
    blocked_reason = 'HISTORICAL data: variable differences identified but cannot support causal conclusions.';
  } else if (changed_variable_names.length === 0 && material_delta?.identical) {
    conclusion_status = fullB.outcome?.conclusion_status || 'INCONCLUSIVE';
    blocked_reason = 'No process or material difference detected. Outcome difference may be caused by an unrecorded variable.';
  } else if (changed_variable_names.length > 1) {
    conclusion_status = 'INVALID_EXPERIMENT';
    blocked_reason = `Multiple variables changed (${changed_variable_names.join(', ')}). OVAT isolation not possible.`;
  } else if (changed_variable_names.length === 1) {
    conclusion_status = fullB.outcome?.conclusion_status || 'INCONCLUSIVE';
  }

  return buildOutputContract({
    query_type: 'variable_identification',
    source_run_ids: [fullB.run.id],
    baseline_run_id: fullA?.run.id || null,
    data_grade,
    run_type: fullB.run.run_type || null,
    conclusion_status,
    delta_summary: (fullA?.outcome && fullB.outcome)
      ? computeViscosityDelta(fullB.outcome, fullA.outcome)
      : null,
    blocked_reason,
    source_metadata: {
      run_batch_id: fullB.run.batch_id,
      baseline_batch_id: fullA?.run.batch_id || null,
      base_id: fullB.run.base_id,
      version: fullB.run.version,
    },
    detail: {
      changed_variables: changed_variable_names,
      changed_steps: process_delta.changed_steps,
      material_delta,
      declared_changed_variable: fullB.run.declared_changed_variable,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY HANDLER: delta_calculation
// Focused delta table for viscosity, pH, or process variables.
// ─────────────────────────────────────────────────────────────────────────────
async function handleDeltaCalculation(params, client) {
  const { run_id, baseline_run_id, base_id, version_a, version_b, metric = 'viscosity' } = params;
  const VALID_METRICS = ['viscosity', 'ph', 'process', 'all'];

  if (!VALID_METRICS.includes(metric)) {
    return buildOutputContract({
      query_type: 'delta_calculation', source_run_ids: [], data_grade: 'NO_DATA',
      conclusion_status: 'INSUFFICIENT_DATA',
      blocked_reason: `Invalid metric "${metric}". Must be one of: ${VALID_METRICS.join(', ')}`,
    });
  }

  let fullA = null, fullB = null;

  if (run_id) {
    fullB = await fetchRunFull(run_id, client);
    const bId = baseline_run_id || fullB?.run.baseline_run_id;
    if (bId) fullA = await fetchRunFull(bId, client);
  } else if (base_id && version_a && version_b) {
    const [runsA, runsB] = await Promise.all([
      fetchRunsByVersion(base_id, version_a, client),
      fetchRunsByVersion(base_id, version_b, client),
    ]);
    [fullA, fullB] = await Promise.all([
      bestRun(runsA) ? fetchRunFull(bestRun(runsA).id, client) : null,
      bestRun(runsB) ? fetchRunFull(bestRun(runsB).id, client) : null,
    ]);
  }

  if (!fullB || !fullA) {
    return buildOutputContract({
      query_type: 'delta_calculation', source_run_ids: fullB ? [fullB.run.id] : [], data_grade: 'NO_DATA',
      conclusion_status: 'INSUFFICIENT_DATA',
      blocked_reason: !fullB ? 'Target run not found.' : 'Baseline run not found.',
    });
  }

  const data_grade = resolveDataGrade(fullB.run, fullA.run);

  const viscosity_delta = (metric === 'viscosity' || metric === 'all')
    ? computeViscosityDelta(fullB.outcome, fullA.outcome)
    : null;

  const process_delta = (metric === 'process' || metric === 'all')
    ? computeProcessDelta(fullB.steps, fullA.steps)
    : null;

  return buildOutputContract({
    query_type: 'delta_calculation',
    source_run_ids: [fullB.run.id],
    baseline_run_id: fullA.run.id,
    data_grade,
    run_type: fullB.run.run_type || null,
    conclusion_status: fullB.outcome?.conclusion_status
      || (data_grade === 'HISTORICAL_REFERENCE' ? 'REFERENCE_ONLY' : 'INSUFFICIENT_DATA'),
    delta_summary: viscosity_delta,
    blocked_reason: data_grade !== 'REAL'
      ? 'Delta computed from HISTORICAL data. Reference only — not eligible for causal conclusions.'
      : null,
    source_metadata: {
      metric_requested: metric,
      run_batch_id: fullB.run.batch_id,
      baseline_batch_id: fullA.run.batch_id,
      base_id: fullB.run.base_id,
    },
    detail: { process_delta },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY HANDLER: missing_variable_detection
// What is absent that prevents causal analysis?
// ─────────────────────────────────────────────────────────────────────────────
async function handleMissingVariableDetection(params, client) {
  const { run_id, base_id } = params;

  const runsToCheck = [];

  if (run_id) {
    const full = await fetchRunFull(run_id, client);
    if (full) runsToCheck.push(full);
  } else if (base_id) {
    const { rows: allRuns } = await client.query(
      `SELECT pr.id FROM production_runs pr
       JOIN formulations f ON f.id = pr.formulation_id
       WHERE f.base_id = $1`, [base_id]
    );
    for (const r of allRuns) {
      const full = await fetchRunFull(r.id, client);
      if (full) runsToCheck.push(full);
    }
  } else {
    return buildOutputContract({
      query_type: 'missing_variable_detection', source_run_ids: [], data_grade: 'NO_DATA',
      conclusion_status: 'INSUFFICIENT_DATA',
      blocked_reason: 'run_id or base_id is required for missing_variable_detection',
    });
  }

  const report = [];
  for (const { run, steps, outcome } of runsToCheck) {
    const missing = [];
    if (!run.baseline_run_id) missing.push('baseline_run_id');
    if (!run.declared_changed_variable) missing.push('declared_changed_variable');
    if (!run.load_type) missing.push('load_type (K)');
    for (const step of steps) {
      if (step.mixing_speed_rpm == null) missing.push(`step_${step.step_sequence}:mixing_speed_rpm`);
      if (step.mixing_duration_min == null) missing.push(`step_${step.step_sequence}:mixing_duration_min`);
    }
    if (!outcome) {
      missing.push('outcome (no measurements recorded)');
    } else {
      if (!outcome.capacity_ratings) missing.push('capacity_ratings (C)');
      if (!outcome.failure_signature) missing.push('failure_signature (B)');
      if (!outcome.stability_classification) missing.push('stability_classification (L)');
    }

    report.push({
      run_id: run.id,
      batch_id: run.batch_id,
      run_origin: run.run_origin,
      workflow_state: run.workflow_state,
      analysis_eligible: missing.length === 0,
      missing_fields: missing,
      blocking_reason: missing.length
        ? `${missing.length} required field(s) missing. Run cannot produce a valid conclusion.`
        : null,
    });
  }

  const allEligible = report.every(r => r.analysis_eligible);
  const anyReal = runsToCheck.some(r => r.run.run_origin === 'REAL');

  return buildOutputContract({
    query_type: 'missing_variable_detection',
    source_run_ids: runsToCheck.map(r => r.run.id),
    baseline_run_id: null,
    data_grade: anyReal ? (runsToCheck.every(r => r.run.run_origin === 'REAL') ? 'REAL' : 'MIXED') : 'HISTORICAL_REFERENCE',
    run_type: null,
    conclusion_status: allEligible ? 'INCONCLUSIVE' : 'STRUCTURAL_INCOMPLETE',
    delta_summary: null,
    blocked_reason: allEligible ? null : 'One or more runs have missing required fields.',
    source_metadata: { base_id: base_id || null },
    detail: { runs_checked: report.length, run_reports: report },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────
const QUERY_HANDLERS = {
  run_comparison:           handleRunComparison,
  version_comparison:       handleVersionComparison,
  variable_identification:  handleVariableIdentification,
  delta_calculation:        handleDeltaCalculation,
  missing_variable_detection: handleMissingVariableDetection,
};

async function dispatchQuery(type, params, client) {
  const handler = QUERY_HANDLERS[type];
  if (!handler) {
    return buildOutputContract({
      query_type: type || 'unknown',
      source_run_ids: [],
      data_grade: 'NO_DATA',
      conclusion_status: 'INSUFFICIENT_DATA',
      blocked_reason: `Unknown query_type "${type}". Must be one of: ${Object.keys(QUERY_HANDLERS).join(', ')}`,
    });
  }
  return handler(params, client);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lab/query
//
// Query params:
//   type          (required) — run_comparison | version_comparison |
//                              variable_identification | delta_calculation |
//                              missing_variable_detection
//   run_id        — for run-level queries
//   baseline_run_id — override baseline
//   base_id       — for version-level queries (e.g. "BASE-003")
//   version_a     — e.g. "003.1"
//   version_b     — e.g. "003.2"
//   metric        — for delta_calculation: viscosity | ph | process | all
//
// Returns: output contract (see buildOutputContract)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/query', async (req, res) => {
  const client = await pool().connect();
  try {
    const params = {
      run_id:          req.query.run_id || null,
      baseline_run_id: req.query.baseline_run_id || null,
      base_id:         req.query.base_id || null,
      version_a:       req.query.version_a || null,
      version_b:       req.query.version_b || null,
      metric:          req.query.metric || 'viscosity',
    };
    const result = await dispatchQuery(req.query.type, params, client);
    res.json(result);
  } catch (err) {
    console.error('[GET /api/lab/query]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lab/compare
//
// Body:
//   query_type    (required) — same set as GET /api/lab/query
//   run_id, baseline_run_id, base_id, version_a, version_b, metric
//   threshold_pct — for delta interpretation (default 10)
//
// Identical logic to GET /api/lab/query but accepts body for richer payloads.
// Also used by MATRIYA when forwarding a natural-language question that has
// been mapped to a structured query type.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/compare', async (req, res) => {
  const client = await pool().connect();
  try {
    const body = req.body || {};
    const params = {
      run_id:          body.run_id || null,
      baseline_run_id: body.baseline_run_id || null,
      base_id:         body.base_id || null,
      version_a:       body.version_a || null,
      version_b:       body.version_b || null,
      metric:          body.metric || 'viscosity',
      threshold_pct:   body.threshold_pct || DEFAULT_VISCOSITY_THRESHOLD_PCT,
    };

    const result = await dispatchQuery(body.query_type, params, client);

    // If threshold_pct provided and conclusion is INCONCLUSIVE, apply threshold interpretation
    if (
      result.conclusion_status === 'INCONCLUSIVE' &&
      result.delta_summary?.max_delta_pct != null &&
      body.threshold_pct != null
    ) {
      const thr = parseFloat(body.threshold_pct);
      if (!isNaN(thr) && thr > 0) {
        result.threshold_evaluation = {
          threshold_pct: thr,
          max_delta_pct: result.delta_summary.max_delta_pct,
          threshold_met: result.delta_summary.max_delta_pct >= thr,
          note: result.delta_summary.max_delta_pct >= thr
            ? 'Delta exceeds threshold. Eligible for VALID_CONCLUSION via POST /api/lab/runs/:id/evaluate.'
            : 'Delta below threshold. Remains INCONCLUSIVE.',
        };
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[POST /api/lab/compare]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;
