import base64
import io
import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from PIL import Image
from ultralytics import YOLO

# NOTE: yolov8n.pt is the pretrained nano model trained on COCO's 80 classes.
# Only a handful of those classes are food-related — see FOOD_CLASS_INFO below.
# If you have time later, swapping in a fine-tuned grocery/fridge model (check
# Roboflow Universe for something pretrained on pantry items) would give far
# better real-world coverage. This is the guaranteed-to-work fallback.
MODEL_PATH = os.environ.get("MODEL_PATH", "yolov8n.pt")
SHARED_SECRET = os.environ.get("SHARED_SECRET")  # required — protects your public tunnel URL

model = YOLO(MODEL_PATH)

app = FastAPI()

# class_name: (category, typical_shelf_life_days). Only these classes are returned —
# everything else COCO can detect (people, furniture, vehicles, utensils) is filtered out.
FOOD_CLASS_INFO = {
    "banana": ("produce", 5),
    "apple": ("produce", 14),
    "orange": ("produce", 14),
    "sandwich": ("other", 2),
    "broccoli": ("produce", 5),
    "carrot": ("produce", 21),
    "hot dog": ("meat", 5),
    "pizza": ("other", 3),
    "donut": ("pantry", 4),
    "cake": ("pantry", 5),
    "bottle": ("beverage", None),
}


def confidence_bucket(conf: float) -> str:
    if conf >= 0.7:
        return "high"
    if conf >= 0.4:
        return "medium"
    return "low"


class DetectRequest(BaseModel):
    image_base64: str
    media_type: str = "image/jpeg"


@app.post("/detect")
def detect(req: DetectRequest, x_shared_secret: str = Header(default=None)):
    if not SHARED_SECRET or x_shared_secret != SHARED_SECRET:
        raise HTTPException(status_code=401, detail="Missing or invalid shared secret")

    try:
        image_bytes = base64.b64decode(req.image_base64)
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not decode image: {e}")

    results = model.predict(image, verbose=False)

    # Aggregate detections by class name: count boxes, track the highest confidence seen.
    aggregated = {}
    for result in results:
        for box in result.boxes:
            class_name = model.names[int(box.cls[0])]
            if class_name not in FOOD_CLASS_INFO:
                continue
            conf = float(box.conf[0])
            if class_name not in aggregated:
                aggregated[class_name] = {"count": 0, "max_conf": 0.0}
            aggregated[class_name]["count"] += 1
            aggregated[class_name]["max_conf"] = max(aggregated[class_name]["max_conf"], conf)

    items = []
    for class_name, info in aggregated.items():
        category, shelf_life = FOOD_CLASS_INFO[class_name]
        items.append(
            {
                "name": class_name,
                "quantity_estimate": str(info["count"]),
                "category": category,
                "confidence": confidence_bucket(info["max_conf"]),
                "expires_in_days": shelf_life,
                "note": None,
            }
        )

    return {"items": items}


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_PATH}
