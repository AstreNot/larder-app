import React, { useState, useMemo, useRef } from "react";
import { Camera, Plus, X, Leaf, AlertTriangle, ShoppingCart, Calendar, Package, ChevronDown, ChevronUp, Loader2 } from "lucide-react";

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

let idCounter = 1;
function nextId() {
  return "itm_" + idCounter++;
}

export default function App() {
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

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
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

      setInventory((prev) => {
        const byName = new Map(prev.map((it) => [normalizeName(it.name), it]));
        for (const item of parsed.items || []) {
          byName.set(normalizeName(item.name), {
            id: byName.get(normalizeName(item.name))?.id || nextId(),
            name: item.name,
            quantity: item.quantity_estimate,
            category: item.category || "other",
            confidence: item.confidence || "medium",
            expiresInDays: item.expires_in_days ?? null,
            note: item.note || null,
          });
        }
        return Array.from(byName.values());
      });
    } catch (err) {
      setScanError(err.message || "Couldn't read that photo. Try again with better lighting, or add items manually below.");
    } finally {
      setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const updateItem = (id, patch) => {
    setInventory((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  const removeItem = (id) => {
    setInventory((prev) => prev.filter((it) => it.id !== id));
  };

  const addManualItem = () => {
    const name = manualName.trim();
    if (!name) return;
    setInventory((prev) => [
      ...prev,
      { id: nextId(), name, quantity: "unknown", category: "other", confidence: "high", expiresInDays: null, note: null },
    ]);
    setManualName("");
  };

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

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", fontFamily: "'Inter', sans-serif", color: COLORS.ink }}>
      <div className="max-w-md mx-auto px-4 pt-6 pb-24">
        <div className="flex items-center gap-2 mb-1">
          <Package size={22} color={COLORS.fresh} />
          <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 22 }}>Larder</h1>
        </div>
        <p style={{ color: COLORS.inkSoft, fontSize: 13, marginBottom: 20 }}>
          Snap what you have. Cook before it's gone.
        </p>

        <div className="flex gap-1 mb-5 p-1 rounded-lg" style={{ background: COLORS.surface, border: `0.5px solid ${COLORS.border}` }}>
          {[
            { key: "pantry", label: "Pantry", icon: Package },
            { key: "week", label: "This week", icon: Calendar },
            { key: "list", label: "List", icon: ShoppingCart },
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

            {inventory.length === 0 && !scanning && (
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
                          onChange={(e) => updateItem(item.id, { name: e.target.value })}
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
      </div>
    </div>
  );
}
