import React, { useState, useMemo, useRef, useEffect } from "react";
import { Camera, Plus, X, Leaf, AlertTriangle, ShoppingCart, Calendar, Package, ChevronDown, ChevronUp, Loader2, CheckSquare, Square, DollarSign } from "lucide-react";
import {
  getSession,
  onAuthChange,
  signIn,
  signUp,
  signOut,
  getOrCreateDefaultHousehold,
  getHousehold,
  updateHouseholdBudget,
  getInventory,
  upsertInventoryItems,
  quickAddInventoryItem,
  addManualInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  getHouseholdMembers,
  getChores,
  createChore,
  toggleChoreDone,
  deleteChore,
  getRecipes,
  forkOrUpdateRecipe,
  createRecipe,
  deleteRecipe,
  saveReceipt,
  getReceipts,
} from "./supabaseClient";

const COLORS = {
  bg: "#EDF3EC",
  surface: "#FFFFFF",
  ink: "#1F2E22",
  inkSoft: "#52625B",
  border: "#D8E2D4",
  fresh: "#3E7C59",
  freshBg: "#E4F0E8",
  soon: "#C9862C",
  soonBg: "#FBF0DE",
  urgent: "#B23A2E",
  urgentBg: "#FAE6E3",
};

const CATEGORY_DOTS = {
  produce: "#3E7C59",
  dairy: "#3E6B8C",
  meat: "#8C4A3E",
  grain: "#A9905A",
  spice: "#7A5C8C",
  condiment: "#B27A3E",
  pantry: "#7A7A72",
  beverage: "#3E8C82",
  other: "#8A8A82",
};

function expiryTier(days) {
  if (days === undefined || days === null) return null;
  if (days <= 2) return "urgent";
  if (days <= 4) return "soon";
  return "fresh";
}

// Units only combine within the same family — mass units convert to grams,
// volume units convert to milliliters, "pcs" stands alone. A recipe needing
// grams of something the pantry has logged in pcs can't be safely combined,
// so it's treated as a family mismatch rather than guessed at.
const UNIT_FAMILY = { g: "mass", kg: "mass", ml: "volume", l: "volume", pcs: "count" };
const TO_BASE_UNIT = { g: 1, kg: 1000, ml: 1, l: 1000, pcs: 1 };
const BASE_UNIT_LABEL = { mass: "g", volume: "ml", count: "pcs" };

function normalizeName(name) {
  return (name || "").trim().toLowerCase();
}

// Converts a Supabase inventory_items row into the shape the UI uses.
// expiresInDays is computed here from the real expiry_date, rather than
// trusting a stored day-count, since a stored number goes stale as days pass.
function rowToItem(row) {
  let expiresInDays = null;
  if (row.expiry_date) {
    const msPerDay = 86400000;
    const today = new Date(new Date().toDateString());
    const expiry = new Date(row.expiry_date);
    expiresInDays = Math.round((expiry - today) / msPerDay);
  }
  return {
    id: row.id,
    name: row.name,
    quantityAmount: row.quantity_amount ?? null,
    quantityUnit: row.quantity_unit ?? null,
    category: row.category || "other",
    confidence: row.confidence || "medium",
    expiresInDays,
    expiryDate: row.expiry_date ?? null,
    note: row.note || null,
  };
}

// Resize + compress the photo client-side before sending it to our API.
// This keeps request payloads small and reliable across hosting body-size limits.
function resizeImage(file, maxDimension = 1024, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDimension) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else if (height > maxDimension) {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({ base64: dataUrl.split(",")[1], mediaType: "image/jpeg", dataUrl });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Heuristic receipt parser — NOT reliable, by design of the input (OCR text
// from a photographed receipt). It looks for lines ending in a price and
// skips obvious non-item lines (totals, tax, card info). This is meant to
// pre-fill a list for the user to review and correct, not to be authoritative.
function parseReceiptText(text) {
  const skipPattern = /total|tax|subtotal|change|cash|balance|visa|mastercard|debit|credit|approved|auth|thank|store|receipt|#/i;
  const priceLineRegex = /^(.{2,40}?)\s+\$?(\d{1,4}\.\d{2})$/;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const items = [];
  for (const line of lines) {
    if (skipPattern.test(line)) continue;
    const match = line.match(priceLineRegex);
    if (!match) continue;
    const name = match[1].replace(/[^\w\s.'-]/g, "").trim();
    const price = parseFloat(match[2]);
    if (name.length > 0 && !isNaN(price) && price > 0 && price < 1000) {
      items.push({ id: `parsed_${items.length}_${Date.now()}`, name, price });
    }
  }
  return items;
}

// Builds a 6-row (42-cell) month grid for a simple from-scratch calendar —
// no charting/calendar library needed for something this contained.
function buildCalendarGrid(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

// ── Minimal auth gate ──────────────────────────────────────────
// Placeholder UI just to make the app usable end-to-end. Worth restyling
// properly (and adding the invite-accept flow) once the core data wiring
// is confirmed solid — this is intentionally bare-bones for now.
function AuthGate() {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [signedUpMessage, setSignedUpMessage] = useState(null);

  const submit = async () => {
    setError(null);
    setSignedUpMessage(null);
    setLoading(true);
    try {
      if (mode === "signup") {
        const data = await signUp(email, password);
        if (!data.session) {
          setSignedUpMessage("Account created. Check your email to confirm, then sign in.");
          setMode("signin");
        }
      } else {
        await signIn(email, password);
      }
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', sans-serif" }}>
      <div className="w-full max-w-sm px-6">
        <div className="flex items-center gap-2 mb-1 justify-center">
          <Package size={22} color={COLORS.fresh} />
          <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 22, color: COLORS.ink }}>Larder</h1>
        </div>
        <p style={{ color: COLORS.inkSoft, fontSize: 13, marginBottom: 20, textAlign: "center" }}>
          {mode === "signin" ? "Sign in to your household" : "Create your account"}
        </p>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          type="email"
          className="w-full rounded-lg px-3 py-2 text-sm mb-2"
          style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          type="password"
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="w-full rounded-lg px-3 py-2 text-sm mb-3"
          style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}
        />
        {error && <div style={{ color: COLORS.urgent, fontSize: 12, marginBottom: 8 }}>{error}</div>}
        {signedUpMessage && <div style={{ color: COLORS.fresh, fontSize: 12, marginBottom: 8 }}>{signedUpMessage}</div>}
        <button
          onClick={submit}
          disabled={loading || !email || !password}
          className="w-full rounded-lg py-2.5 text-sm flex items-center justify-center gap-2 mb-3"
          style={{ background: COLORS.fresh, color: "#fff", fontWeight: 500, opacity: loading ? 0.7 : 1 }}
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : null}
          {mode === "signin" ? "Sign in" : "Sign up"}
        </button>
        <div style={{ textAlign: "center", fontSize: 12, color: COLORS.inkSoft }}>
          {mode === "signin" ? (
            <span>No account? <button onClick={() => setMode("signup")} style={{ color: COLORS.fresh, fontWeight: 500 }}>Sign up</button></span>
          ) : (
            <span>Already have one? <button onClick={() => setMode("signin")} style={{ color: COLORS.fresh, fontWeight: 500 }}>Sign in</button></span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still checking, null = logged out
  const [householdId, setHouseholdId] = useState(null);
  const [loadingInventory, setLoadingInventory] = useState(false);
  const [inventoryError, setInventoryError] = useState(null);

  const [tab, setTab] = useState("pantry");
  const [inventory, setInventory] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [dietary, setDietary] = useState("");
  const [weekPlan, setWeekPlan] = useState([]);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [checked, setChecked] = useState({});
  const [expandedDay, setExpandedDay] = useState(null);
  const [manualName, setManualName] = useState("");
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualFullName, setManualFullName] = useState("");
  const [manualQuantityAmount, setManualQuantityAmount] = useState("");
  const [manualQuantityUnit, setManualQuantityUnit] = useState("pcs");
  const [manualExpiryDate, setManualExpiryDate] = useState("");
  const [manualCategory, setManualCategory] = useState("other");
  const [manualNote, setManualNote] = useState("");
  const fileInputRef = useRef(null);

  const [chores, setChores] = useState([]);
  const [householdMembers, setHouseholdMembers] = useState([]);
  const [choresError, setChoresError] = useState(null);
  const [choreTitle, setChoreTitle] = useState("");
  const [choreAssignee, setChoreAssignee] = useState("");
  const [choreDueDate, setChoreDueDate] = useState("");
  const [choreDueTime, setChoreDueTime] = useState("");
  const [choreRecurrence, setChoreRecurrence] = useState("none");
  const [choresView, setChoresView] = useState("list"); // "list" | "calendar"
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const [receipts, setReceipts] = useState([]);
  const [budgetError, setBudgetError] = useState(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [reviewItems, setReviewItems] = useState(null); // null = no review in progress
  const [reviewRawText, setReviewRawText] = useState("");
  const [reviewDate, setReviewDate] = useState("");
  const receiptInputRef = useRef(null);

  const [householdInfo, setHouseholdInfo] = useState(null);
  const [incomeInput, setIncomeInput] = useState("");
  const [savingsGoalInput, setSavingsGoalInput] = useState("20");
  const [debtInput, setDebtInput] = useState("");
  const [emergencyFundInput, setEmergencyFundInput] = useState("");
  const [emergencyMonthsInput, setEmergencyMonthsInput] = useState("6");
  const [savingBudget, setSavingBudget] = useState(false);

  const [weekView, setWeekView] = useState("auto"); // "auto" | "browse"
  const [recipes, setRecipes] = useState([]);
  const [recipesError, setRecipesError] = useState(null);
  const [recipeSearch, setRecipeSearch] = useState("");
  const [selectedRecipeIds, setSelectedRecipeIds] = useState(() => new Set());
  const [editingRecipeId, setEditingRecipeId] = useState(null); // "new" for a fresh recipe
  const [editName, setEditName] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [editIngredients, setEditIngredients] = useState([]);
  const [groceryListGenerated, setGroceryListGenerated] = useState(false);

  // ── Auth bootstrap ────────────────────────────────────────
  useEffect(() => {
    getSession().then(({ data }) => setSession(data.session));
    const sub = onAuthChange((newSession) => setSession(newSession));
    return () => sub.unsubscribe();
  }, []);

  // ── Household + inventory bootstrap, once logged in ──────
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      setLoadingInventory(true);
      setInventoryError(null);
      try {
        const hid = await getOrCreateDefaultHousehold();
        if (cancelled) return;
        setHouseholdId(hid);
        const rows = await getInventory(hid);
        if (cancelled) return;
        setInventory(rows.map(rowToItem));

        const [choreRows, members, receiptRows, household, recipeRows] = await Promise.all([
          getChores(hid),
          getHouseholdMembers(hid),
          getReceipts(hid),
          getHousehold(hid),
          getRecipes(hid),
        ]);
        if (cancelled) return;
        setChores(choreRows);
        setHouseholdMembers(members);
        setReceipts(receiptRows);
        setHouseholdInfo(household);
        setIncomeInput(household.monthly_income != null ? String(household.monthly_income) : "");
        setSavingsGoalInput(household.savings_goal_percent != null ? String(household.savings_goal_percent) : "20");
        setDebtInput(household.monthly_debt_payments != null ? String(household.monthly_debt_payments) : "");
        setEmergencyFundInput(household.emergency_fund_balance != null ? String(household.emergency_fund_balance) : "");
        setEmergencyMonthsInput(household.emergency_fund_target_months != null ? String(household.emergency_fund_target_months) : "6");
        setRecipes(recipeRows);
      } catch (err) {
        if (!cancelled) setInventoryError(err.message || "Couldn't load your pantry.");
      } finally {
        if (!cancelled) setLoadingInventory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !householdId) return;
    setScanError(null);
    setScanning(true);
    try {
      const { base64, mediaType, dataUrl } = await resizeImage(file);
      setPreview(dataUrl);

      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64, mediaType }),
      });
      const parsed = await response.json();

      if (!response.ok) {
        throw new Error(parsed.error || "Scan failed");
      }

      const items = (parsed.items || []).map((item) => ({ ...item, source: "scan" }));
      if (items.length > 0) {
        await upsertInventoryItems(householdId, items);
      }
      // Refetch so local state matches the database exactly (handles merges
      // with existing rows server-side rather than re-implementing that logic here).
      const rows = await getInventory(householdId);
      setInventory(rows.map(rowToItem));
    } catch (err) {
      setScanError(err.message || "Couldn't read that photo. Try again with better lighting, or add items manually below.");
    } finally {
      setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Local-only update, used while typing — no network call per keystroke.
  const updateItemLocal = (id, patch) => {
    setInventory((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  // Persists a field once the user is done editing (e.g. onBlur).
  const commitItem = async (id, patch) => {
    try {
      await updateInventoryItem(id, patch);
    } catch (err) {
      setInventoryError(err.message || "Couldn't save that change.");
    }
  };

  const removeItem = async (id) => {
    setInventory((prev) => prev.filter((it) => it.id !== id));
    try {
      await deleteInventoryItem(id);
    } catch (err) {
      setInventoryError(err.message || "Couldn't delete that item.");
    }
  };

  const addManualItem = async () => {
    const name = manualName.trim();
    if (!name || !householdId) return;
    setManualName("");
    try {
      const row = await quickAddInventoryItem(householdId, name);
      setInventory((prev) => {
        const byName = new Map(prev.map((it) => [normalizeName(it.name), it]));
        byName.set(normalizeName(row.name), rowToItem(row));
        return Array.from(byName.values());
      });
    } catch (err) {
      setInventoryError(err.message || "Couldn't add that item.");
    }
  };

  const submitManualForm = async () => {
    const name = manualFullName.trim();
    const amount = parseFloat(manualQuantityAmount);
    if (!name || !householdId) {
      setInventoryError("Item name is required.");
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      setInventoryError("Enter a valid quantity.");
      return;
    }
    if (!manualQuantityUnit) {
      setInventoryError("Pick a unit.");
      return;
    }
    setInventoryError(null);
    try {
      const row = await addManualInventoryItem(householdId, {
        name,
        quantityAmount: amount,
        quantityUnit: manualQuantityUnit,
        expiryDate: manualExpiryDate || null,
        category: manualCategory,
        note: manualNote || null,
      });
      setInventory((prev) => {
        const byName = new Map(prev.map((it) => [normalizeName(it.name), it]));
        byName.set(normalizeName(row.name), rowToItem(row));
        return Array.from(byName.values());
      });
      setManualFullName("");
      setManualQuantityAmount("");
      setManualQuantityUnit("pcs");
      setManualExpiryDate("");
      setManualCategory("other");
      setManualNote("");
      setShowManualForm(false);
    } catch (err) {
      setInventoryError(err.message || "Couldn't add that item.");
    }
  };

  const addChore = async () => {
    const title = choreTitle.trim();
    if (!title || !householdId) return;
    setChoresError(null);
    try {
      const chore = await createChore(householdId, {
        title,
        assignedTo: choreAssignee || null,
        dueDate: choreDueDate || null,
        dueTime: choreDueTime || null,
        recurrence: choreRecurrence,
      });
      setChores((prev) => [...prev, chore]);
      setChoreTitle("");
      setChoreDueDate("");
      setChoreDueTime("");
      setChoreRecurrence("none");
    } catch (err) {
      setChoresError(err.message || "Couldn't add that chore.");
    }
  };

  const toggleChore = async (id, currentlyDone) => {
    setChores((prev) => prev.map((c) => (c.id === id ? { ...c, done: !currentlyDone } : c)));
    try {
      await toggleChoreDone(id, !currentlyDone);
    } catch (err) {
      setChoresError(err.message || "Couldn't update that chore.");
    }
  };

  const removeChore = async (id) => {
    setChores((prev) => prev.filter((c) => c.id !== id));
    try {
      await deleteChore(id);
    } catch (err) {
      setChoresError(err.message || "Couldn't delete that chore.");
    }
  };

  const memberLabel = (userId) => {
    const member = householdMembers.find((m) => m.user_id === userId);
    return member ? member.email : "Unassigned";
  };

  const handleReceiptPhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBudgetError(null);
    setOcrRunning(true);
    try {
      const { dataUrl } = await resizeImage(file, 1600, 0.9); // OCR wants more detail than the pantry scan
      // Loaded on demand — tesseract.js's wasm payload is large, no reason
      // to pull it into the initial bundle for people who never scan a receipt.
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng");
      const { data: { text } } = await worker.recognize(dataUrl);
      await worker.terminate();

      const items = parseReceiptText(text);
      setReviewRawText(text);
      setReviewDate(new Date().toISOString().slice(0, 10));
      setReviewItems(items); // may be empty — user can add lines by hand either way
    } catch (err) {
      setBudgetError(err.message || "Couldn't read that receipt. Try a clearer, flatter photo, or enter items by hand.");
    } finally {
      setOcrRunning(false);
      if (receiptInputRef.current) receiptInputRef.current.value = "";
    }
  };

  const updateReviewItem = (id, patch) => {
    setReviewItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  const removeReviewItem = (id) => {
    setReviewItems((prev) => prev.filter((it) => it.id !== id));
  };

  const addReviewItem = () => {
    setReviewItems((prev) => [...prev, { id: `manual_${Date.now()}`, name: "", price: 0 }]);
  };

  const reviewTotal = useMemo(() => {
    if (!reviewItems) return 0;
    return reviewItems.reduce((sum, it) => sum + (parseFloat(it.price) || 0), 0);
  }, [reviewItems]);

  const cancelReview = () => {
    setReviewItems(null);
    setReviewRawText("");
  };

  const confirmSaveReceipt = async () => {
    if (!householdId || !reviewItems) return;
    setBudgetError(null);
    try {
      const cleanItems = reviewItems
        .filter((it) => it.name.trim().length > 0)
        .map((it) => ({ name: it.name.trim(), price: parseFloat(it.price) || 0 }));
      const receipt = await saveReceipt(householdId, {
        rawText: reviewRawText,
        items: cleanItems,
        totalSpend: reviewTotal,
        purchasedAt: reviewDate,
      });
      setReceipts((prev) => [receipt, ...prev]);
      cancelReview();
    } catch (err) {
      setBudgetError(err.message || "Couldn't save that receipt.");
    }
  };

  const monthlyTotals = useMemo(() => {
    const map = new Map();
    for (const r of receipts) {
      const month = (r.purchased_at || "").slice(0, 7); // YYYY-MM
      map.set(month, (map.get(month) || 0) + Number(r.total_spend || 0));
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [receipts]);

  const currentMonthKey = new Date().toISOString().slice(0, 7);
  const currentMonthSpend = useMemo(() => {
    const entry = monthlyTotals.find(([month]) => month === currentMonthKey);
    return entry ? entry[1] : 0;
  }, [monthlyTotals, currentMonthKey]);

  // Four common personal-finance heuristics, each checked independently:
  // cashflow staying positive, debt payments not eating too much of income,
  // an actual savings rate, and an emergency fund sized in months of spend.
  // These are standard, widely-taught rules of thumb (not tied to any one
  // source) — the specific thresholds are defaults you can override via the
  // savings-goal and emergency-fund-months inputs.
  const budgetHealth = useMemo(() => {
    const income = householdInfo?.monthly_income;
    if (!income || income <= 0) return { status: "unset", checks: [] };

    const savingsGoalPercent = householdInfo?.savings_goal_percent ?? 20;
    const debtPayments = Number(householdInfo?.monthly_debt_payments) || 0;
    const emergencyBalance = Number(householdInfo?.emergency_fund_balance) || 0;
    const emergencyTargetMonths = Number(householdInfo?.emergency_fund_target_months) || 6;

    const cashflow = income - currentMonthSpend - debtPayments;
    const debtRatio = (debtPayments / income) * 100;
    const savingsRate = (cashflow / income) * 100;
    const emergencyTarget = currentMonthSpend > 0 ? currentMonthSpend * emergencyTargetMonths : 0;
    const emergencyProgress = emergencyTarget > 0 ? Math.min((emergencyBalance / emergencyTarget) * 100, 100) : null;

    const checks = [
      {
        key: "cashflow",
        label: "Cashflow",
        pass: cashflow >= 0,
        detail: cashflow >= 0 ? `$${cashflow.toFixed(2)} left after spending and debt` : `$${Math.abs(cashflow).toFixed(2)} short this month`,
      },
      {
        key: "debt",
        label: "Debt load",
        pass: debtRatio <= 30,
        detail: `${debtRatio.toFixed(0)}% of income goes to debt payments (aim for 30% or under)`,
      },
      {
        key: "savings",
        label: "Savings rate",
        pass: savingsRate >= savingsGoalPercent,
        detail: `${savingsRate.toFixed(0)}% saved this month (goal: ${savingsGoalPercent}%)`,
      },
      {
        key: "emergency",
        label: "Emergency fund",
        pass: emergencyProgress === null ? true : emergencyProgress >= 100,
        detail: emergencyProgress === null
          ? "Not enough spend history yet to size a target"
          : `${emergencyProgress.toFixed(0)}% of your ${emergencyTargetMonths}-month target ($${emergencyTarget.toFixed(0)})`,
      },
    ];

    const passCount = checks.filter((c) => c.pass).length;
    const status = passCount === checks.length ? "healthy" : passCount >= checks.length - 1 ? "caution" : "over";

    return { status, checks, cashflow, remaining: cashflow };
  }, [householdInfo, currentMonthSpend]);

  const saveBudgetSettings = async () => {
    if (!householdId) return;
    const income = parseFloat(incomeInput);
    const goal = parseFloat(savingsGoalInput);
    const debt = parseFloat(debtInput);
    const emergencyBalance = parseFloat(emergencyFundInput);
    const emergencyMonths = parseFloat(emergencyMonthsInput);
    setSavingBudget(true);
    setBudgetError(null);
    try {
      const updated = await updateHouseholdBudget(householdId, {
        monthlyIncome: isNaN(income) ? null : income,
        savingsGoalPercent: isNaN(goal) ? 20 : goal,
        monthlyDebtPayments: isNaN(debt) ? 0 : debt,
        emergencyFundBalance: isNaN(emergencyBalance) ? 0 : emergencyBalance,
        emergencyFundTargetMonths: isNaN(emergencyMonths) ? 6 : emergencyMonths,
      });
      setHouseholdInfo(updated);
    } catch (err) {
      setBudgetError(err.message || "Couldn't save budget settings.");
    } finally {
      setSavingBudget(false);
    }
  };

  const filteredRecipes = useMemo(() => {
    const q = recipeSearch.trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      (r.tags || []).some((t) => t.toLowerCase().includes(q)) ||
      (r.ingredients || []).some((ing) => ing.name.toLowerCase().includes(q))
    );
  }, [recipes, recipeSearch]);

  const toggleRecipeSelected = (id) => {
    setSelectedRecipeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openEditRecipe = (recipe) => {
    setEditingRecipeId(recipe.id);
    setEditName(recipe.name);
    setEditTags((recipe.tags || []).join(", "));
    setEditInstructions(recipe.instructions || "");
    setEditIngredients((recipe.ingredients || []).map((ing, i) => ({ id: `ing_${i}`, ...ing })));
  };

  const openNewRecipe = () => {
    setEditingRecipeId("new");
    setEditName("");
    setEditTags("");
    setEditInstructions("");
    setEditIngredients([{ id: "ing_0", name: "", amount: "", unit: "pcs" }]);
  };

  const closeEditRecipe = () => {
    setEditingRecipeId(null);
  };

  const updateEditIngredient = (id, patch) => {
    setEditIngredients((prev) => prev.map((ing) => (ing.id === id ? { ...ing, ...patch } : ing)));
  };

  const removeEditIngredient = (id) => {
    setEditIngredients((prev) => prev.filter((ing) => ing.id !== id));
  };

  const addEditIngredient = () => {
    setEditIngredients((prev) => [...prev, { id: `ing_${Date.now()}`, name: "", amount: "", unit: "pcs" }]);
  };

  const saveRecipe = async () => {
    if (!householdId || !editName.trim()) {
      setRecipesError("Recipe name is required.");
      return;
    }
    setRecipesError(null);
    const cleanIngredients = editIngredients
      .filter((ing) => ing.name.trim())
      .map((ing) => ({ name: ing.name.trim(), amount: parseFloat(ing.amount) || 0, unit: ing.unit || "pcs" }));
    const tags = editTags.split(",").map((t) => t.trim()).filter(Boolean);

    try {
      if (editingRecipeId === "new") {
        const recipe = await createRecipe(householdId, { name: editName.trim(), ingredients: cleanIngredients, tags, instructions: editInstructions });
        setRecipes((prev) => [...prev, recipe].sort((a, b) => a.name.localeCompare(b.name)));
      } else {
        const original = recipes.find((r) => r.id === editingRecipeId);
        const saved = await forkOrUpdateRecipe(householdId, original, {
          name: editName.trim(),
          ingredients: cleanIngredients,
          tags,
          instructions: editInstructions,
        });
        setRecipes((prev) => {
          const withoutOriginal = original.household_id === null ? prev : prev.filter((r) => r.id !== original.id);
          return [...withoutOriginal, saved].sort((a, b) => a.name.localeCompare(b.name));
        });
      }
      closeEditRecipe();
    } catch (err) {
      setRecipesError(err.message || "Couldn't save that recipe.");
    }
  };

  const removeRecipe = async (recipe) => {
    if (recipe.household_id === null) return; // can't delete global starter recipes
    setRecipes((prev) => prev.filter((r) => r.id !== recipe.id));
    setSelectedRecipeIds((prev) => {
      const next = new Set(prev);
      next.delete(recipe.id);
      return next;
    });
    try {
      await deleteRecipe(recipe.id);
    } catch (err) {
      setRecipesError(err.message || "Couldn't delete that recipe.");
    }
  };

  // Sums ingredient needs across every selected recipe (converted to a base
  // unit per family), then compares each against matching pantry items.
  // Recomputes live if inventory or the selection changes while the panel
  // is open — "generated" just controls whether the panel is shown at all.
  const groceryResults = useMemo(() => {
    const needed = new Map(); // key: normalizedName:family -> { name, family, amountBase }
    for (const id of selectedRecipeIds) {
      const recipe = recipes.find((r) => r.id === id);
      if (!recipe) continue;
      for (const ing of recipe.ingredients || []) {
        const family = UNIT_FAMILY[ing.unit] || "count";
        const amountBase = (parseFloat(ing.amount) || 0) * (TO_BASE_UNIT[ing.unit] || 1);
        const key = `${normalizeName(ing.name)}:${family}`;
        if (!needed.has(key)) needed.set(key, { name: ing.name, family, amountBase: 0 });
        needed.get(key).amountBase += amountBase;
      }
    }

    return Array.from(needed.values())
      .map((n) => {
        const matches = inventory.filter(
          (it) => normalizeName(it.name) === normalizeName(n.name) && (UNIT_FAMILY[it.quantityUnit] || "count") === n.family
        );
        const availableBase = matches.reduce(
          (sum, it) => sum + (it.quantityAmount || 0) * (TO_BASE_UNIT[it.quantityUnit] || 1),
          0
        );
        const percent = n.amountBase > 0 ? Math.min((availableBase / n.amountBase) * 100, 100) : 100;
        const missingBase = Math.max(n.amountBase - availableBase, 0);
        return {
          name: n.name,
          unit: BASE_UNIT_LABEL[n.family],
          neededBase: n.amountBase,
          availableBase,
          percent,
          missingBase,
        };
      })
      .sort((a, b) => a.percent - b.percent);
  }, [selectedRecipeIds, recipes, inventory]);

  const planWeek = async () => {
    setPlanError(null);
    setPlanning(true);
    try {
      const invPayload = inventory.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        category: it.category,
        expires_in_days: it.expiresInDays,
      }));

      const response = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inventory: invPayload, dietary }),
      });
      const parsed = await response.json();

      if (!response.ok) {
        throw new Error(parsed.error || "Planning failed");
      }

      setWeekPlan(parsed.week_plan || []);
      setTab("week");
    } catch (err) {
      setPlanError(err.message || "Couldn't generate a plan just now. Try again in a moment.");
    } finally {
      setPlanning(false);
    }
  };

  const shoppingList = useMemo(() => {
    const map = new Map();
    for (const day of weekPlan) {
      for (const ingredient of day.missing_ingredients || []) {
        const key = normalizeName(ingredient);
        if (!map.has(key)) {
          map.set(key, { name: ingredient, days: [day.day] });
        } else {
          map.get(key).days.push(day.day);
        }
      }
    }
    return Array.from(map.values());
  }, [weekPlan]);

  const grouped = useMemo(() => {
    const g = {};
    for (const item of inventory) {
      const cat = item.category || "other";
      if (!g[cat]) g[cat] = [];
      g[cat].push(item);
    }
    return g;
  }, [inventory]);

  if (session === undefined) {
    return (
      <div style={{ background: COLORS.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Loader2 size={20} className="animate-spin" color={COLORS.fresh} />
      </div>
    );
  }

  if (!session) {
    return <AuthGate />;
  }

  const TABS = [
    { key: "pantry", label: "Pantry", icon: Package },
    { key: "week", label: "This week", icon: Calendar },
    { key: "list", label: "List", icon: ShoppingCart },
    { key: "chores", label: "Chores", icon: CheckSquare },
    { key: "budget", label: "Budget", icon: DollarSign },
  ];

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", fontFamily: "'Inter', sans-serif", color: COLORS.ink }}>
      <div className="lg:flex lg:min-h-screen">
        {/* Sidebar — desktop only */}
        <div
          className="hidden lg:flex lg:flex-col lg:w-56 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen lg:py-6 lg:px-4"
          style={{ borderRight: `0.5px solid ${COLORS.border}` }}
        >
          <div className="flex items-center gap-2 mb-8 px-2">
            <Package size={22} color={COLORS.fresh} />
            <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 20 }}>Larder</h1>
          </div>
          <nav className="flex flex-col gap-1 flex-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left"
                style={{
                  background: tab === t.key ? COLORS.fresh : "transparent",
                  color: tab === t.key ? "#fff" : COLORS.inkSoft,
                  fontWeight: 500,
                }}
              >
                <t.icon size={16} />
                {t.label}
              </button>
            ))}
          </nav>
          <button onClick={() => signOut()} className="px-3 py-2 text-left text-sm" style={{ color: COLORS.inkSoft }}>
            Sign out
          </button>
        </div>

        {/* Main content */}
        <div className="flex-1 lg:overflow-y-auto">
          <div className="max-w-md mx-auto px-4 pt-6 pb-24 lg:max-w-5xl lg:px-10 lg:py-8">
            <div className="flex items-center justify-between mb-1 lg:hidden">
              <div className="flex items-center gap-2">
                <Package size={22} color={COLORS.fresh} />
                <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 22 }}>Larder</h1>
              </div>
              <button onClick={() => signOut()} style={{ color: COLORS.inkSoft, fontSize: 12 }}>
                Sign out
              </button>
            </div>
            <p className="lg:hidden" style={{ color: COLORS.inkSoft, fontSize: 13, marginBottom: 20 }}>
              Snap what you have. Cook before it's gone.
            </p>

            <div className="hidden lg:block lg:mb-6">
              <h2 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 26 }}>
                {TABS.find((t) => t.key === tab)?.label}
              </h2>
            </div>

            {inventoryError && (
              <div className="rounded-lg p-3 mb-4 text-sm" style={{ background: COLORS.urgentBg, color: COLORS.urgent }}>
                {inventoryError}
              </div>
            )}

            <div className="flex gap-1 mb-5 p-1 rounded-lg lg:hidden" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm"
                  style={{
                    background: tab === t.key ? COLORS.fresh : "transparent",
                    color: tab === t.key ? "#fff" : COLORS.inkSoft,
                    fontWeight: 500,
                  }}
                >
                  <t.icon size={14} />
                  {t.label}
                </button>
              ))}
            </div>

        {tab === "pantry" && (
          <div className="lg:grid lg:grid-cols-[320px_1fr] lg:gap-8 lg:items-start">
            <div>
              <div
                className="rounded-xl p-5 mb-4 flex flex-col items-center text-center cursor-pointer"
                style={{ background: COLORS.surface, border: `1px dashed ${COLORS.border}` }}
                onClick={() => fileInputRef.current?.click()}
              >
                {preview ? (
                  <img src={preview} alt="Pantry preview" className="w-full h-32 object-cover rounded-lg mb-3" />
                ) : (
                  <Camera size={28} color={COLORS.fresh} style={{ marginBottom: 8 }} />
                )}
                <div style={{ fontWeight: 500, fontSize: 14 }}>
                  {scanning ? "Reading your photo..." : preview ? "Add another angle" : "Take a photo of your fridge or pantry"}
                </div>
                {!scanning && (
                  <div style={{ color: COLORS.inkSoft, fontSize: 12, marginTop: 2 }}>
                    Multiple photos merge into one list
                  </div>
                )}
                {scanning && <Loader2 size={16} className="animate-spin" style={{ marginTop: 8 }} color={COLORS.fresh} />}
                <input ref={fileInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhoto} />
              </div>

              {scanError && (
                <div className="rounded-lg p-3 mb-4 text-sm" style={{ background: COLORS.urgentBg, color: COLORS.urgent }}>
                  {scanError}
                </div>
              )}

              <div className="flex gap-2">
                <input
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addManualItem()}
                  placeholder="Add an item by hand"
                  className="flex-1 rounded-lg px-3 py-2 text-sm"
                  style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}
                />
                <button onClick={addManualItem} className="rounded-lg px-3 flex items-center justify-center" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
                  <Plus size={16} color={COLORS.fresh} />
                </button>
              </div>

              <button
                onClick={() => setShowManualForm((v) => !v)}
                className="flex items-center gap-1 mt-2 text-sm"
                style={{ color: COLORS.inkSoft }}
              >
                Fill manually {showManualForm ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {showManualForm && (
                <div className="rounded-lg p-3 mt-2" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
                  <div style={{ fontSize: 11, color: COLORS.inkSoft, marginBottom: 8 }}>
                    Item, quantity, and unit are required. Everything else is optional.
                  </div>
                  <input
                    value={manualFullName}
                    onChange={(e) => setManualFullName(e.target.value)}
                    placeholder="Item name *"
                    className="w-full rounded-lg px-3 py-2 text-sm mb-2"
                    style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                  />
                  <div className="flex gap-2 mb-2">
                    <input
                      value={manualQuantityAmount}
                      onChange={(e) => setManualQuantityAmount(e.target.value)}
                      type="number"
                      step="any"
                      placeholder="Quantity *"
                      className="flex-1 rounded-lg px-3 py-2 text-sm"
                      style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                    />
                    <select
                      value={manualQuantityUnit}
                      onChange={(e) => setManualQuantityUnit(e.target.value)}
                      className="rounded-lg px-2 py-2 text-sm"
                      style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                    >
                      <option value="pcs">pcs</option>
                      <option value="g">g</option>
                      <option value="kg">kg</option>
                      <option value="ml">ml</option>
                      <option value="l">l</option>
                    </select>
                  </div>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="date"
                      value={manualExpiryDate}
                      onChange={(e) => setManualExpiryDate(e.target.value)}
                      className="flex-1 rounded-lg px-3 py-2 text-sm"
                      style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                    />
                    <select
                      value={manualCategory}
                      onChange={(e) => setManualCategory(e.target.value)}
                      className="flex-1 rounded-lg px-2 py-2 text-sm"
                      style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                    >
                      {Object.keys(CATEGORY_DOTS).map((cat) => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  </div>
                  <input
                    value={manualNote}
                    onChange={(e) => setManualNote(e.target.value)}
                    placeholder="Note (optional)"
                    className="w-full rounded-lg px-3 py-2 text-sm mb-2"
                    style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                  />
                  <button
                    onClick={submitManualForm}
                    className="w-full rounded-lg py-2 text-sm"
                    style={{ background: COLORS.fresh, color: "#fff", fontWeight: 500 }}
                  >
                    Add item
                  </button>
                </div>
              )}

              <div className="mt-6">
                <input
                  value={dietary}
                  onChange={(e) => setDietary(e.target.value)}
                  placeholder="Dietary notes (optional) — e.g. vegetarian, no nuts"
                  className="w-full rounded-lg px-3 py-2 text-sm mb-2"
                  style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}
                />
                <button
                  onClick={planWeek}
                  disabled={inventory.length === 0 || planning}
                  className="w-full rounded-lg py-2.5 text-sm flex items-center justify-center gap-2"
                  style={{ background: inventory.length === 0 ? COLORS.border : COLORS.fresh, color: "#fff", fontWeight: 500 }}
                >
                  {planning ? <Loader2 size={15} className="animate-spin" /> : <Calendar size={15} />}
                  {planning ? "Planning your week..." : "Plan my week"}
                </button>
                {planError && <div style={{ color: COLORS.urgent, fontSize: 12, marginTop: 6 }}>{planError}</div>}
              </div>
            </div>

            <div>
              {loadingInventory && (
                <div className="flex items-center justify-center gap-2 py-6" style={{ color: COLORS.inkSoft, fontSize: 13 }}>
                  <Loader2 size={14} className="animate-spin" /> Loading your pantry...
                </div>
              )}

              {!loadingInventory && inventory.length === 0 && !scanning && (
                <div className="text-center py-6" style={{ color: COLORS.inkSoft, fontSize: 13 }}>
                  Nothing scanned yet. Take a photo, or add an item below.
                </div>
              )}

              <div className="lg:grid lg:grid-cols-2 lg:gap-x-6">
                {Object.entries(grouped).map(([cat, items]) => (
                  <div key={cat} className="mb-4">
                    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: COLORS.inkSoft, marginBottom: 6 }}>
                      {cat}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {items.map((item) => {
                        const tier = expiryTier(item.expiresInDays);
                        const tierBg = tier === "urgent" ? COLORS.urgentBg : tier === "soon" ? COLORS.soonBg : tier === "fresh" ? COLORS.freshBg : COLORS.surface;
                        const tierColor = tier === "urgent" ? COLORS.urgent : tier === "soon" ? COLORS.soon : tier === "fresh" ? COLORS.fresh : COLORS.inkSoft;
                        return (
                          <div
                            key={item.id}
                            className="relative flex items-center gap-1.5 pl-2 pr-1.5 py-1.5 rounded-lg"
                            style={{ background: tierBg, border: item.confidence === "low" ? `1px dashed ${tierColor}` : `0.5px solid ${COLORS.border}` }}
                            title={item.note || (item.confidence === "low" ? "Not certain — tap to confirm" : "")}
                          >
                            <span style={{ width: 6, height: 6, borderRadius: 999, background: CATEGORY_DOTS[cat] || CATEGORY_DOTS.other, flexShrink: 0 }} />
                            <input
                              value={item.name}
                              onChange={(e) => updateItemLocal(item.id, { name: e.target.value })}
                              onBlur={(e) => commitItem(item.id, { name: e.target.value })}
                              style={{ background: "transparent", fontSize: 13, fontWeight: 500, color: COLORS.ink, width: Math.max(item.name.length, 4) + "ch" }}
                            />
                            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: tierColor }}>
                              {item.quantityAmount != null ? `${item.quantityAmount} ${item.quantityUnit || ""}`.trim() : "—"}
                            </span>
                            {item.confidence === "low" && <AlertTriangle size={11} color={tierColor} />}
                            <button onClick={() => removeItem(item.id)} aria-label={`Remove ${item.name}`} style={{ color: COLORS.inkSoft }}>
                              <X size={12} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === "week" && (
          <div>
            <div className="flex gap-1 mb-4 p-1 rounded-lg inline-flex" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
              {[
                { key: "auto", label: "Auto plan" },
                { key: "browse", label: "Browse recipes" },
              ].map((v) => (
                <button
                  key={v.key}
                  onClick={() => setWeekView(v.key)}
                  className="px-4 py-1.5 rounded-md text-sm"
                  style={{
                    background: weekView === v.key ? COLORS.fresh : "transparent",
                    color: weekView === v.key ? "#fff" : COLORS.inkSoft,
                    fontWeight: 500,
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>

            {weekView === "auto" && (weekPlan.length === 0 ? (
              <div className="text-center py-10" style={{ color: COLORS.inkSoft, fontSize: 13 }}>
                No plan yet. Head to Pantry and tap "Plan my week."
              </div>
            ) : (
              <div className="flex flex-col gap-2 lg:grid lg:grid-cols-2 lg:gap-3">
                {weekPlan.map((day) => (
                  <div key={day.day} className="rounded-xl p-3" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
                    <div
                      className="flex items-center justify-between cursor-pointer"
                      onClick={() => setExpandedDay(expandedDay === day.day ? null : day.day)}
                    >
                      <div>
                        <div style={{ fontSize: 11, color: COLORS.inkSoft, textTransform: "uppercase", letterSpacing: 0.5 }}>{day.day}</div>
                        <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 15 }}>{day.recipe_name}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {day.expiry_priority && <Leaf size={14} color={COLORS.fresh} />}
                        {expandedDay === day.day ? <ChevronUp size={16} color={COLORS.inkSoft} /> : <ChevronDown size={16} color={COLORS.inkSoft} />}
                      </div>
                    </div>
                    {expandedDay === day.day && (
                      <div className="mt-2 pt-2" style={{ borderTop: `0.5px solid ${COLORS.border}` }}>
                        <p style={{ fontSize: 13, color: COLORS.inkSoft, marginBottom: 8 }}>{day.brief_instructions}</p>
                        {day.missing_ingredients?.length > 0 && (
                          <div style={{ fontSize: 12 }}>
                            <span style={{ color: COLORS.urgent, fontWeight: 500 }}>Missing: </span>
                            {day.missing_ingredients.join(", ")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}

            {weekView === "browse" && (
              <div>
                {recipesError && (
                  <div className="rounded-lg p-3 mb-4 text-sm" style={{ background: COLORS.urgentBg, color: COLORS.urgent }}>
                    {recipesError}
                  </div>
                )}

                <div className="flex gap-2 mb-4">
                  <input
                    value={recipeSearch}
                    onChange={(e) => setRecipeSearch(e.target.value)}
                    placeholder="Search recipes or ingredients — e.g. chicken, vegetarian"
                    className="flex-1 rounded-lg px-3 py-2 text-sm"
                    style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}
                  />
                  <button
                    onClick={openNewRecipe}
                    className="rounded-lg px-3 flex items-center gap-1 text-sm"
                    style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}`, color: COLORS.fresh, fontWeight: 500 }}
                  >
                    <Plus size={14} /> New
                  </button>
                </div>

                {selectedRecipeIds.size > 0 && (
                  <div className="rounded-lg p-3 mb-4" style={{ background: COLORS.freshBg }}>
                    <div className="flex items-center justify-between mb-2">
                      <span style={{ fontSize: 13, color: COLORS.fresh, fontWeight: 500 }}>
                        {selectedRecipeIds.size} recipe{selectedRecipeIds.size !== 1 ? "s" : ""} selected for this week
                      </span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setSelectedRecipeIds(new Set()); setGroceryListGenerated(false); }}
                          style={{ fontSize: 12, color: COLORS.inkSoft }}
                        >
                          Clear
                        </button>
                        <button
                          onClick={() => setGroceryListGenerated(true)}
                          className="rounded-lg px-3 py-1 text-sm"
                          style={{ background: COLORS.fresh, color: "#fff", fontWeight: 500 }}
                        >
                          Generate groceries list
                        </button>
                      </div>
                    </div>

                    {groceryListGenerated && (
                      <div className="mt-2 pt-2" style={{ borderTop: `0.5px solid ${COLORS.fresh}` }}>
                        {groceryResults.length === 0 ? (
                          <div style={{ fontSize: 12, color: COLORS.inkSoft }}>Selected recipes have no ingredients listed.</div>
                        ) : (
                          groceryResults.map((r) => (
                            <div key={r.name + r.unit} className="mb-2">
                              <div className="flex justify-between" style={{ fontSize: 12 }}>
                                <span style={{ textTransform: "capitalize" }}>{r.name}</span>
                                <span style={{ color: COLORS.inkSoft, fontFamily: "'IBM Plex Mono', monospace" }}>
                                  {r.availableBase.toFixed(0)} / {r.neededBase.toFixed(0)} {r.unit}
                                </span>
                              </div>
                              <div className="w-full rounded-full overflow-hidden" style={{ height: 6, background: "#fff" }}>
                                <div
                                  style={{
                                    width: `${r.percent}%`,
                                    height: "100%",
                                    background: r.percent >= 100 ? COLORS.fresh : r.percent > 0 ? COLORS.soon : COLORS.urgent,
                                  }}
                                />
                              </div>
                              {r.missingBase > 0 && (
                                <div style={{ fontSize: 11, color: COLORS.urgent, marginTop: 2 }}>
                                  Buy {r.missingBase.toFixed(0)} {r.unit} more
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}

                {editingRecipeId && (
                  <div className="rounded-xl p-3 mb-4 lg:max-w-lg" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
                    <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>
                      {editingRecipeId === "new" ? "New recipe" : "Edit recipe"}
                    </div>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Recipe name *"
                      className="w-full rounded-lg px-3 py-2 text-sm mb-2"
                      style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                    />
                    <input
                      value={editTags}
                      onChange={(e) => setEditTags(e.target.value)}
                      placeholder="Tags, comma separated — e.g. vegetarian, vegan"
                      className="w-full rounded-lg px-3 py-2 text-sm mb-2"
                      style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                    />
                    <div style={{ fontSize: 11, color: COLORS.inkSoft, marginBottom: 4 }}>Ingredients</div>
                    {editIngredients.map((ing) => (
                      <div key={ing.id} className="flex gap-2 mb-2">
                        <input
                          value={ing.name}
                          onChange={(e) => updateEditIngredient(ing.id, { name: e.target.value })}
                          placeholder="Ingredient"
                          className="flex-1 rounded-lg px-2 py-1.5 text-sm"
                          style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                        />
                        <input
                          value={ing.amount}
                          onChange={(e) => updateEditIngredient(ing.id, { amount: e.target.value })}
                          type="number"
                          step="any"
                          placeholder="Amt"
                          className="w-16 rounded-lg px-2 py-1.5 text-sm"
                          style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                        />
                        <select
                          value={ing.unit}
                          onChange={(e) => updateEditIngredient(ing.id, { unit: e.target.value })}
                          className="rounded-lg px-1 py-1.5 text-sm"
                          style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                        >
                          <option value="pcs">pcs</option>
                          <option value="g">g</option>
                          <option value="kg">kg</option>
                          <option value="ml">ml</option>
                          <option value="l">l</option>
                        </select>
                        <button onClick={() => removeEditIngredient(ing.id)} style={{ color: COLORS.inkSoft }}>
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <button onClick={addEditIngredient} className="text-sm mb-3" style={{ color: COLORS.fresh, fontWeight: 500 }}>
                      + Add ingredient
                    </button>
                    <textarea
                      value={editInstructions}
                      onChange={(e) => setEditInstructions(e.target.value)}
                      placeholder="Instructions"
                      rows={3}
                      className="w-full rounded-lg px-3 py-2 text-sm mb-3"
                      style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={closeEditRecipe}
                        className="flex-1 rounded-lg py-2 text-sm"
                        style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}`, color: COLORS.inkSoft }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={saveRecipe}
                        className="flex-1 rounded-lg py-2 text-sm"
                        style={{ background: COLORS.fresh, color: "#fff", fontWeight: 500 }}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}

                <div className="lg:grid lg:grid-cols-2 lg:gap-3">
                  {filteredRecipes.map((recipe) => (
                    <div
                      key={recipe.id}
                      className="rounded-xl p-3 mb-3"
                      style={{ background: COLORS.surface, border: `0.5px solid ${selectedRecipeIds.has(recipe.id) ? COLORS.fresh : COLORS.border}` }}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={selectedRecipeIds.has(recipe.id)}
                            onChange={() => toggleRecipeSelected(recipe.id)}
                            style={{ marginTop: 4 }}
                          />
                          <div>
                            <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 15 }}>{recipe.name}</div>
                            {recipe.tags?.length > 0 && (
                              <div style={{ fontSize: 11, color: COLORS.inkSoft }}>{recipe.tags.join(", ")}</div>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => openEditRecipe(recipe)} style={{ fontSize: 11, color: COLORS.fresh, fontWeight: 500 }}>
                            {recipe.household_id === null ? "Edit (fork)" : "Edit"}
                          </button>
                          {recipe.household_id !== null && (
                            <button onClick={() => removeRecipe(recipe)} style={{ color: COLORS.inkSoft }}>
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: COLORS.inkSoft, marginTop: 6 }}>
                        {(recipe.ingredients || []).map((ing) => `${ing.amount} ${ing.unit} ${ing.name}`).join(" · ")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "list" && (
          <div>
            {shoppingList.length === 0 ? (
              <div className="text-center py-10" style={{ color: COLORS.inkSoft, fontSize: 13 }}>
                Plan your week first, and your list will show up here.
              </div>
            ) : (
              <div
                className="rounded-lg p-4 lg:max-w-lg"
                style={{
                  background: COLORS.surface,
                  fontFamily: "'IBM Plex Mono', monospace",
                  border: `0.5px solid ${COLORS.border}`,
                  backgroundImage: `repeating-linear-gradient(90deg, transparent, transparent 8px, ${COLORS.bg} 8px, ${COLORS.bg} 9px)`,
                  backgroundPosition: "bottom",
                  backgroundSize: "16px 8px",
                  backgroundRepeat: "repeat-x",
                  paddingBottom: 16,
                }}
              >
                <div style={{ textAlign: "center", fontSize: 12, color: COLORS.inkSoft, marginBottom: 10, letterSpacing: 1 }}>
                  SHOPPING LIST
                </div>
                <div style={{ borderTop: `1px dashed ${COLORS.border}`, marginBottom: 8 }} />
                {shoppingList.map((entry, i) => (
                  <label key={i} className="flex items-start gap-2 py-1.5 cursor-pointer" style={{ fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={!!checked[entry.name]}
                      onChange={(e) => setChecked((prev) => ({ ...prev, [entry.name]: e.target.checked }))}
                      style={{ marginTop: 3 }}
                    />
                    <span style={{ flex: 1, textDecoration: checked[entry.name] ? "line-through" : "none", color: checked[entry.name] ? COLORS.inkSoft : COLORS.ink }}>
                      {entry.name}
                    </span>
                    <span style={{ fontSize: 10, color: COLORS.inkSoft }}>{entry.days.join(", ")}</span>
                  </label>
                ))}
                <div style={{ borderTop: `1px dashed ${COLORS.border}`, marginTop: 8, paddingTop: 8, fontSize: 11, color: COLORS.inkSoft, textAlign: "center" }}>
                  {shoppingList.length} item{shoppingList.length !== 1 ? "s" : ""}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "chores" && (
          <div>
            {choresError && (
              <div className="rounded-lg p-3 mb-4 text-sm" style={{ background: COLORS.urgentBg, color: COLORS.urgent }}>
                {choresError}
              </div>
            )}

            <div className="rounded-xl p-3 mb-4 lg:max-w-lg" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
              <input
                value={choreTitle}
                onChange={(e) => setChoreTitle(e.target.value)}
                placeholder="Chore title — e.g. Take out trash"
                className="w-full rounded-lg px-3 py-2 text-sm mb-2"
                style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
              />
              <div className="flex gap-2 mb-2">
                <select
                  value={choreAssignee}
                  onChange={(e) => setChoreAssignee(e.target.value)}
                  className="flex-1 rounded-lg px-2 py-2 text-sm"
                  style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                >
                  <option value="">Unassigned</option>
                  {householdMembers.map((m) => (
                    <option key={m.user_id} value={m.user_id}>{m.email}</option>
                  ))}
                </select>
                <select
                  value={choreRecurrence}
                  onChange={(e) => setChoreRecurrence(e.target.value)}
                  className="rounded-lg px-2 py-2 text-sm"
                  style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                >
                  <option value="none">One-time</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={choreDueDate}
                  onChange={(e) => setChoreDueDate(e.target.value)}
                  className="flex-1 rounded-lg px-3 py-2 text-sm"
                  style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                />
                <input
                  type="time"
                  value={choreDueTime}
                  onChange={(e) => setChoreDueTime(e.target.value)}
                  className="rounded-lg px-3 py-2 text-sm"
                  style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                />
                <button
                  onClick={addChore}
                  className="rounded-lg px-4 text-sm"
                  style={{ background: COLORS.fresh, color: "#fff", fontWeight: 500 }}
                >
                  Add
                </button>
              </div>
            </div>

            <div className="flex gap-1 mb-4 p-1 rounded-lg inline-flex" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
              {["list", "calendar"].map((v) => (
                <button
                  key={v}
                  onClick={() => setChoresView(v)}
                  className="px-4 py-1.5 rounded-md text-sm capitalize"
                  style={{
                    background: choresView === v ? COLORS.fresh : "transparent",
                    color: choresView === v ? "#fff" : COLORS.inkSoft,
                    fontWeight: 500,
                  }}
                >
                  {v}
                </button>
              ))}
            </div>

            {choresView === "calendar" && (
              <div className="rounded-xl p-3 mb-4 lg:max-w-2xl" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
                <div className="flex items-center justify-between mb-3">
                  <button
                    onClick={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                    style={{ color: COLORS.inkSoft }}
                  >
                    <ChevronDown size={16} style={{ transform: "rotate(90deg)" }} />
                  </button>
                  <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 15 }}>
                    {calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
                  </div>
                  <button
                    onClick={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                    style={{ color: COLORS.inkSoft }}
                  >
                    <ChevronDown size={16} style={{ transform: "rotate(-90deg)" }} />
                  </button>
                </div>
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                    <div key={i} style={{ fontSize: 10, textAlign: "center", color: COLORS.inkSoft }}>{d}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {buildCalendarGrid(calendarMonth).map((date, i) => {
                    if (!date) return <div key={i} />;
                    const key = toDateKey(date);
                    const dayChores = chores.filter((c) => c.due_date === key);
                    const isToday = key === toDateKey(new Date());
                    return (
                      <div
                        key={i}
                        className="rounded-md p-1"
                        style={{
                          minHeight: 56,
                          background: isToday ? COLORS.freshBg : COLORS.bg,
                          border: isToday ? `1px solid ${COLORS.fresh}` : `0.5px solid ${COLORS.border}`,
                        }}
                      >
                        <div style={{ fontSize: 10, color: COLORS.inkSoft, marginBottom: 2 }}>{date.getDate()}</div>
                        {dayChores.slice(0, 3).map((c) => (
                          <div
                            key={c.id}
                            onClick={() => toggleChore(c.id, c.done)}
                            className="cursor-pointer"
                            style={{
                              fontSize: 9,
                              lineHeight: 1.3,
                              marginBottom: 1,
                              color: c.done ? COLORS.inkSoft : COLORS.ink,
                              textDecoration: c.done ? "line-through" : "none",
                            }}
                            title={c.due_time ? `${c.title} at ${c.due_time}` : c.title}
                          >
                            {c.due_time ? c.due_time.slice(0, 5) + " " : ""}{c.title}
                          </div>
                        ))}
                        {dayChores.length > 3 && (
                          <div style={{ fontSize: 9, color: COLORS.inkSoft }}>+{dayChores.length - 3} more</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {choresView === "list" && (chores.length === 0 ? (
              <div className="text-center py-6" style={{ color: COLORS.inkSoft, fontSize: 13 }}>
                No chores yet. Add one above.
              </div>
            ) : (
              <div className="flex flex-col gap-2 lg:grid lg:grid-cols-2 lg:gap-3">
                {chores.map((chore) => {
                  const overdue = !chore.done && chore.due_date && new Date(chore.due_date) < new Date(new Date().toDateString());
                  return (
                    <div
                      key={chore.id}
                      className="flex items-center gap-2 rounded-lg p-3"
                      style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}
                    >
                      <button onClick={() => toggleChore(chore.id, chore.done)}>
                        {chore.done ? <CheckSquare size={18} color={COLORS.fresh} /> : <Square size={18} color={COLORS.inkSoft} />}
                      </button>
                      <div className="flex-1">
                        <div style={{
                          fontSize: 14,
                          fontWeight: 500,
                          textDecoration: chore.done ? "line-through" : "none",
                          color: chore.done ? COLORS.inkSoft : COLORS.ink,
                        }}>
                          {chore.title}
                        </div>
                        <div style={{ fontSize: 11, color: overdue ? COLORS.urgent : COLORS.inkSoft }}>
                          {memberLabel(chore.assigned_to)}
                          {chore.due_date ? ` · due ${chore.due_date}${chore.due_time ? ` ${chore.due_time.slice(0, 5)}` : ""}${overdue ? " (overdue)" : ""}` : ""}
                          {chore.recurrence !== "none" ? ` · ${chore.recurrence}` : ""}
                        </div>
                      </div>
                      <button onClick={() => removeChore(chore.id)} style={{ color: COLORS.inkSoft }}>
                        <X size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {tab === "budget" && (
          <div>
            {budgetError && (
              <div className="rounded-lg p-3 mb-4 text-sm" style={{ background: COLORS.urgentBg, color: COLORS.urgent }}>
                {budgetError}
              </div>
            )}

            <div className="rounded-xl p-4 mb-4 lg:max-w-2xl" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
              <div className="flex items-center justify-between mb-3">
                <div style={{ fontSize: 13, fontWeight: 500 }}>Household finances</div>
                {budgetHealth.status !== "unset" && (
                  <span
                    className="px-2 py-0.5 rounded-full text-xs"
                    style={{
                      background: budgetHealth.status === "healthy" ? COLORS.freshBg : budgetHealth.status === "caution" ? COLORS.soonBg : COLORS.urgentBg,
                      color: budgetHealth.status === "healthy" ? COLORS.fresh : budgetHealth.status === "caution" ? COLORS.soon : COLORS.urgent,
                      fontWeight: 500,
                    }}
                  >
                    {budgetHealth.status === "healthy" ? "Healthy" : budgetHealth.status === "caution" ? "Caution" : "Needs attention"}
                  </span>
                )}
              </div>

              {budgetHealth.status === "unset" ? (
                <div style={{ fontSize: 12, color: COLORS.inkSoft, marginBottom: 10 }}>
                  Set a monthly income below to see a financial health check.
                </div>
              ) : (
                <div className="mb-3 flex flex-col gap-2">
                  {budgetHealth.checks.map((c) => (
                    <div key={c.key} className="flex items-start gap-2">
                      {c.pass ? <CheckSquare size={14} color={COLORS.fresh} style={{ marginTop: 1 }} /> : <AlertTriangle size={14} color={COLORS.urgent} style={{ marginTop: 1 }} />}
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500, color: c.pass ? COLORS.ink : COLORS.urgent }}>{c.label}</div>
                        <div style={{ fontSize: 11, color: COLORS.inkSoft }}>{c.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <div style={{ fontSize: 11, color: COLORS.inkSoft, marginBottom: 4 }}>Monthly income</div>
                  <input
                    value={incomeInput}
                    onChange={(e) => setIncomeInput(e.target.value)}
                    type="number"
                    step="0.01"
                    placeholder="e.g. 5000"
                    className="w-full rounded-lg px-3 py-2 text-sm"
                    style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: COLORS.inkSoft, marginBottom: 4 }}>Savings goal %</div>
                  <input
                    value={savingsGoalInput}
                    onChange={(e) => setSavingsGoalInput(e.target.value)}
                    type="number"
                    step="1"
                    className="w-full rounded-lg px-3 py-2 text-sm"
                    style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: COLORS.inkSoft, marginBottom: 4 }}>Monthly debt payments</div>
                  <input
                    value={debtInput}
                    onChange={(e) => setDebtInput(e.target.value)}
                    type="number"
                    step="0.01"
                    placeholder="e.g. 500"
                    className="w-full rounded-lg px-3 py-2 text-sm"
                    style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: COLORS.inkSoft, marginBottom: 4 }}>Emergency fund balance</div>
                  <input
                    value={emergencyFundInput}
                    onChange={(e) => setEmergencyFundInput(e.target.value)}
                    type="number"
                    step="0.01"
                    placeholder="e.g. 3000"
                    className="w-full rounded-lg px-3 py-2 text-sm"
                    style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: COLORS.inkSoft, marginBottom: 4 }}>Emergency fund target (months)</div>
                  <input
                    value={emergencyMonthsInput}
                    onChange={(e) => setEmergencyMonthsInput(e.target.value)}
                    type="number"
                    step="1"
                    className="w-full rounded-lg px-3 py-2 text-sm"
                    style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                  />
                </div>
                <div className="flex items-end">
                  <button
                    onClick={saveBudgetSettings}
                    disabled={savingBudget}
                    className="w-full rounded-lg px-4 py-2 text-sm"
                    style={{ background: COLORS.fresh, color: "#fff", fontWeight: 500 }}
                  >
                    {savingBudget ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>

              {monthlyTotals.length > 1 && (
                <div className="mt-4 pt-4" style={{ borderTop: `0.5px solid ${COLORS.border}` }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: COLORS.inkSoft, marginBottom: 8 }}>
                    Spend trend
                  </div>
                  <div className="flex items-end gap-2" style={{ height: 60 }}>
                    {[...monthlyTotals].reverse().slice(-6).map(([month, total]) => {
                      const max = Math.max(...monthlyTotals.map(([, t]) => t), 1);
                      return (
                        <div key={month} className="flex-1 flex flex-col items-center justify-end h-full">
                          <div
                            style={{
                              width: "100%",
                              height: `${Math.max((total / max) * 100, 4)}%`,
                              background: COLORS.fresh,
                              borderRadius: 3,
                            }}
                            title={`${month}: $${total.toFixed(2)}`}
                          />
                          <div style={{ fontSize: 9, color: COLORS.inkSoft, marginTop: 3 }}>{month.slice(5)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {!reviewItems && (
              <div
                className="rounded-xl p-5 mb-4 flex flex-col items-center text-center cursor-pointer lg:max-w-lg"
                style={{ background: COLORS.surface, border: `1px dashed ${COLORS.border}` }}
                onClick={() => receiptInputRef.current?.click()}
              >
                <DollarSign size={28} color={COLORS.fresh} style={{ marginBottom: 8 }} />
                <div style={{ fontWeight: 500, fontSize: 14 }}>
                  {ocrRunning ? "Reading your receipt..." : "Scan a receipt"}
                </div>
                <div style={{ color: COLORS.inkSoft, fontSize: 12, marginTop: 2 }}>
                  We'll pre-fill items — you confirm before it saves. Receipt OCR is far from perfect, so double-check the list.
                </div>
                {ocrRunning && <Loader2 size={16} className="animate-spin" style={{ marginTop: 8 }} color={COLORS.fresh} />}
                <input ref={receiptInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleReceiptPhoto} />
              </div>
            )}

            {reviewItems && (
              <div className="rounded-xl p-3 mb-4 lg:max-w-lg" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>
                  Review before saving {reviewItems.length === 0 && "— nothing detected automatically, add lines by hand"}
                </div>
                {reviewItems.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 mb-2">
                    <input
                      value={item.name}
                      onChange={(e) => updateReviewItem(item.id, { name: e.target.value })}
                      placeholder="Item name"
                      className="flex-1 rounded-lg px-2 py-1.5 text-sm"
                      style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                    />
                    <input
                      value={item.price}
                      onChange={(e) => updateReviewItem(item.id, { price: e.target.value })}
                      type="number"
                      step="0.01"
                      className="w-20 rounded-lg px-2 py-1.5 text-sm"
                      style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}`, fontFamily: "'IBM Plex Mono', monospace" }}
                    />
                    <button onClick={() => removeReviewItem(item.id)} style={{ color: COLORS.inkSoft }}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button onClick={addReviewItem} className="text-sm mb-3" style={{ color: COLORS.fresh, fontWeight: 500 }}>
                  + Add line
                </button>
                <div className="flex items-center justify-between mb-3">
                  <input
                    type="date"
                    value={reviewDate}
                    onChange={(e) => setReviewDate(e.target.value)}
                    className="rounded-lg px-2 py-1.5 text-sm"
                    style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}` }}
                  />
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 500 }}>
                    Total: ${reviewTotal.toFixed(2)}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={cancelReview}
                    className="flex-1 rounded-lg py-2 text-sm"
                    style={{ background: COLORS.bg, border: `0.5px solid ${COLORS.border}`, color: COLORS.inkSoft }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmSaveReceipt}
                    className="flex-1 rounded-lg py-2 text-sm"
                    style={{ background: COLORS.fresh, color: "#fff", fontWeight: 500 }}
                  >
                    Save receipt
                  </button>
                </div>
              </div>
            )}

            {monthlyTotals.length > 0 && (
              <div className="mb-4">
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: COLORS.inkSoft, marginBottom: 6 }}>
                  Spend by month
                </div>
                {monthlyTotals.map(([month, total]) => (
                  <div key={month} className="flex items-center justify-between py-1.5" style={{ fontSize: 13 }}>
                    <span>{month}</span>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>${total.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}

            {receipts.length === 0 ? (
              <div className="text-center py-6" style={{ color: COLORS.inkSoft, fontSize: 13 }}>
                No receipts yet. Scan one above.
              </div>
            ) : (
              <div className="flex flex-col gap-2 lg:grid lg:grid-cols-2 lg:gap-3">
                {receipts.map((r) => (
                  <div key={r.id} className="rounded-lg p-3" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
                    <div className="flex items-center justify-between">
                      <span style={{ fontSize: 12, color: COLORS.inkSoft }}>{r.purchased_at}</span>
                      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 500 }}>
                        ${Number(r.total_spend).toFixed(2)}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.inkSoft, marginTop: 2 }}>
                      {(r.parsed_items || []).map((it) => it.name).join(", ") || "No line items recorded"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
          </div>
        </div>
      </div>
    </div>
  );
}
