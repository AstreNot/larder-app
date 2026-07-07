import React, { useState, useMemo, useRef, useEffect } from "react";
import { Camera, Plus, X, Leaf, AlertTriangle, ShoppingCart, Calendar, Package, ChevronDown, ChevronUp, Loader2, CheckSquare, Square, DollarSign } from "lucide-react";
import {
  getSession,
  onAuthChange,
  signIn,
  signUp,
  signOut,
  getOrCreateDefaultHousehold,
  getInventory,
  upsertInventoryItems,
  addManualInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  getHouseholdMembers,
  getChores,
  createChore,
  toggleChoreDone,
  deleteChore,
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

function normalizeName(name) {
  return (name || "").trim().toLowerCase();
}

// Converts a Supabase inventory_items row into the shape the UI uses.
function rowToItem(row) {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity ?? "unknown",
    category: row.category || "other",
    confidence: row.confidence || "medium",
    expiresInDays: row.expires_in_days ?? null,
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
  const fileInputRef = useRef(null);

  const [chores, setChores] = useState([]);
  const [householdMembers, setHouseholdMembers] = useState([]);
  const [choresError, setChoresError] = useState(null);
  const [choreTitle, setChoreTitle] = useState("");
  const [choreAssignee, setChoreAssignee] = useState("");
  const [choreDueDate, setChoreDueDate] = useState("");
  const [choreRecurrence, setChoreRecurrence] = useState("none");

  const [receipts, setReceipts] = useState([]);
  const [budgetError, setBudgetError] = useState(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [reviewItems, setReviewItems] = useState(null); // null = no review in progress
  const [reviewRawText, setReviewRawText] = useState("");
  const [reviewDate, setReviewDate] = useState("");
  const receiptInputRef = useRef(null);

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

        const [choreRows, members, receiptRows] = await Promise.all([
          getChores(hid),
          getHouseholdMembers(hid),
          getReceipts(hid),
        ]);
        if (cancelled) return;
        setChores(choreRows);
        setHouseholdMembers(members);
        setReceipts(receiptRows);
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
      const row = await addManualInventoryItem(householdId, name);
      setInventory((prev) => {
        const byName = new Map(prev.map((it) => [normalizeName(it.name), it]));
        byName.set(normalizeName(row.name), rowToItem(row));
        return Array.from(byName.values());
      });
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
        recurrence: choreRecurrence,
      });
      setChores((prev) => [...prev, chore]);
      setChoreTitle("");
      setChoreDueDate("");
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

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", fontFamily: "'Inter', sans-serif", color: COLORS.ink }}>
      <div className="max-w-md mx-auto px-4 pt-6 pb-24">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Package size={22} color={COLORS.fresh} />
            <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 22 }}>Larder</h1>
          </div>
          <button onClick={() => signOut()} style={{ color: COLORS.inkSoft, fontSize: 12 }}>
            Sign out
          </button>
        </div>
        <p style={{ color: COLORS.inkSoft, fontSize: 13, marginBottom: 20 }}>
          Snap what you have. Cook before it's gone.
        </p>

        {inventoryError && (
          <div className="rounded-lg p-3 mb-4 text-sm" style={{ background: COLORS.urgentBg, color: COLORS.urgent }}>
            {inventoryError}
          </div>
        )}

        <div className="flex gap-1 mb-5 p-1 rounded-lg" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
          {[
            { key: "pantry", label: "Pantry", icon: Package },
            { key: "week", label: "This week", icon: Calendar },
            { key: "list", label: "List", icon: ShoppingCart },
            { key: "chores", label: "Chores", icon: CheckSquare },
            { key: "budget", label: "Budget", icon: DollarSign },
          ].map((t) => (
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
                          {item.quantity}
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

            <div className="flex gap-2 mt-4">
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
        )}

        {tab === "week" && (
          <div>
            {weekPlan.length === 0 ? (
              <div className="text-center py-10" style={{ color: COLORS.inkSoft, fontSize: 13 }}>
                No plan yet. Head to Pantry and tap "Plan my week."
              </div>
            ) : (
              <div className="flex flex-col gap-2">
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
                className="rounded-lg p-4"
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

            <div className="rounded-xl p-3 mb-4" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
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
                <button
                  onClick={addChore}
                  className="rounded-lg px-4 text-sm"
                  style={{ background: COLORS.fresh, color: "#fff", fontWeight: 500 }}
                >
                  Add
                </button>
              </div>
            </div>

            {chores.length === 0 ? (
              <div className="text-center py-6" style={{ color: COLORS.inkSoft, fontSize: 13 }}>
                No chores yet. Add one above.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
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
                          {chore.due_date ? ` · due ${chore.due_date}${overdue ? " (overdue)" : ""}` : ""}
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
            )}
          </div>
        )}

        {tab === "budget" && (
          <div>
            {budgetError && (
              <div className="rounded-lg p-3 mb-4 text-sm" style={{ background: COLORS.urgentBg, color: COLORS.urgent }}>
                {budgetError}
              </div>
            )}

            {!reviewItems && (
              <div
                className="rounded-xl p-5 mb-4 flex flex-col items-center text-center cursor-pointer"
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
              <div className="rounded-xl p-3 mb-4" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
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
              <div className="flex flex-col gap-2">
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
  );
}
