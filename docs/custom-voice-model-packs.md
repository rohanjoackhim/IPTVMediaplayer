# Custom Voice Model Packs

Player runs finished TTS models locally. Training and fine-tuning should happen outside the app, then the exported voice is imported as a model pack.

## Pack Layout

```text
voice-name.smart-voice/
  manifest.json
  model.onnx
  piper.onnx.json
  voice.bin
  tokenizer.json
  README.md
  LICENSE.txt
```

`manifest.json` should contain:

```json
{
  "schemaVersion": 1,
  "engine": "piper-vits",
  "id": "creator.voice-name.v1",
  "displayName": "Voice Name",
  "language": "en-US",
  "accent": "American",
  "gender": "female",
  "sampleRate": 24000,
  "recommendedSpeed": 0.92,
  "license": "Custom license or SPDX id",
  "consent": "Voice owner explicitly approved this model for TTS use."
}
```

## Training Workflow

1. Collect legally usable recordings and matching transcripts from a consenting speaker.
2. Clean the audio into short clips with consistent volume, low background noise, and accurate text.
3. Fine-tune a model compatible with the app runtime, then export it to ONNX.
4. Validate speech quality, pronunciation, speed, and consent/license metadata.
5. Package the model files and manifest together for app import.

For the first trainable path, use Piper/VITS and LJSpeech as described in `docs/ljspeech-piper-cloud-training.md`. Kokoro remains the built-in neural runtime, while Piper custom voice import is the recommended next provider for trained voice packs.

## Piper Runtime

Piper/VITS packs run beside the built-in Kokoro runtime. The app looks for a Piper executable in this order:

1. `PIPER_BINARY_PATH`
2. `resources/piper/piper` in a packaged app
3. `electron/piper/piper` during development
4. `piper/piper` from the project root
5. `piper` on `PATH`

Install voice packs under the app user-data `voice-packs` directory. Each pack must be a folder that contains `manifest.json`, `model.onnx`, and `piper.onnx.json`. When a valid Piper runtime and at least one valid pack are available, Piper voices appear before Kokoro voices and are used automatically for ebook read-aloud.

## App Import Rules

- Reject packs without a manifest, license, or consent statement.
- Reject unsupported engines until their runtime is implemented.
- Store imported packs under the app user-data directory, not inside IndexedDB.
- Add imported voices to the same neural voice list as bundled Kokoro voices.
- Keep Kokoro available as the built-in fallback when a Piper custom model fails to load.

Do not clone or imitate a real person without explicit permission from that person or the legal rights holder.
