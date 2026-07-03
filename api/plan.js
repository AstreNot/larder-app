function buildPrompt(inventory, dietary) {
  return `You are a meal-planning assistant. Given a household's current food inventory, generate a 7-day dinner meal plan (Monday through Sunday).

Current inventory (JSON):
${JSON.stringify(inventory)}

Dietary constraints: ${dietary?.trim() || "none"}

Rules:
1. Prioritize recipes using ingredients with the fewest days until expiry first, assigning those to earlier days.
2. Track inventory depletion across the week: once an ingredient is used, treat it as reduced or unavailable for later days unless the quantity clearly supports reuse.
3. For each day, list ingredients missing from inventory.
4. Do not repeat the same recipe twice in the week.
5. Assume a home cook, basic equipment, under 45 minutes prep/cook time.
6. Respect dietary constraints if given.

Return ONLY valid JSON, no markdown fences, no preamble:
{
  "week_plan": [
    {
      "day": "Monday",
      "recipe_name": "string",
      "uses_inventory": ["item names used"],
      "missing_ingredients": ["item names not in inventory"],
      "expiry_priority": true or false,
      "brief_instructions": "1-2 sentence summary"
    }
  ]
}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { inventory, dietary } = req.body || {};
  if (!Array.isArray(inventory) || inventory.length === 0) {
    return res.status(400).json({ error: "Missing or empty inventory array in request body" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in your Vercel project's environment variables." });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        messages: [{ role: "user", content: buildPrompt(inventory, dietary) }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || "Anthropic API error" });
    }

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const cleaned = text.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(502).json({ error: "Model returned unparseable output. Try again." });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Failed to generate plan: " + err.message });
  }
}
