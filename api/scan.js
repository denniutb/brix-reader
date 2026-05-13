// ── Calibration table ──────────────────────────────────────────────
// Format: [claude_raw, actual_brix]
// Measured empirically on this device/adaptor combination.
// Add more points as you collect them — more points = more accurate.
// IMPORTANT: for the 50-unit pilot, each device needs its own calibration.
const CALIBRATION = [
  [0.0,  0.0],   // anchor: zero point
  [6.3,  5.8],
  [11.3, 10.4],
  [12.3, 10.6],
  [15.0, 14.0],
  [17.3, 17.2],
  [32.0, 32.0],  // anchor: top of scale
];

function applyCalibration(raw) {
  if (raw === null || raw === undefined) return null;
  // Sort by raw value (should already be sorted, but just in case)
  const pts = CALIBRATION.slice().sort((a, b) => a[0] - b[0]);
  // Clamp to table range
  if (raw <= pts[0][0]) return pts[0][1];
  if (raw >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  // Find surrounding points and interpolate
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (raw >= x0 && raw <= x1) {
      const t = (raw - x0) / (x1 - x0);
      const corrected = y0 + t * (y1 - y0);
      return Math.round(corrected * 10) / 10;
    }
  }
  return Math.round(raw * 10) / 10;
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
        max_tokens: 400,
        system: `You are a refractometer image analyzer. Identify the VERTICAL POSITIONS of three specific features in the image, measured as percentage of total image height from top (0% = image top, 100% = image bottom).

FEATURES TO LOCATE:
1. BOUNDARY: The sharp horizontal line between the BLUE/DARK upper region and WHITE/CLEAR lower region
2. LOWER_MARK: The highest labeled major scale mark (0,5,10,15,20,25,30) that appears BELOW the boundary
3. UPPER_MARK: The lowest labeled major scale mark that appears ABOVE the boundary

Report the numeric value of each major mark and its y-position as a percentage.
DO NOT calculate the Brix value yourself. Only report positions.

Respond ONLY with compact JSON, no preamble, no markdown:
{"boundary_y":<number 0-100>,"lower_brix":<number>,"lower_y":<number 0-100>,"upper_brix":<number>,"upper_y":<number 0-100>,"confidence":"high"|"medium"|"low","notes":"<brief image quality note>"}`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: 'Identify the vertical positions of the boundary line and the two nearest major scale marks.' }
          ]
        }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) throw new Error(claudeData.error?.message || 'Claude API error');
    const rawText = claudeData.content.map(b => b.text || '').join('').trim();
    const pos = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    // ── Geometric Brix calculation from y-positions ────────────────
    let rawBrix = null;
    let fraction = null;
    if (
      pos.lower_y !== undefined && pos.upper_y !== undefined &&
      pos.boundary_y !== undefined && pos.lower_y !== pos.upper_y
    ) {
      fraction = (pos.lower_y - pos.boundary_y) / (pos.lower_y - pos.upper_y);
      fraction = Math.max(0, Math.min(1, fraction));
      rawBrix = pos.lower_brix + fraction * (pos.upper_brix - pos.lower_brix);
      rawBrix = Math.round(rawBrix * 10) / 10;
    }

    // ── Apply calibration correction ───────────────────────────────
    const calibratedBrix = applyCalibration(rawBrix);

    const reading = {
      brix: calibratedBrix,
      brix_raw: rawBrix,
      confidence: pos.confidence,
      boundary_position: `raw ${rawBrix} → calibrated ${calibratedBrix} | boundary ${pos.boundary_y}% · ${pos.lower_brix} mark @ ${pos.lower_y}% · ${pos.upper_brix} mark @ ${pos.upper_y}% · fraction ${fraction !== null ? fraction.toFixed(3) : 'n/a'}`,
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
        brix: calibratedBrix,
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
