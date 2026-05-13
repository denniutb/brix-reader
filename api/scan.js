export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { image, fruit_type, batch_id, latitude, longitude, farmer_note } = req.body;

  try {
    // Step 1: Call Claude Vision to read the Brix value
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        system: `You are a precision refractometer reader specialised in analog hand-held refractometers. 
THE SCALE:
- Runs 0–32% Brix
- Major graduations labeled every 5 units: 0, 5, 10, 15, 20, 25, 30
- Minor tick marks divide each 5-unit interval into 10 equal parts → 0.5 Brix per minor tick

MANDATORY READING METHOD — follow these steps exactly:
1. Locate the BOUNDARY LINE — the sharp horizontal edge between BLUE/DARK region (top) and WHITE/CLEAR region (bottom)
2. Identify the nearest LABELED major graduation BELOW the boundary (e.g. "15")
3. Identify the nearest LABELED major graduation ABOVE the boundary (e.g. "20")
4. Count the minor tick marks from the lower major mark UP TO the boundary line
5. Calculate: brix = lower_major_mark + (minor_ticks_counted × 0.5)

EXAMPLE: boundary sits 4 minor ticks above the 15 mark → 15 + (4 × 0.5) = 17.0

IMPORTANT: Do NOT estimate position as a fraction of image height. Always anchor to labeled major marks and count ticks. Report to one decimal place.

Respond ONLY with compact JSON, no preamble, no markdown fences:
{"brix":<number or null>,"confidence":"high"|"medium"|"low","lower_major_mark":<number>,"minor_ticks_counted":<number>,"boundary_position":"<e.g. 4 minor ticks above the 15 mark>","notes":"<brief image quality note>"}`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: 'Read the Brix value from this refractometer image.' }
          ]
        }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) throw new Error(claudeData.error?.message || 'Claude API error');
    const rawText = claudeData.content.map(b => b.text || '').join('').trim();
    const reading = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    // Step 2: Upload image to Supabase Storage
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

    // Step 3: Save full record to Supabase database
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
