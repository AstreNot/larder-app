// NOTE: verify this model name is still current at https://ai.google.dev before relying on it —
// Google renames/deprecates Gemini model versions periodically and this may be out of date.
const GEMINI_MODEL = "gemini-2.0-flash";

const SCAN_PROMPT = `You are analyzing a photo of a fridge or pantry to extract a food inventory.

Identify every distinct food item visible, including spices, condiments, and packaged goods. Give your best estimate even when uncertain.

Return ONLY valid JSON, no markdown fences, no preamble:
{
  "items": [
    {
      "name": "string, singular, lowercase",
      "quantity_estimate": "string, e.g. '6', 'half bag', 'unknown'",
      "category": "one of: produce, dairy, meat, grain, spice, condiment, pantry, beverage, other",
      "confidence": "one of: high, medium, low",
      "expires_in_days": number or null,
      "note": "optional, only if ambiguous"
    }
  ]
}`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { image, mediaType } = req.body || {};
  if (!image || !mediaType) {
    return res.status(400).json({ error: "Missing image or mediaType in request body" });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY. Set it in your Vercel project's environment variables." });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inline_data: { mime_type: mediaType, data: image } },
                { text: SCAN_PROMPT },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || "Gemini API error" });
    }

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
    const cleaned = text.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(502).json({ error: "Model returned unparseable output. Try again." });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Failed to process photo: " + err.message });
  }
}
