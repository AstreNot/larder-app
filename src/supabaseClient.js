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

// Upserts a batch of scanned/manual items. Matches existing rows by
// (household_id, name) case-insensitively via the name_normalized column,
// so re-scanning "Banana" updates the existing row instead of duplicating it.
export async function upsertInventoryItems(householdId, items) {
  const rows = items.map((item) => ({
    household_id: householdId,
    name: item.name,
    quantity: item.quantity ?? item.quantity_estimate ?? null,
    category: item.category || "other",
    confidence: item.confidence || "medium",
    expires_in_days: item.expiresInDays ?? item.expires_in_days ?? null,
    note: item.note || null,
    source: item.source || "scan",
  }));

  const { data, error } = await supabase
    .from("inventory_items")
    .upsert(rows, { onConflict: "household_id,name_normalized" })
    .select();
  if (error) throw error;
  return data;
}

export async function addManualInventoryItem(householdId, name) {
  const { data, error } = await supabase
    .from("inventory_items")
    .upsert(
      [{ household_id: householdId, name, source: "manual" }],
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

export async function createChore(householdId, { title, assignedTo, dueDate, recurrence }) {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("chores")
    .insert([{
      household_id: householdId,
      title,
      assigned_to: assignedTo || null,
      due_date: dueDate || null,
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