# AETHOL demo store

Demo e-commerce storefront with the clothing-rack effect. Static site: `index.html` + `img/`.
Pushing to `main` redeploys https://aetholdemo.netlify.app

Deploys automatically on every push to `main`.

## On model (AI try-on)
- `scripts/tryon/run.mjs` — the robot. Creates the two studio models if missing (`tryon/models/woman.*`, `man.*`), then makes a front and back photo of the model wearing every garment in `img/`. Back views use `img/<id>-back.webp` when it exists, otherwise they are AI-imagined.
- `.github/workflows/tryon.yml` — runs the robot on GitHub when garment photos or the product list change, daily, or on demand (Actions → "Dress the models" → Run workflow). Needs the repo secret `GEMINI_API_KEY`; optional repo variable `GEMINI_IMAGE_MODEL`.
- `tryon/tryon.json` — the list the site reads; the "On model" button appears for every garment listed there.
- To use your own model photos, drop `woman.png` / `man.png` (or .jpg/.webp) into `tryon/models/`; the robot remakes all photos with them.
