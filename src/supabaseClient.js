import { createClient } from "@supabase/supabase-js";

// Reads from Vite env vars — see .env.example for the two you need to set.
// The anon key is safe to expose client-side; it's designed for that, and
// all real access control happens in Postgres via the RLS policies and
// SECURITY DEFINER functions from 001_households_and_invites.sql.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ── Auth ─────────────────────────────────────────────────────

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function getSession() {
  return supabase.auth.getSession();
}

export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return data.subscription; // caller should call .unsubscribe() on cleanup
}

// ── Households & invites ────────────────────────────────────

export async function createHousehold(name) {
  const { data, error } = await supabase.rpc("create_household", { household_name: name });
  if (error) throw error;
  return data; // new household id
}

export async function createInvite(householdId, email = null) {
  const { data, error } = await supabase.rpc("create_invite", {
    hid: householdId,
    invite_email: email,
  });
  if (error) throw error;
  return data; // invite token (uuid)
}

// Call this after the invited user has signed up and is logged in.
export async function acceptInvite(token) {
  const { data, error } = await supabase.rpc("accept_invite", { invite_token: token });
  if (error) throw error;
  return data; // household id they just joined
}

export async function getMyHouseholds() {
  const { data, error } = await supabase
    .from("household_members")
    .select("household_id, role, households(id, name)");
  if (error) throw error;
  return data;
}

// Builds a shareable invite link. Adjust the base path once you decide
// where the "accept invite" page/route will live in the app.
export function buildInviteLink(token) {
  return `${window.location.origin}/join?token=${token}`;
}

// There's no household-switcher UI yet, so this picks (or creates) a single
// default household per user. Once you build multi-household support, swap
// this out for a real "current household" selector stored in app state.
export async function getOrCreateDefaultHousehold() {
  const households = await getMyHouseholds();
  if (households.length > 0) {
    return households[0].household_id;
  }
  return createHousehold("My Household");
}

export async function getHousehold(householdId) {
  const { data, error } = await supabase
    .from("households")
    .select("id, name, monthly_income, savings_goal_percent, monthly_debt_payments, emergency_fund_balance, emergency_fund_target_months")
    .eq("id", householdId)
    .single();
  if (error) throw error;
  return data;
}

export async function updateHouseholdBudget(householdId, { monthlyIncome, savingsGoalPercent, monthlyDebtPayments, emergencyFundBalance, emergencyFundTargetMonths }) {
  const { data, error } = await supabase
    .from("households")
    .update({
      monthly_income: monthlyIncome,
      savings_goal_percent: savingsGoalPercent,
      monthly_debt_payments: monthlyDebtPayments,
      emergency_fund_balance: emergencyFundBalance,
      emergency_fund_target_months: emergencyFundTargetMonths,
    })
    .eq("id", householdId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Inventory ────────────────────────────────────────────────

export async function getInventory(householdId) {
  const { data, error } = await supabase
    .from("inventory_items")
    .select("*")
    .eq("household_id", householdId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

// Upserts a batch of scanned items. Matches existing rows by
// (household_id, name) case-insensitively via the name_normalized column,
// so re-scanning "Banana" updates the existing row instead of duplicating it.
// Scanned items don't carry a real quantity/unit from YOLO (just a box
// count), so they default to a plain count in "pcs" — the user can correct
// this via "Fill manually" if it's wrong.
export async function upsertInventoryItems(householdId, items) {
  const today = new Date();
  const rows = items.map((item) => {
    const rawExpiresInDays = item.expiresInDays ?? item.expires_in_days ?? null;
    const expiryDate = rawExpiresInDays != null
      ? new Date(today.getTime() + rawExpiresInDays * 86400000).toISOString().slice(0, 10)
      : null;
    const count = parseInt(item.quantity_estimate ?? item.quantity, 10);

    return {
      household_id: householdId,
      name: item.name,
      category: item.category || "other",
      confidence: item.confidence || "medium",
      note: item.note || null,
      source: item.source || "scan",
      quantity_amount: isNaN(count) ? 1 : count,
      quantity_unit: "pcs",
      expiry_date: expiryDate,
    };
  });

  const { data, error } = await supabase
    .from("inventory_items")
    .upsert(rows, { onConflict: "household_id,name_normalized" })
    .select();
  if (error) throw error;
  return data;
}

// Fast one-line add — defaults to "1 pcs", no expiry. Matches the old quick
// add-by-hand flow. Use addManualInventoryItem for the full form.
export async function quickAddInventoryItem(householdId, name) {
  const { data, error } = await supabase
    .from("inventory_items")
    .upsert(
      [{ household_id: householdId, name, source: "manual", quantity_amount: 1, quantity_unit: "pcs" }],
      { onConflict: "household_id,name_normalized" }
    )
    .select();
  if (error) throw error;
  return data[0];
}

// Full manual entry — name, quantityAmount, quantityUnit are required by the
// UI form; category, expiryDate, note are optional.
export async function addManualInventoryItem(householdId, { name, quantityAmount, quantityUnit, expiryDate, category, note }) {
  const { data, error } = await supabase
    .from("inventory_items")
    .upsert(
      [{
        household_id: householdId,
        name,
        quantity_amount: quantityAmount,
        quantity_unit: quantityUnit,
        expiry_date: expiryDate || null,
        category: category || "other",
        note: note || null,
        source: "manual",
      }],
      { onConflict: "household_id,name_normalized" }
    )
    .select();
  if (error) throw error;
  return data[0];
}

export async function updateInventoryItem(id, patch) {
  const { data, error } = await supabase
    .from("inventory_items")
    .update(patch)
    .eq("id", id)
    .select();
  if (error) throw error;
  return data[0];
}

export async function deleteInventoryItem(id) {
  const { error } = await supabase.from("inventory_items").delete().eq("id", id);
  if (error) throw error;
}

// ── Household members ────────────────────────────────────────

export async function getHouseholdMembers(householdId) {
  const { data, error } = await supabase.rpc("get_household_members", { hid: householdId });
  if (error) throw error;
  return data;
}

// ── Chores ───────────────────────────────────────────────────

export async function getChores(householdId) {
  const { data, error } = await supabase
    .from("chores")
    .select("*")
    .eq("household_id", householdId)
    .order("due_date", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data;
}

export async function createChore(householdId, { title, assignedTo, dueDate, dueTime, recurrence }) {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("chores")
    .insert([{
      household_id: householdId,
      title,
      assigned_to: assignedTo || null,
      due_date: dueDate || null,
      due_time: dueTime || null,
      recurrence: recurrence || "none",
      created_by: userData.user.id,
    }])
    .select();
  if (error) throw error;
  return data[0];
}

export async function toggleChoreDone(id, done) {
  const { data, error } = await supabase
    .from("chores")
    .update({ done, done_at: done ? new Date().toISOString() : null })
    .eq("id", id)
    .select();
  if (error) throw error;
  return data[0];
}

export async function deleteChore(id) {
  const { error } = await supabase.from("chores").delete().eq("id", id);
  if (error) throw error;
}

// ── Recipe library ───────────────────────────────────────────

export async function getRecipes(householdId) {
  // RLS already scopes this to global (household_id null) + your own
  // household's recipes — no need to filter client-side.
  const { data, error } = await supabase
    .from("recipes")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw error;
  return data;
}

// Editing a global recipe (household_id null) creates a new household-owned
// copy instead of mutating the shared original — RLS wouldn't allow mutating
// it anyway (update policy requires household_id is not null), but forking
// explicitly here gives a clear, intentional "make this yours" action rather
// than a confusing permission error.
export async function forkOrUpdateRecipe(householdId, recipe, patch) {
  const { data: userData } = await supabase.auth.getUser();
  if (recipe.household_id === null) {
    const { data, error } = await supabase
      .from("recipes")
      .insert([{
        household_id: householdId,
        name: patch.name ?? recipe.name,
        ingredients: patch.ingredients ?? recipe.ingredients,
        tags: patch.tags ?? recipe.tags,
        instructions: patch.instructions ?? recipe.instructions,
        created_by: userData.user.id,
      }])
      .select();
    if (error) throw error;
    return data[0];
  }
  const { data, error } = await supabase
    .from("recipes")
    .update(patch)
    .eq("id", recipe.id)
    .select();
  if (error) throw error;
  return data[0];
}

export async function createRecipe(householdId, { name, ingredients, tags, instructions }) {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("recipes")
    .insert([{
      household_id: householdId,
      name,
      ingredients: ingredients || [],
      tags: tags || [],
      instructions: instructions || "",
      created_by: userData.user.id,
    }])
    .select();
  if (error) throw error;
  return data[0];
}

export async function deleteRecipe(id) {
  const { error } = await supabase.from("recipes").delete().eq("id", id);
  if (error) throw error;
}

// ── Receipts / budget ────────────────────────────────────────

export async function saveReceipt(householdId, { rawText, items, totalSpend, purchasedAt }) {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("receipts")
    .insert([{
      household_id: householdId,
      uploaded_by: userData.user.id,
      raw_ocr_text: rawText,
      parsed_items: items,
      total_spend: totalSpend,
      purchased_at: purchasedAt || new Date().toISOString().slice(0, 10),
    }])
    .select();
  if (error) throw error;
  return data[0];
}

export async function getReceipts(householdId) {
  const { data, error } = await supabase
    .from("receipts")
    .select("*")
    .eq("household_id", householdId)
    .order("purchased_at", { ascending: false });
  if (error) throw error;
  return data;
}