# EastGenesis watercolor character runtime assets

Only transparent, QC-approved PNG files belong in this directory. A file is not used by the Office runtime until its canonical filename is added to `VERIFIED_WATERCOLOR_CHARACTER_FILES` in `watercolor-character-assets.ts`.

Opaque paper-background production masters remain under `output/imagegen/caogen-watercolor-v1/` and must never be registered here.

Before producing or installing assets, run `npm run test:watercolor-production-preflight`. The canonical chroma-background edit prompt is `docs/visual-prompts/runtime-transparent-derivative-v01.prompt.txt`; structurally valid candidates still require light/dark edge review before registration.

Generate deterministic review sheets with `npm run generate:watercolor-qc -- --source <candidate-dir> --out-dir output/imagegen/caogen-watercolor-v1/qc --force`. Final approval requires the same 49 input digests to pass the light, dark, 96px grayscale, and 48px grayscale reviews; use `--required` for that final run.
