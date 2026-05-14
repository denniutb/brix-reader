// ── Quadratic regression: fits y = a·brix² + b·brix + c ──────────
function fitQuadratic(marks) {
  const n = marks.length;
  if (n < 3) return null;

  let S0=n, S1=0, S2=0, S3=0, S4=0, Ty=0, Txy=0, Tx2y=0;
  for (const m of marks) {
    const x = m.brix, y = m.y;
    S1+=x; S2+=x*x; S3+=x*x*x; S4+=x*x*x*x;
    Ty+=y; Txy+=x*y; Tx2y+=x*x*y;
  }

  let M = [
    [S4, S3, S2, Tx2y],
    [S3, S2, S1, Txy],
    [S2, S1, S0, Ty]
  ];

  for (let col = 0; col < 3; col++) {
    let maxRow = col;
    for (let row = col+1; row < 3; row++)
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    if (Math.abs(M[col][col]) < 1e-10) return null;
    for (let row = col+1; row < 3; row++) {
      const f = M[row][col] / M[col][col];
      for (let j = col; j < 4; j++) M[row][j] -= f * M[col][j];
    }
  }

  const c = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    c[i] = M[i][3];
    for (let j = i+1; j < 3; j++) c[i] -= M[i][j] * c[j];
    c[i] /= M[i][i];
  }
  return { a: c[0], b: c[1], c: c[2] };
}

// ── Solve brix from y-position using the fitted curve ─────────────
function solveBrix(fit, boundary_y) {
  if (!fit) return null;
  const { a, b, c } = fit;

  if (Math.abs(a) < 1e-10) {
    if (Math.abs(b) < 1e-10) return null;
    return -(c - boundary_y) / b;
  }

  const disc = b*b - 4*a*(c - boundary_y);
  if (disc < 0) return null;

  const sq = Math.sqrt(disc);
  const roots = [(-b+sq)/(2*a), (-b-sq)/(2*a)].filter(x => x >= -1 && x <= 33);
  if (!roots.length) return null;

  roots.sort((a, b) => Math.abs(a-16) - Math.abs(b-16));
  return Math.round(roots[0] * 10) / 10;
}

// ── Fallback: piecewise linear interpolation ──────────────────────
function piecewiseLinear(marks, boundary_y) {
  const sorted = marks.slice().sort((a, b) => b.y - a.y);
  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i], hi = sorted[i+1];
    if (boundary_y <= lo.y && boundary_y >= hi.y && lo.y !== hi.y) {
      const frac = (lo.y - boundary_y) / (lo.y - hi.y);
      return lo.brix + frac * (hi.brix - lo.brix);
    }
  }
  return null;
}

// ── R² goodness of fit ───────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { image, fruit_type, batch_id, latitude, longitude, farmer_note } = req.body;

  try {
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
    const pos = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    // ── Calculate Brix using regression + fallback ────────────────
    let brix = null;
    let method = 'none';
    let fitInfo = '';

    if (pos.marks && pos.marks.length >= 3) {
      const fit = fitQuadratic(pos.marks);
      if (fit) {
        const r2 = rSquared(pos.marks, fit);
        if (r2 > 0.95) {
          brix = solveBrix(fit, pos.boundary_y);
          method = 'quadratic';
          fitInfo = `R²=${r2.toFixed(4)} a=${fit.a.toFixed(6)} b=${fit.b.toFixed(4)} c=${fit.c.toFixed(2)}`;
        }
      }
    }

    if (brix === null && pos.marks && pos.marks.length >= 2) {
      brix = piecewiseLinear(pos.marks, pos.boundary_y);
      method = 'piecewise';
      fitInfo = `${pos.marks.length} marks`;
    }

    if (brix !== null) {
      brix = Math.round(Math.max(0, Math.min(32, brix)) * 10) / 10;
    }

    const marksStr = (pos.marks || []).map(m => `${m.brix}@${m.y}%`).join(', ');

    const reading = {
      brix,
      confidence: pos.confidence,
      boundary_position: `brix=${brix} [${method}] | boundary=${pos.boundary_y}% | marks: ${marksStr} | ${fitInfo}`,
      notes: pos.notes
    };

    // Upload image to Supabase Storage
    const imageBuffer = Buffer.from(image, 'base64');
    const filename = `${Date.now()}_${(batch_id || 'scan').replace(/\s/g, '_')}.jpg`;

    await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/mybrixs-images/${filename}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'image/jpeg'
      },
      body: imageBuffer
    });

    const imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/mybrixs-images/${filename}`;

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/readings`, {
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

    res.status(200).json({ ...reading, image_url: imageUrl });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Scan failed' });
  }
}
