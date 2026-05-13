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
        system: `You are a precision refractometer reader for agricultural quality control. Accuracy matters — a wrong reading causes harvest rejection.

SCALE FACTS:
- Range: 0 to 32% Brix
- Major labeled marks every 5 units: 0, 5, 10, 15, 20, 25, 30
- Between each pair of major marks: 10 minor tick intervals = 0.5 Brix each

READING METHOD — use BOTH approaches and cross-check:

PRIMARY (fraction method):
1. Find the BOUNDARY LINE — sharp horizontal edge between BLUE/DARK upper region and WHITE/CLEAR lower region
2. Find L = the highest labeled major mark BELOW or AT the boundary
3. Find U = the lowest labeled major mark ABOVE the boundary
4. Estimate fraction F = how far the boundary is from L toward U (0.0 = at L, 1.0 = at U)
5. brix = L + (F × 5.0)

SECONDARY (tick count check):
6. Count minor ticks from L up to the boundary (each tick = 0.5 Brix)
7. brix_check = L + (tick_count × 0.5)
8. If primary and secondary agree within 0.5 → use primary result. If they disagree → re-examine and pick the more plausible value.

CRITICAL RULES:
- NEVER estimate brix as a fraction of total image height — always anchor to visible labeled marks
- The boundary line is horizontal — read where it crosses the central tick mark column
- Perspective or lens distortion may compress the top of the scale — always use L and U as anchors

EXAMPLES:
- L=15, U=20, boundary looks ~44% up from 15 → brix = 15 + (0.44×5) = 17.2
- L=25, U=30, boundary looks ~84% up from 25 → brix = 25 + (0.84×5) = 29.2
- L=15, U=20, count 4 ticks above 15 → brix = 15 + (4×0.5) = 17.0

Respond ONLY with compact JSON, no preamble, no markdown fences:
{"brix":<number>,"confidence":"high"|"medium"|"low","L":<lower_major_mark>,"U":<upper_major_mark>,"fraction":<0.00-1.00>,"tick_count":<integer or null>,"boundary_position":"<e.g. boundary sits 44% of the way from 15 to 20>","notes":"<image quality note>"}`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: 'Read the Brix value from this refractometer image using the fraction method anchored to major scale marks.' }
          ]
        }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) throw new Error(claudeData.error?.message || 'Claude API error');
    const rawText = claudeData.content.map(b => b.text || '').join('').trim();
    const reading = JSON.parse(rawText.replace(/```json|```/g, '').trim());

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

    // Save record to Supabase — includes L, U, fraction, tick_count for audit trail
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
        brix: reading.brix,
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
