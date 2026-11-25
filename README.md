# SealedScribe

**English** · [Français](README.fr.md)

A Windows desktop app to record your meetings, transcribe them on your PC or with a cloud service, see who
said what, and get an AI summary.

> [!WARNING]
> **SealedScribe is provided "as is", without any warranty, and the author accepts no liability for its
> use.** You alone are responsible for what you record: the consent of the participants, compliance with
> the GDPR and with the rules of your employer or clients, the data sent to cloud services, and checking
> the AI-generated transcripts and summaries, which may be wrong.
> Read the [full notice](DISCLAIMER.md) (in French) before installing or using the app: using it means you
> accept it. The app shows it on first launch, and again whenever it changes, and stays locked until it is
> accepted; you can read it again in Settings > General > About.

Free software (GPL-3.0), built first for its author's Windows PC; formerly MeetScribe.
React + Tailwind interface, Rust backend, put together with Tauri 3 (alpha).

## Features

- **Recording** of the microphone, the PC sound, or both at once, from the window or from the
  notification area icon. Stops automatically after 5 minutes of silence or when the PC goes to sleep.
- **Local transcription** with whisper.cpp, on an NVIDIA graphics card (CUDA) or on the processor, with
  a model chosen to fit the hardware. The audio never leaves the PC. **Azure Speech** or
  **Mistral AI (Voxtral)** transcription as alternatives.
- **Who is speaking.** In a combined recording, each passage is attributed to "Me" or "Others"; speaker
  separation (sherpa-onnx) tells each remote participant apart. Names can be edited in the meeting page.
- **Transcription of a passage** selected on the waveform. Each transcription is kept as a version of the
  meeting.
- **AI summaries** displayed as they are written, from editable prompts (Prompts tab), with Azure AI,
  Mistral AI or a model already installed on the PC (Ollama, LM Studio, llama.cpp).
- **Vocabulary lists** that fix misheard names and jargon ("cube ernetes" → "Kubernetes").
- **Meetings that are easy to find**: search in titles, tags and transcripts; Transcript and Summary badges.
- **Import** of an audio file (WAV, MP3, M4A) and **export** of the summary or the transcript.
- **Background processing**: a transcription goes on with the window closed, resumes after an
  interruption, keeps the PC awake and can shut it down at the end.
- French or English interface, nine skins (Cassette, Classic, Terminal, Newspaper, Glacier, Slate, Neon,
  Pirate, Monochrome) in a light or dark theme, start with Windows, optional Microsoft sign-in.

Every version is described in the [CHANGELOG](CHANGELOG.md) (in French), also shown in the app
("What's new" button in the header).

## Installation

The `SealedScribe_X.Y.Z_x64-setup.exe` installer is published in the repository's
[GitHub Releases](https://github.com/ACivilise/SealedScribe/releases).
It is not code signed yet (see [Code signing policy](#code-signing-policy)): on first launch, Windows
SmartScreen shows a warning ("More info", then "Run anyway"). Installed versions update themselves: a
banner offers each new version, and only installs an update signed with the project's update key.

Requirements:

- Windows 10 or 11, 64-bit, with the WebView2 runtime (included in Windows 11);
- for local transcription on the graphics card: an NVIDIA card with driver 527 or later. Without one,
  local transcription runs on the processor, more slowly;
- for the Azure features: your own Azure Speech and Azure AI (Foundry) resources;
- for Mistral AI: an API key created on `console.mistral.ai` (one key for both transcription and summary);
- for summaries on the PC: Ollama (or LM Studio, llama-server) with a model already installed, for example
  `ollama pull qwen3:4b`. SealedScribe does not download these models.

## Code signing policy

> [!NOTE]
> The installers are not code signed for Windows yet. A Microsoft Store version, which Microsoft signs,
> is in preparation, and free code signing for open source projects will be requested again once the
> project is more established.

- **What will be signed:** only files built from this repository's source code, the application
  (`meetscribe.exe`) and its installer. The transcription and speaker-separation engines and models that
  the app downloads on request (whisper.cpp, sherpa-onnx, models hosted on Hugging Face) come from their
  own projects and are not signed by SealedScribe.
- **How:** each release is built from a version tag by the [Release workflow](.github/workflows/release.yml)
  on GitHub-hosted runners.
- **Team and roles:**
  - Committers and reviewers: [ACivilise](https://github.com/ACivilise)
  - Approvers: [ACivilise](https://github.com/ACivilise)
- **Privacy:** SealedScribe has no telemetry and sends nothing to its author. Everything it sends, where
  and when, is listed in [Where your data goes](#where-your-data-goes).

## Configuration

Everything is set in the **Settings** window, and nothing is required to record.

| Tab | Content |
|---|---|
| General | Recordings folder (default `Documents\Enregistrements audio`), start with Windows, Microsoft sign-in, language, theme and skin |
| Transcription | Engine (local model, Azure Speech or Mistral AI); local: model choice and engine installation; Azure Speech: key and region; Mistral: key and Voxtral model; speaker separation |
| AI summary | Engine (Azure AI, Mistral AI, Ollama or a local OpenAI-compatible server); Azure: endpoint, deployment name and key; Mistral: key and model; local: server address and model |

- **Azure and Mistral keys** are stored in the Windows Credential Manager and read only by the Rust
  backend; they are never compiled into the interface. The Mistral key is used for both transcription and
  summary.
- **Mistral AI** is called directly (`https://api.mistral.ai/v1`). Transcription: `voxtral-mini-latest` by
  default, audio sent in parts of about 10 minutes (progress, resume and stop after the current part, like
  the local engine), vocabulary list terms sent as preferred vocabulary. Summary: `mistral-medium-latest`
  by default.
- **The AI summary** accepts the OpenAI v1 API of a Foundry resource
  (`https://<resource>.services.ai.azure.com/openai/v1`, the deployment name is then required) or a legacy
  Azure AI Inference endpoint. HTTPS only.
- **Local summaries** use a model already installed in a server running on this PC (`localhost` or
  `127.0.0.1` only); Settings lists the installed models and tells whether they fit on the NVIDIA card.
  - **Ollama** (`http://127.0.0.1:11434` by default): SealedScribe uses its native API to set the context
    size from the length of the transcript (through its OpenAI-compatible API, Ollama sticks to 4,096
    tokens below 24 GB of graphics memory and silently truncates).
  - **OpenAI-compatible server** (LM Studio `http://127.0.0.1:1234/v1` by default, llama-server…): set the
    context length in the server, at least 32,768 tokens for a one-hour meeting.
  - Before a local summary, the local Whisper model is unloaded if idle, to free the graphics card.
- **Microsoft sign-in** is off by default. To turn it on, enter the application ID and directory ID of an
  Entra ID app registration, and declare the displayed redirect URI as a "Single-page application" (SPA).
  It only controls access to the app: the Azure services use the keys.

## Where your data goes

**On the PC** (no automatic backup: back up these folders yourself). Some folders still carry the former
name, so that existing data is kept:

| Data | Location |
|---|---|
| Audio files | Folder chosen in Settings > General |
| Meetings, transcripts, summaries, tags, prompts, vocabulary lists | Built-in browser storage: `%LOCALAPPDATA%\com.meetscribe.app\EBWebView` |
| Preferences | `%APPDATA%\meetscribe\preferences.json` |
| Local transcription engine and models | `%LOCALAPPDATA%\MeetScribe\whisper` |
| Azure and Mistral keys | Windows Credential Manager |

**Off the PC**, depending on the settings:

| Destination | What is sent | When |
|---|---|---|
| Azure Speech (`<region>.stt.speech.microsoft.com`) | The audio | Azure transcription engine |
| Azure summary endpoint | The transcript and the prompt | Summary with Azure AI |
| Mistral AI (`api.mistral.ai`) | The audio and the vocabulary list terms; the transcript and the prompt | Mistral transcription engine; summary with Mistral AI |
| Microsoft Entra ID (`login.microsoftonline.com`) | Your identity | Microsoft sign-in turned on |
| GitHub and Hugging Face | Nothing (download, checked by SHA-256 hash) | Local engine installation |
| GitHub (`github.com`) | Nothing (version check; installer download when you accept the update) | Update check (installer version only, the Microsoft Store version is updated by the Store): 15 seconds after launch, then every 6 hours, and "Check for updates" |
| Google Fonts | Nothing (font download) | Displaying the interface |

With the local transcription engine and a local summary (or no summary), neither the audio nor the text of
your meetings leaves the PC.

## Development

Requirements: Node.js 20.19+ or 22.12+, stable Rust with the MSVC toolchain (Visual Studio Build Tools,
C++ workload).

```bash
npm install
npm run tauri:dev            # interface (http://localhost:1430) + Rust backend, hot reload of the interface
npm test                     # interface tests (Vitest)
cd src-tauri && cargo test   # backend tests
npm run tauri:build          # installer in src-tauri/target/release/bundle/nsis/
```

In development only, the backend also reads the Azure keys from a `.env` file (template:
[`.env.example`](.env.example)). These variables, without the `VITE_` prefix, take precedence over the
Credential Manager.

Code comments, the changelog and the development notes (`CLAUDE.md`, `.claude/skills/`) are in French.

### Structure

```
src/                    React interface
  components/           Tabs, windows, shared components
  store/                Zustand stores (meetings, prompts, vocabulary lists…)
  i18n/                 French and English texts
src-tauri/src/          Rust backend
  commands.rs           Commands called by the interface
  services/             Audio capture (WASAPI), local and Azure transcription, speaker separation,
                        summary, background jobs, power management
  tray.rs               Notification area icon
CHANGELOG.md            Version history, shown in the app
SPECIFICATIONS.md       Functional specifications
```

### Versions and releases

`CHANGELOG.md` follows a strict format, checked by `src/lib/releaseNotes.test.ts`, which also requires its
latest version to match the one in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
A release is prepared with the Claude Code `/release` skill (changelog, version number, tag); pushing the
tag starts the [Release workflow](.github/workflows/release.yml), which builds and signs the installer and
publishes the GitHub Release with the `latest.json` file read by the in-app updater
([`.signpath/`](.signpath/README.md) describes the code signing setup, in French).

## License

© 2026 the SealedScribe contributors. SealedScribe is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License, version 3 or (at your option) any later version
([LICENSE](LICENSE)). Any modified version you distribute must stay under this license, with its source
code.

Third-party components (whisper.cpp, sherpa-onnx, Whisper, pyannote and WeSpeaker models, npm and Cargo
dependencies) remain under their own licenses.

Use of the app is subject to the [notice and disclaimer](DISCLAIMER.md).
