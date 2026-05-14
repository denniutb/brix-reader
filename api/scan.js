// pages/api/scan.js
//
// MyBrixS Scan API — C1.1 Lean MVP revision
//
// Design choice:
// - Preserve the existing external response shape exactly:
//   { brix, confidence, boundary_position, notes, image_url }
// - Preserve the current "scan and save" behaviour.
// - Improve the internal Brix-calculation robustness without expanding the MVP UI/API.
//
// Main improvements:
// 1. Round final Brix to the refractometer's 0.2 % Brix graduation.
// 2. Validate Claude's geometric outputs before using them.
// 3. Improve quadratic root selection using the local scale bracket.
// 4. Use a cautious piecewise fallback when the quadratic solution is not reliable.
// 5. Check Supabase upload / insert failures instead of silently ignoring them.

// ──────────────────────────────────────────────────────────────────
// Utility helpers
// ──────────────────────────────────────────────────────────────────

const ALLOWED_MAJOR_MARKS = new Set([0, 5, 10, 15, 20, 25, 30]);
const BRIX_MIN = 0;
const BRIX_MAX = 32;
const BRIX_STEP = 0.2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundToBrixStep(value) {
  return Math.round(value / BRIX_STEP) * BRIX_STEP;
}

function toOneDecimal(value) {
  return Math.round(value * 10) / 10;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeBatchId(batchId) {
  return String(batchId || 'scan')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'scan';
}

function validatePositions(pos) {
  if (!pos || !isFiniteNumber(pos.boundary_y)) {
    throw new Error('Boundary position was not returned reliably.');
  }

  if (pos.boundary_y < 0 || pos.boundary_y > 100) {
    throw new Error('Boundary position is outside the expected image range.');
  }

  const marks = Array.isArray(pos.marks)
    ? pos.marks
        .filter(m =>
          m &&
          isFiniteNumber(m.brix) &&
          isFiniteNumber(m.y) &&
          ALLOWED_MAJOR_MARKS.has(m.brix) &&
          m.y >= 0 &&
          m.y <= 100
        )
        .map(m => ({ brix: m.brix, y: m.y }))
    : [];

  // Remove duplicate major marks if the model reports any twice.
  const deduped = [];
  const seen = new Set();
  for (const mark of marks) {
    if (!seen.has(mark.brix)) {
      deduped.push(mark);
      seen.add(mark.brix);
    }
  }

  if (deduped.length < 2) {
    throw new Error('Too few readable major scale marks were detected. Please retake the image more centrally.');
  }

  return {
    boundary_y: pos.boundary_y,
    marks: deduped,
    confidence: ['high', 'medium', 'low'].includes(pos.confidence) ? pos.confidence : 'low',
    notes: typeof pos.notes === 'string' ? pos.notes : ''
  };
}

function keepMonotonicMarks(marks) {
  // Higher Brix should appear higher in the refractometer image,
  // therefore y should generally decrease as Brix increases.
  const sorted = marks.slice().sort((a, b) => a.brix - b.brix);

  if (sorted.length <= 2) return sorted;

  const filtered = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const previous = filtered[filtered.length - 1];
    const current = sorted[i];

    // Allow a tiny tolerance for visual-model noise.
    if (current.y < previous.y + 0.6) {
      filtered.push(current);
    }
  }

  // If the simple filter over-prunes, fall back to the original sorted marks.
  return filtered.length >= 2 ? filtered : sorted;
}

// ──────────────────────────────────────────────────────────────────
// Quadratic regression: fits y = a·brix² + b·brix + c
// ──────────────────────────────────────────────────────────────────

function fitQuadratic(marks) {
  const n = marks.length;
  if (n < 3) return null;

  let S0 = n, S1 = 0, S2 = 0, S3 = 0, S4 = 0, Ty = 0, Txy = 0, Tx2y = 0;
  for (const m of marks) {
    const x = m.brix, y = m.y;
    S1 += x;
    S2 += x * x;
    S3 += x * x * x;
    S4 += x * x * x * x;
    Ty += y;
    Txy += x * y;
    Tx2y += x * x * y;
  }

  const M = [
    [S4, S3, S2, Tx2y],
    [S3, S2, S1, Txy],
    [S2, S1, S0, Ty]
  ];

  for (let col = 0; col < 3; col++) {
    let maxRow = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }

    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    if (Math.abs(M[col][col]) < 1e-10) return null;

    for (let row = col + 1; row < 3; row++) {
      const f = M[row][col] / M[col][col];
      for (let j = col; j < 4; j++) M[row][j] -= f * M[col][j];
    }
  }

  const c = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    c[i] = M[i][3];
    for (let j = i + 1; j < 3; j++) c[i] -= M[i][j] * c[j];
    c[i] /= M[i][i];
  }

  return { a: c[0], b: c[1], c: c[2] };
}

function rSquared(marks, fit) {
  const mean_y = marks.reduce((s, m) => s + m.y, 0) / marks.length;
  let ssRes = 0, ssTot = 0;
  for (const m of marks) {
    const predicted = fit.a * m.brix * m.brix + fit.b * m.brix + fit.c;
    ssRes += (m.y - predicted) ** 2;
    ssTot += (m.y - mean_y) ** 2;
  }
  return ssTot === 0 ? 0 : 1 - ssRes / ssTot;
}

function derivativeY(fit, brix) {
  return 2 * fit.a * brix + fit.b;
}

function fitIsPhysicallyPlausible(fit, marks) {
  if (!fit) return false;

  const minBrix = Math.min(...marks.map(m => m.brix));
  const maxBrix = Math.max(...marks.map(m => m.brix));
  const midBrix = (minBrix + maxBrix) / 2;

  // Brix increases upward, so y should decrease as Brix increases.
  return (
    derivativeY(fit, minBrix) < 0 &&
    derivativeY(fit, midBrix) < 0 &&
    derivativeY(fit, maxBrix) < 0
  );
}

// ──────────────────────────────────────────────────────────────────
// Local scale bracketing and fallback interpolation
// ──────────────────────────────────────────────────────────────────

function findBoundaryBracket(marks, boundary_y) {
  const sorted = marks.slice().sort((a, b) => a.brix - b.brix);

  for (let i = 0; i < sorted.length - 1; i++) {
    const low = sorted[i];
    const high = sorted[i + 1];

    if (
      boundary_y <= low.y &&
      boundary_y >= high.y &&
      low.y !== high.y
    ) {
      return { low, high };
    }
  }

  return null;
}

function piecewiseLinear(marks, boundary_y) {
  const bracket = findBoundaryBracket(marks, boundary_y);
  if (!bracket) return null;

  const { low, high } = bracket;
  const frac = (low.y - boundary_y) / (low.y - high.y);
  return low.brix + frac * (high.brix - low.brix);
}

// ──────────────────────────────────────────────────────────────────
// Solve Brix from fitted curve
// ──────────────────────────────────────────────────────────────────

function solveBrix(fit, boundary_y, marks) {
  if (!fit) return null;

  const bracket = findBoundaryBracket(marks, boundary_y);
  const localLinearEstimate = piecewiseLinear(marks, boundary_y);
  const { a, b, c } = fit;

  if (Math.abs(a) < 1e-10) {
    if (Math.abs(b) < 1e-10) return null;
    return -(c - boundary_y) / b;
  }

  const disc = b * b - 4 * a * (c - boundary_y);
  if (disc < 0) return null;

  const sq = Math.sqrt(disc);
  const roots = [
    (-b + sq) / (2 * a),
    (-b - sq) / (2 * a)
  ].filter(x => x >= BRIX_MIN - 1 && x <= BRIX_MAX + 1);

  if (!roots.length) return null;

  // Prefer the root located in the local major-mark bracket around the boundary.
  if (bracket) {
    const minBracket = Math.min(bracket.low.brix, bracket.high.brix) - 0.75;
    const maxBracket = Math.max(bracket.low.brix, bracket.high.brix) + 0.75;
    const bracketRoots = roots.filter(r => r >= minBracket && r <= maxBracket);

    if (bracketRoots.length === 1) return bracketRoots[0];

    if (bracketRoots.length > 1 && localLinearEstimate !== null) {
      bracketRoots.sort((x, y) =>
        Math.abs(x - localLinearEstimate) - Math.abs(y - localLinearEstimate)
      );
      return bracketRoots[0];
    }
  }

  // Otherwise choose the root nearest to the local interpolation estimate.
  if (localLinearEstimate !== null) {
    roots.sort((x, y) =>
      Math.abs(x - localLinearEstimate) - Math.abs(y - localLinearEstimate)
    );
    return roots[0];
  }

  // Final fallback: preserve the spirit of the original code.
  roots.sort((x, y) => Math.abs(x - 16) - Math.abs(y - 16));
  return roots[0];
}

// ──────────────────────────────────────────────────────────────────
// Main handler
// ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { image, fruit_type, batch_id, latitude, longitude, farmer_note } = req.body;

  try {
    if (!image || typeof image !== 'string') {
      throw new Error('Image payload is required.');
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        temperature: 0,
        system: `You are a refractometer scale analyzer. Your job is to precisely locate visual features in a refractometer eyepiece image.

Measure all positions as PERCENTAGE of total image height from the top edge:
- 0% = very top of image
- 100% = very bottom of image

REPORT ALL of these:

1. BOUNDARY — the sharp horizontal line between the BLUE/DARK upper region and WHITE/CLEAR lower region. Find where it crosses the central scale column. Be precise: if there is a gradient, report the CENTER of the gradient transition.

2. ALL VISIBLE MAJOR MARKS — for each labeled number you can see on the scale (from the set 0, 5, 10, 15, 20, 25, 30), report its value and its y-position. Only report marks you can clearly read.

TIPS FOR ACCURACY:
- The scale runs from 0 (bottom of viewfinder) to 30+ (top of viewfinder)
- Higher Brix = higher in the image = lower y%
- Each mark is a printed number paired with a long horizontal tick line
- Look at where the number text ALIGNS with the scale, not the edge of the number
- Be especially precise about the boundary — this is the most important measurement

Respond ONLY with compact JSON, no preamble, no markdown:
{"boundary_y":<number>,"marks":[{"brix":<value>,"y":<position>},...],"confidence":"high"|"medium"|"low","notes":"<brief image quality note>"}`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: 'Report the y-positions of the boundary line and ALL visible major scale marks.' }
          ]
        }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) throw new Error(claudeData.error?.message || 'Claude API error');

    const rawText = claudeData.content.map(b => b.text || '').join('').trim();
    const rawPos = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    const pos = validatePositions(rawPos);

    const marksForCalculation = keepMonotonicMarks(pos.marks);

    // ── Calculate Brix using robust quadratic + fallback ───────────
    let brix = null;
    let method = 'none';
    let fitInfo = '';

    if (marksForCalculation.length >= 3) {
      const fit = fitQuadratic(marksForCalculation);
      if (fit && fitIsPhysicallyPlausible(fit, marksForCalculation)) {
        const r2 = rSquared(marksForCalculation, fit);
        if (r2 > 0.95) {
          brix = solveBrix(fit, pos.boundary_y, marksForCalculation);
          method = 'quadratic';
          fitInfo = `R²=${r2.toFixed(4)} a=${fit.a.toFixed(6)} b=${fit.b.toFixed(4)} c=${fit.c.toFixed(2)}`;
        }
      }
    }

    if (brix === null && marksForCalculation.length >= 2) {
      brix = piecewiseLinear(marksForCalculation, pos.boundary_y);
      method = 'piecewise';
      fitInfo = `${marksForCalculation.length} marks`;
    }

    if (brix === null || !Number.isFinite(brix)) {
      throw new Error('Brix could not be calculated reliably. Please retake the image.');
    }

    // Instrument-consistent output: 0.2 % Brix graduation.
    brix = roundToBrixStep(clamp(brix, BRIX_MIN, BRIX_MAX));
    brix = toOneDecimal(brix);

    const marksStr = marksForCalculation.map(m => `${m.brix}@${m.y}%`).join(', ');

    // Preserve existing external output structure.
    const reading = {
      brix,
      confidence: pos.confidence,
      boundary_position: `brix=${brix} [${method}] | boundary=${pos.boundary_y}% | marks: ${marksStr} | ${fitInfo}`,
      notes: pos.notes
    };

    // Upload image to Supabase Storage
    const imageBuffer = Buffer.from(image, 'base64');
    const filename = `${Date.now()}_${sanitizeBatchId(batch_id)}.jpg`;

    const uploadRes = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/mybrixs-images/${filename}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'image/jpeg'
      },
      body: imageBuffer
    });

    if (!uploadRes.ok) {
      const uploadText = await uploadRes.text().catch(() => '');
      throw new Error(`Supabase image upload failed: ${uploadRes.status} ${uploadText.slice(0, 160)}`);
    }

    const imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/mybrixs-images/${filename}`;

    const insertRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/readings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        fruit_type: fruit_type || 'unspecified',
        batch_id: batch_id || null,
        brix,
        confidence: reading.confidence,
        boundary_position: reading.boundary_position,
        notes: reading.notes,
        latitude: latitude || null,
        longitude: longitude || null,
        image_url: imageUrl,
        farmer_note: farmer_note || null
      })
    });

    if (!insertRes.ok) {
      const insertText = await insertRes.text().catch(() => '');
      throw new Error(`Supabase reading insert failed: ${insertRes.status} ${insertText.slice(0, 160)}`);
    }

    return res.status(200).json({ ...reading, image_url: imageUrl });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Scan failed' });
  }
}
