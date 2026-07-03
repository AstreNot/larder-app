# Larder vision server (runs on your office VM)

This replaces the vision-LLM API call with a locally-hosted YOLOv8 model, so photo scanning costs zero API tokens and can't hit a rate limit.

## Honest scope limitation, read this first

Pretrained YOLOv8 (`yolov8n.pt`) only knows COCO's 80 general-purpose object classes. Of those, only 11 are food-related: banana, apple, orange, broccoli, carrot, hot dog, pizza, donut, cake, sandwich, bottle. It will not recognize milk, eggs, spices, packaged goods, or most pantry staples — it can only count what's in that list.

This means your live demo's CV step will really only "see" fruit, a few vegetables, and a handful of common takeout-style foods. The rest of a real pantry (dairy, spices, grains) simply won't be detected by this model. Two ways to handle this honestly in your pitch:
- Frame it as intentional: the CV step catches perishables (produce especially), and the shopping list naturally surfaces staples (rice, spices, bread, cheese) that aren't usually worth photographing anyway, since your recipe data can reference them as ingredients even when they're not detected.
- Or, if you have an hour to spare, search Roboflow Universe for a pretrained model fine-tuned on groceries or fridge contents — I can't verify what's currently available there since I don't have live web access in this conversation, so treat that as something to check yourself rather than something I've confirmed exists.

## 1. Install dependencies on the VM

Requires Python 3.10+.

```bash
cd yolo-server
python -m venv venv
source venv/bin/activate   # on Windows: venv\Scripts\activate
pip install -r requirements.txt
```

If any package version in `requirements.txt` fails to install (package versions age quickly), drop the version pins and run `pip install ultralytics fastapi "uvicorn[standard]" pillow pydantic` instead to get current compatible versions.

The first time you run the server, `ultralytics` will auto-download `yolov8n.pt` (~6MB) — make sure the VM has outbound internet access for that one-time download.

## 2. Set your shared secret

This server will be reachable from the public internet once tunneled (see step 4), so it needs a shared secret to stop random visitors from using your VM's compute:

```bash
export SHARED_SECRET="pick-a-long-random-string-here"
```

(On Windows PowerShell: `$env:SHARED_SECRET="pick-a-long-random-string-here"`)

You'll use this same value on the Vercel side.

## 3. Run the server

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

Test it's alive: `curl http://localhost:8000/health` should return `{"status":"ok",...}`.

## 4. Expose it to the internet

Vercel's serverless functions need a public URL to reach your VM. Since you're on an office VM, I genuinely don't know your network's firewall policy or whether IT allows this — check with whoever manages that network before relying on it for your deadline. A tunnel avoids needing a static IP or opening inbound firewall ports yourself:

**Cloudflare Tunnel (recommended, free, no account required for a quick tunnel):**
```bash
cloudflared tunnel --url http://localhost:8000
```
This prints a public `https://xxxx.trycloudflare.com` URL. It's ephemeral — if you restart the tunnel, you get a new URL and need to update it in Vercel.

**ngrok (alternative):**
```bash
ngrok http 8000
```
Also gives a temporary public URL on the free tier, same caveat about it changing on restart.

Either way, copy the resulting HTTPS URL — you'll set it as `YOLO_SERVER_URL` in Vercel (with `/detect` appended, e.g. `https://xxxx.trycloudflare.com/detect`).

## 5. Set Vercel environment variables

In your Vercel project settings, add:
- `YOLO_SERVER_URL` — your tunnel URL plus `/detect`
- `YOLO_SHARED_SECRET` — the same string you set as `SHARED_SECRET` on the VM

## A few things I can't verify from here

- **Inference speed on your specific VM hardware** — YOLOv8n is lightweight and should run reasonably on CPU with 8GB RAM, but I have no way to benchmark your actual machine. Time a real request before your demo so you know what latency to expect.
- **Whether your office network allows outbound tunnel connections** — some corporate networks block this. Test it early, not the night before.
- **Tunnel URL stability** — free tunnels can drop or rotate. If your demo needs to survive a VM reboot mid-event, consider keeping a terminal window open and visible so you can restart the tunnel and update the Vercel env var quickly if needed.
