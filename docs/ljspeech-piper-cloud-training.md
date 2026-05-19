# LJSpeech Neural TTS Cloud Training

This guide trains a first custom voice from the LJSpeech dataset outside Player, then exports it as an offline voice pack candidate for the app.

## Recommended First Target

Use Piper/VITS first.

Reasons:

- Piper is designed for small offline CPU voices.
- Piper training supports LJSpeech-style datasets.
- Piper exports `.onnx` plus `.onnx.json`, which matches the app's future voice-pack direction.
- Kokoro custom voice training is still more experimental and does not yet have the same clean custom ONNX export path for this app.

## Cloud Machine

Use an Ubuntu GPU instance:

- NVIDIA GPU with at least 12 GB VRAM.
- 80 GB or more disk.
- Python 3.10 or 3.11.
- CUDA-enabled PyTorch.

Good starter sizes are an RTX 3090/4090, A10, A100, or similar. CPU-only training is not recommended.

## Dataset

LJSpeech:

- Single speaker, English.
- About 24 hours of audio.
- Public dataset for research and model training experiments.
- Voice outcome will sound like LJSpeech, not a custom personal voice.

Expected layout:

```text
LJSpeech-1.1/
  metadata.csv
  wavs/
    LJ001-0001.wav
    LJ001-0002.wav
```

## Training Steps

Run this on the cloud GPU machine, not inside the Electron app.

```bash
sudo apt-get update
sudo apt-get install -y git python3-dev python3-venv espeak-ng build-essential

git clone https://github.com/rhasspy/piper.git
cd piper/src/python

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip wheel setuptools
pip install -e .
```

Download LJSpeech:

```bash
mkdir -p ~/datasets
cd ~/datasets
wget https://data.keithito.com/data/speech/LJSpeech-1.1.tar.bz2
tar -xjf LJSpeech-1.1.tar.bz2
```

Preprocess for Piper:

```bash
cd ~/piper/src/python
source .venv/bin/activate

python3 -m piper_train.preprocess \
  --language en-us \
  --input-dir ~/datasets/LJSpeech-1.1 \
  --output-dir ~/piper-training/ljspeech \
  --dataset-format ljspeech \
  --single-speaker \
  --sample-rate 22050
```

Train or fine-tune:

```bash
python3 -m piper_train \
  --dataset-dir ~/piper-training/ljspeech \
  --accelerator gpu \
  --devices 1 \
  --batch-size 16 \
  --validation-split 0.01 \
  --num-test-examples 10 \
  --max_epochs 10000 \
  --checkpoint-epochs 1 \
  --precision 16
```

If memory is too high, reduce `--batch-size` to `8` or `4`.

## Export

After training, export the best checkpoint:

```bash
python3 -m piper_train.export_onnx \
  ~/piper-training/ljspeech/lightning_logs/version_0/checkpoints/best.ckpt \
  ~/piper-training/ljspeech-lj.onnx
```

Copy the generated or matching config JSON beside the ONNX file:

```text
ljspeech-lj.onnx
ljspeech-lj.onnx.json
```

## Player Voice Pack

Package the trained Piper voice as:

```text
ljspeech-lj.smart-voice/
  manifest.json
  piper.onnx
  piper.onnx.json
  README.md
  LICENSE.txt
```

Example `manifest.json`:

```json
{
  "schemaVersion": 1,
  "engine": "piper-vits",
  "id": "ljspeech.lj.v1",
  "displayName": "LJSpeech LJ",
  "language": "en-US",
  "accent": "American",
  "gender": "female",
  "sampleRate": 22050,
  "recommendedSpeed": 1,
  "license": "LJSpeech dataset license plus model training notes",
  "consent": "Dataset voice is public LJSpeech data; do not represent this as a private cloned voice."
}
```

## App Integration Status

Current Player neural TTS uses bundled Kokoro via `kokoro-js`.

To use this trained Piper voice in the app, the next implementation step is to add a `piper-vits` runtime/provider that can:

- Import `.smart-voice` folders.
- Validate `manifest.json`.
- Run Piper ONNX inference locally.
- Add imported voices to the ebook TTS voice selector.
- Keep Kokoro and system TTS as fallbacks.

## Quality Notes

- LJSpeech training creates an audiobook-style single-speaker voice.
- More epochs are not always better; listen to checkpoints.
- Bad alignment or noisy clips cause robotic pronunciation.
- Fine-tuning from a pretrained Piper checkpoint is usually faster than training from scratch.
- Keep validation samples and compare before exporting a voice pack.
