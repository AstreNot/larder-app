import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { planWeek } from "../lib/matchRecipes.js";

// This route no longer calls any external API. Planning is done locally with
// a greedy optimization algorithm (see lib/matchRecipes.js) against a curated
// recipe dataset (data/recipes.json). Zero cost, no rate limits, instant.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const recipes = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "recipes.json"), "utf-8")
);

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { inventory, dietary } = req.body || {};
  if (!Array.isArray(inventory) || inventory.length === 0) {
    return res.status(400).json({ error: "Missing or empty inventory array in request body" });
  }

  try {
    const week_plan = planWeek(inventory, recipes, dietary);
    return res.status(200).json({ week_plan });
  } catch (err) {
    return res.status(500).json({ error: "Failed to generate plan: " + err.message });
  }
}
