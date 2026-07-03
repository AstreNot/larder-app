const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function normalize(name) {
  return (name || "").trim().toLowerCase();
}

function matchesDietary(recipe, dietary) {
  if (!dietary) return true;
  const wants = dietary.toLowerCase();
  if (wants.includes("vegetarian") && !recipe.tags.includes("vegetarian")) return false;
  if (wants.includes("vegan") && !recipe.tags.includes("vegan") && !recipe.tags.includes("vegan-optional")) return false;
  return true;
}

// Scores a recipe against currently available inventory. Ingredients that are
// close to expiring are weighted much more heavily, so the algorithm naturally
// front-loads recipes that use up what's about to go bad.
function scoreRecipe(recipe, available) {
  let score = 0;
  for (const ingredient of recipe.ingredients) {
    const item = available.get(normalize(ingredient));
    if (!item) continue;
    score += 1;
    if (item.expires_in_days != null) {
      if (item.expires_in_days <= 2) score += 6;
      else if (item.expires_in_days <= 4) score += 3;
      else score += 1;
    }
  }
  return score;
}

/**
 * Greedy weekly planner: for each day, picks the unused recipe that best uses
 * currently available inventory (weighted toward soon-expiring items), then
 * "depletes" whatever it used before planning the next day.
 *
 * This is a simplification worth knowing about: each matched ingredient is
 * removed entirely after one use, rather than tracking partial quantities
 * (e.g. "6 eggs" supporting multiple meals). Good enough for a demo; a real
 * quantity-aware version would need numeric parsing of quantity_estimate.
 */
function planWeek(inventory, recipes, dietary) {
  const available = new Map();
  for (const item of inventory) {
    available.set(normalize(item.name), item);
  }

  const eligibleRecipes = recipes.filter((r) => matchesDietary(r, dietary));
  const pool = eligibleRecipes.length > 0 ? eligibleRecipes : recipes;

  const used = new Set();
  const weekPlan = [];

  for (const day of DAYS) {
    let best = null;
    let bestScore = -1;

    for (const recipe of pool) {
      if (used.has(recipe.name)) continue;
      const score = scoreRecipe(recipe, available);
      if (score > bestScore) {
        bestScore = score;
        best = recipe;
      }
    }

    // If every recipe has been used (more days than recipes), allow repeats
    // rather than leaving a day blank.
    if (!best) {
      best = pool.find((r) => !used.has(r.name)) || pool[0];
    }

    used.add(best.name);

    const usesInventory = [];
    const missingIngredients = [];
    let expiryPriority = false;

    for (const ingredient of best.ingredients) {
      const item = available.get(normalize(ingredient));
      if (item) {
        usesInventory.push(item.name);
        if (item.expires_in_days != null && item.expires_in_days <= 2) {
          expiryPriority = true;
        }
        available.delete(normalize(ingredient));
      } else {
        missingIngredients.push(ingredient);
      }
    }

    weekPlan.push({
      day,
      recipe_name: best.name,
      uses_inventory: usesInventory,
      missing_ingredients: missingIngredients,
      expiry_priority: expiryPriority,
      brief_instructions: best.instructions,
    });
  }

  return weekPlan;
}

export { planWeek };
