# Roamies speech server

Better ears and a better voice for Roamies, running on your own computer. Nothing here is needed for Roamies to
work: without it Roamies listens with its built-in model and speaks with Windows' own voice.

- **Ears.** Roamies' built-in listening model was trained mostly on American and European voices and mishears
  other accents. This runs a Whisper model instead. The default,
  [mjwong/whisper-large-v3-turbo-singlish](https://huggingface.co/mjwong/whisper-large-v3-turbo-singlish) (MIT),
  is tuned for Singapore English: on its author's Singlish test set it gets about half the word errors of the
  ordinary model it was made from (13% against 28%). Any Whisper model on Hugging Face can be used with `--model`.
- **Voice (optional).** [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (Apache 2.0), a small natural-sounding
  voice model. The default voice, `bm_george`, is a British man's: calm and measured, a good fit for the JARVIS
  look. It is a stock voice, not a copy of any actor.

## Set up (once)

You need Python 3.10 to 3.12. An NVIDIA graphics card makes listening feel instant; without one it works but
each sentence takes a few seconds.

```
conda create -n roamies-speech python=3.11 -y
conda activate roamies-speech
```

Install PyTorch with the command [pytorch.org](https://pytorch.org/get-started/locally/) gives for your graphics
card, then:

```
pip install -r requirements.txt
```

If `kokoro` fails to install, delete its line from `requirements.txt` and run the command again: you still get
the ears, and Roamies keeps Windows' voice.

## Run

```
conda activate roamies-speech
python roamies_speech_server.py
```

The first start downloads the models (about 1.6 GB for the ears, about 0.3 GB for the voice). When it prints
"Ready", open Roamies' panel, go to **Voice**, and:

- under **Talking to me**, add **Speech server**: `http://127.0.0.1:8123/v1/audio/transcriptions`
- under **Spoken replies**, pick **This PC**, then add **Voice server**: `http://127.0.0.1:8123/v1/audio/speech`
  with the voice name `bm_george`

Roamies tries each address before saving it. Leave the server's window open while you use Roamies. If it isn't
running, Roamies goes back to its built-in model and Windows' voice by itself, so nothing breaks.

Options: `--port 8124`, `--model <a Whisper model>`, `--voice bm_lewis` (other British men's voices: `bm_daniel`,
`bm_fable`), `--no-voice`, `--cpu`.

## What goes where

It listens only on this computer (`127.0.0.1`). Your speech and Roamies' replies go to this program and no
further; the only internet use is the one-time model download from Hugging Face.
