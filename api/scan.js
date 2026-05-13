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
        system: `You are a refractometer image analyzer. Your ONLY job is to identify the vertical positions of three visual features in the image.

Measure positions as a percentage of total image height from the top edge:
- 0% = very top of image
- 50% = middle of image  
- 100% = very bottom of image

LOCATE THESE THREE FEATURES:

1. BOUNDARY — the sharp horizontal line separating the BLUE/DARK region (above) from the WHITE/CLEAR region (below). Report where this line crosses the center of the scale column.

2. LOWER_MARK — the highest printed number on the scale (must be a multiple of 5: 0,5,10,15,20,25,30) that sits BELOW the boundary line. Report both its numeric value and its y-position.

3. UPPER_MARK — the lowest printed number on the scale (multiple of 5) that sits ABOVE the boundary line. Report both its numeric value and its y-position.

DO NOT calculate the Brix value. Do not estimate fractions. Only report the three y-positions accurately.

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

    // ── Server-side Brix calculation from y-positions ──────────────
    // In the image: higher Brix = higher up = smaller y%
    // So: lower_y > boundary_y > upper_y
    let brix = null;
    let fraction = null;

    if (
      pos.lower_y !== undefined && pos.upper_y !== undefined &&
      pos.boundary_y !== undefined && pos.lower_y !== pos.upper_y
    ) {
      fraction = (pos.lower_y - pos.boundary_y) / (pos.lower_y - pos.upper_y);
      fraction = Math.max(0, Math.min(1, fraction)); // clamp 0–1
      brix = pos.lower_brix + fraction * (pos.upper_brix - pos.lower_brix);
      brix = Math.round(brix * 10) / 10; // round to 1 decimal place
    }

    const reading = {
      brix,
      confidence: pos.confidence,
      boundary_position: `boundary at ${pos.boundary_y}% · ${pos.lower_brix} mark at ${pos.lower_y}% · ${pos.upper_brix} mark at ${pos.upper_y}% · fraction ${fraction !== null ? fraction.toFixed(3) : 'n/a'}`,
      notes: pos.notes,
      lower_brix: pos.lower_brix,
      upper_brix: pos.upper_brix,
      fraction: fraction
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
