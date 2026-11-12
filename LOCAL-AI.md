# Local AI and private mode

Roamies can answer with a model that runs on your own computer, through [Ollama](https://ollama.com), instead of a
cloud provider. With **Private mode** on, it uses only that model and only this computer's voice, and shuts its own
ways out to the internet. This page is the setup, what private mode covers, and what it doesn't.

## Set up Ollama (Windows)

1. **Install Ollama.** Download it from [ollama.com/download](https://ollama.com/download), or run
   `winget install Ollama.Ollama`. It runs in the background and answers only on this computer (`127.0.0.1:11434`).

2. **Get a model.** In a terminal:

   ```
   ollama pull qwen3.5:9b
   ```

   Roamies needs a model that can call tools; one that also reads images can look at your screen. See
   [Which model](#which-model) below.

3. **Raise the context length.** This step matters most. Ollama gives a model only about 4,000 tokens of working
   memory by default on a graphics card with under 24 GB, and Roamies' own instructions are larger than that. Set it to
   **32k**: in the Ollama app, Settings > Context length; or set a user environment variable (Start > "Edit environment
   variables for your account") and restart Ollama:

   ```
   OLLAMA_CONTEXT_LENGTH=32768
   ```

   Roamies checks what Ollama really gives the model and tells you if it's too small (under 16k it won't start a
   request, and says what to change).

4. **Switch off Ollama's own cloud features.** Ollama can also relay "cloud" models and web searches to its servers.
   Roamies never lists those models, and you can turn the feature off in Ollama itself with one more variable:

   ```
   OLLAMA_NO_CLOUD=1
   ```

5. **Pick it in Roamies.** Open the panel > **Model**. Under **On this computer**, press **Scan**; your models appear
   in the model list under "This PC (Ollama)". Pick one, or switch **Private mode** on and Roamies picks one for you.

6. **Check it's on the graphics card.** Ask Roamies something, then run `ollama ps`. The PROCESSOR column should say
   `100% GPU` and CONTEXT should say `32768`. If part of the model is on the CPU, replies are several times slower:
   close other programs that use the graphics card, or pick a smaller model.

Optional, for the kinds of work people ask for most:

- **PDFs:** `winget install oschwartz10612.Poppler` (brings `pdftotext`), or `pip install pypdf` if you have Python.
  Word, Excel and PowerPoint files need nothing extra.
- **Video and audio editing:** `winget install Gyan.FFmpeg`. Roamies edits by running `ffmpeg` commands, so
  **Allow file edits and commands** (panel > Behavior) must be on.

Install these before you switch private mode on: installing needs the internet.

## Which model

For a graphics card with 16 GB (for example an RTX 5060 Ti 16 GB):

| Model | Download | Why |
| --- | --- | --- |
| `qwen3.5:9b` | about 7 GB | First choice. Calls tools, reads images (so it can look at your screen), thinks before answering. Leaves room for a 32k context and for a speech server on the same card. |
| `gemma4:12b` | about 8 GB | The alternative if you prefer how it writes. Tools and images too. |
| `gpt-oss:20b` | about 14 GB | Stronger at reasoning over text, but it can't see images and nearly fills the card: no room for a speech server, and a 32k context may spill onto the CPU. |

Sizes and model names change; check the [Ollama library](https://ollama.com/library). Whatever you pick, look at
`ollama ps` afterwards: the model, its context and anything else on the card (a Whisper or voice server) all have to fit
in the card's memory together.

What to expect: a model this size is slower and less capable than the cloud models. It summarises, rewrites, drafts
emails, answers questions about a document and runs single commands well. It's less dependable at long chains of steps
(many files, several tools in a row) and makes more mistakes with exact figures, so check numbers it quotes against the
document. Local models answer without the on-screen cards and drawings (their instructions are too large for a small
context); set `"localDraw": true` in `~/.gg/sidekick.json` to bring them back outside private mode.

## What Roamies can read

`read_file` opens plain text and code, Word (`.docx`), PowerPoint (`.pptx`), Excel (`.xlsx`) and PDF, all on this
computer. Long files come in parts and the model asks for the next part itself. Old `.doc`, `.xls` and `.ppt` files,
password-locked files and scanned PDFs (pictures of pages) can't be read; it says so.

## Private mode

Panel > **Model** > **On this computer** > **Private mode**. The header shows "Private" on every page while it's on.

While it's on:

- Only a model on this computer answers. If Ollama isn't running, Roamies says so; it never falls back to a cloud model.
- Replies are spoken only by this computer's voice (Windows' own voices, or a voice server at a loopback address). Fish
  Audio is not used, even with a key saved.
- Every web request the app's own code makes is refused unless it goes to this computer (`127.0.0.1`, `localhost`).
- The model has no web page fetching, no photo lookup and no drawing cards (which load pictures from the internet).
- Links are not opened, in a browser or anywhere else. Files, folders and apps still open.
- Commands that reach the network (`curl`, `Invoke-WebRequest`, `git push`, `scp`, `pip install`, anything with a web
  address or a `\\server\share` path) are refused before they run.
- Nothing from the conversation is sent anywhere to build long-term memory, and no update check is made.
- Signing in to a provider, adding keys and downloading the listening model are held until it's off.
- Switching it off starts a new conversation first, so what was said in private isn't sent on with your next question.

What it does **not** do, so you can judge it for restricted material:

- **It is not a firewall.** It governs what Roamies does, not other programs. For a hard guarantee, also block
  Roamies and Ollama from the internet in Windows Firewall, or work offline.
- **The command check reads the command, it doesn't sandbox it.** It refuses the usual ways to reach the network, but
  a program or script the model runs could still connect by itself. Commands also still ask before anything risky, and
  stay off entirely unless you turned **Allow file edits and commands** on.
- **Controlling other apps is unchanged.** If you ask it to type or click in a browser, a mail app or a chat app, that
  app does what it normally does, including sending.
- **What's already saved stays saved.** Memory facts, reminders and the conversation are kept on this computer as
  before (see [PRIVACY.md](PRIVACY.md)); a reminder you set in private is an ordinary reminder afterwards. Facts aren't
  learned from private conversations.
- **Your documents are only as safe as this computer.** Ollama, Roamies' logs and the files themselves are on disk.

On Windows, speech is already turned into text on your computer, in private mode or not.

## For developers

`sidecar/localai.mjs` holds all of it: finding Ollama's models through the engine's own local-model support
(`@kenkaiiii/gg-core`), leaving out cloud-relayed models, the context check, and private mode's guards (`guardFetch`,
`toolsFor`, `networkCommand`, `opensOutside`). `sidecar/docs.mjs` reads documents. Tests: `test/localai.test.mjs`,
`test/docs.test.mjs`.
