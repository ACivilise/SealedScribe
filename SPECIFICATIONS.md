# SealedScribe - Technical Specifications

## Executive Summary

This document provides comprehensive technical specifications for **SealedScribe**, an intelligent meeting recording and transcription desktop application.

**Current Stack**: Tauri + React + Vite + Tailwind CSS + Rust + Azure Cognitive Services

---

## Table of Contents

1. [Application Overview](#application-overview)
2. [Core Features](#core-features)
3. [Architecture](#architecture)
4. [Authentication (SSO)](#authentication-sso)
5. [Audio Recording](#audio-recording)
6. [Transcription & AI](#transcription--ai)
7. [Data Models](#data-models)
8. [User Interface](#user-interface)
9. [Configuration](#configuration)
10. [File Export](#file-export)
11. [Implementation Status](#implementation-status)

---

## Application Overview

**SealedScribe** is an intelligent desktop application that captures system audio, transcribes speech in real-time using Azure Speech Service, identifies speakers, and generates AI-powered summaries. The application uses Microsoft Single Sign-On (SSO) for secure Azure service access.

### Key Capabilities
- **SSO Authentication**: Azure AD (Microsoft Entra ID) authentication with MSAL
- **Desktop Audio Capture**: System audio loopback recording (WASAPI on Windows)
- **Real-time Transcription**: Azure Speech Service integration with speaker identification
- **AI Summaries**: Multiple summary styles using Azure AI Inference (Mistral-Large-3)
- **Markdown Export**: Formatted transcripts with metadata, timestamps, and speakers
- **Multi-language Support**: 9+ languages including English, French, German, Spanish, etc.

### Target Platform
- **Primary**: Windows 10/11 desktop
- **Future**: Cross-platform (macOS, Linux) with appropriate audio APIs

---

## Core Features

### 1. Authentication & User Management
- Microsoft SSO login using MSAL (Microsoft Authentication Library)
- Interactive browser-based authentication flow
- Token management and automatic refresh
- Azure AD credential provisioning for service access
- User profile display (name, email)
- Sign-out functionality with session cleanup

### 2. Audio Recording
- Desktop audio capture via WASAPI loopback (Windows)
- Real-time audio level monitoring and visualization
- WAV file output (44.1kHz, 16-bit, stereo/mono)
- Recording controls (start, stop, pause)
- Audio device testing and enumeration
- Visual waveform display (60-sample buffer)

### 3. Transcription
- Azure Speech Service integration (France Central region)
- Continuous speech recognition
- Multi-language support (9 languages)
- Timestamp tracking (start/end times)
- Confidence scoring per segment
- Speaker identification/diarization

### 4. AI-Powered Summaries
- Azure AI Inference API (Mistral-Large-3 model)
- Four summary styles:
  - Comprehensive (detailed overview)
  - Bullet Points (key items list)
  - Executive Brief (2-3 sentence summary)
  - Action Items (decisions and next steps)
- Configurable summary length (character limit)
- Temperature and sampling controls

### 5. Meeting Management
- Recent meetings list with metadata
- Meeting title and language selection
- Duration tracking
- Status indicators (Recording, Processing, Completed)
- Meeting history with quick access

### 6. Export & Storage
- Markdown export with full formatting
- Separate summary export
- Desktop "Recordings" folder organization
- File naming: `YYYY-MM-DD_HHMM_MeetingTitle.wav/md`
- Participant list with speaker labels
- Timestamped transcript segments

---

## Architecture

### Current Architecture (Tauri/React)

```
┌─────────────────────────────────────────────────────┐
│              React Frontend (UI)                    │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │Login Screen  │  │Main App      │  │Settings   │ │
│  │- MSAL React  │  │- Recording UI│  │- Prefs    │ │
│  │- @azure/msal │  │- 3 Tabs      │  │- Theme    │ │
│  │  -react      │  │- Zustand     │  │- Device   │ │
│  └──────────────┘  │  Store       │  │  Test     │ │
│                    └──────────────┘  └───────────┘ │
│     (Tailwind CSS + Framer Motion)                  │
└─────────────────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │  Tauri IPC Commands │
              │   (Rust Backend)    │
              └──────────┬──────────┘
                         │
┌─────────────────────────────────────────────────────┐
│               Rust Backend (Tauri)                  │
│  ┌──────────────────┐  ┌─────────────────────────┐ │
│  │Auth Module       │  │Audio Module             │ │
│  │- Token Storage   │  │- CPAL (Audio Lib)       │ │
│  │- Secure Store    │  │- WASAPI Loopback        │ │
│  └──────────────────┘  └─────────────────────────┘ │
│  ┌──────────────────┐  ┌─────────────────────────┐ │
│  │Speech Module     │  │Export Module            │ │
│  │- REST API        │  │- Markdown Gen           │ │
│  │- HTTP Client     │  │- File System I/O        │ │
│  │- Audio Process.  │  │- WAV Writing            │ │
│  └──────────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────┘
                         │
┌─────────────────────────────────────────────────────┐
│               Azure Services (Cloud)                │
│  - Azure AD (Microsoft Entra ID)                    │
│  - Azure Speech Service (francecentral)             │
│  - Azure AI Inference (Mistral-Large-3)             │
└─────────────────────────────────────────────────────┘
```

---

## Authentication (SSO)

### Overview
The application uses Microsoft Authentication Library (MSAL) to authenticate users with Azure Active Directory (Microsoft Entra ID). Upon successful authentication, users receive access tokens for Azure resources.

### Authentication Flow

```
┌──────┐        ┌──────────┐        ┌──────────┐        ┌─────────┐
│ User │───────>│  App     │───────>│Azure AD  │───────>│Resources│
└──────┘  Click │ (MSAL)   │  Auth  │ (SSO)    │ Token  │(Speech, │
          Sign In└──────────┘ Request└──────────┘ Return │  AI)    │
                      │                   │               └─────────┘
                      └───────────────────┘
                      Interactive Browser
                      Login (OAuth 2.0)
```

### Configuration

**Azure AD App Registration Requirements:**
- **Application Type**: Public client/native application
- **Redirect URI**: `http://localhost` (or custom scheme for production)
- **Authentication**: Public client flows enabled
- **API Permissions**:
  - `Microsoft Graph`: `User.Read` (Delegated)
  - `Azure Service Management`: `user_impersonation` (Delegated)
- **Tenant**: Multi-tenant or single tenant (configurable)

### Configuration Values

```json
{
  "AzureAD": {
    "ClientId": "GUID from App Registration",
    "TenantId": "GUID or 'common' for multi-tenant",
    "RedirectUri": "http://localhost",
    "AuthorityBaseUrl": "https://login.microsoftonline.com",
    "Scopes": [
      "https://management.azure.com/user_impersonation",
      "User.Read"
    ]
  }
}
```

### Implementation Details

The application uses modern web technologies for the frontend while leveraging Rust for system-level operations. MSAL authentication is handled through browser-based OAuth flow.

**For Tauri/React:**
- Use `@azure/msal-react` and `@azure/msal-browser` for frontend authentication
- Zustand for state management
- Tauri commands for backend communication
- REST APIs for Azure services
- CPAL and hound crates for audio operations in Rust

### Security Considerations
- **Never store Client Secret** (not needed for public client)
- Use system keychain/credential manager for token storage
- Implement proper token expiration and refresh
- Clear tokens on sign-out
- Validate tokens server-side when possible

### User Session Data

```typescript
interface UserSession {
  userId: string;
  displayName: string;
  email: string;
  tenantId: string;
  authenticatedAt: Date;
  isAuthenticated: boolean;
  accessToken: string; // For Azure service access
}
```

---

## Audio Recording

### Overview
The application captures desktop system audio (loopback) for meeting recording using CPAL (Cross-Platform Audio Library) with platform-specific backends.

### Implementation (Rust + CPAL)

**Technology**: CPAL with WASAPI on Windows (native endpoint loopback)

**Key Features:**
- Captures system audio output via WASAPI
- Real-time audio level monitoring
- WAV file output (44.1kHz, 16-bit, stereo)
- Asynchronous recording with Tokio runtime
- Proper resource cleanup

**Key Dependencies:**
- `cpal` 0.16 - Audio capture
- `hound` 3.5 - WAV file writing
- `tokio` - Async runtime

**Recording Flow:**
```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│ System Audio    │────>│ CPAL WASAPI      │────>│  WAV File   │
│ (Speakers/Apps) │     │  Loopback Device │     │  (hound)    │
└─────────────────┘     └──────────────────┘     └─────────────┘
                                │
                                ├──> Audio Level Monitor
                                └──> Waveform Visualization
```

### Tauri Commands

```rust
#[tauri::command]
async fn start_recording(output_path: String) -> Result<bool, String> {
    // Initialize CPAL audio capture
    // Configure WASAPI loopback endpoint
    // Start recording to WAV file
    // Return success/failure
}

#[tauri::command]
async fn stop_recording() -> Result<(), String> {
    // Stop audio capture
    // Finalize WAV file
    // Release audio resources
}

#[tauri::command]
async fn get_audio_level() -> Result<f32, String> {
    // Return current audio level (0.0 to 1.0 RMS)
}

#[tauri::command]
async fn get_audio_devices() -> Result<Vec<String>, String> {
    // Enumerate available audio devices
    // Return list for testing/selection
}
```

### Frontend Integration (React)

```typescript
import { invoke } from '@tauri-apps/api/tauri';

const useAudioRecording = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [duration, setDuration] = useState(0);

  const startRecording = async (outputPath: string) => {
    const success = await invoke<boolean>('start_recording', { outputPath });
    setIsRecording(success);
  };

  const stopRecording = async () => {
    await invoke('stop_recording');
    setIsRecording(false);
  };

  // Poll audio level during recording
  useEffect(() => {
    if (!isRecording) return;
    
    const interval = setInterval(async () => {
      const level = await invoke<number>('get_audio_level');
      setAudioLevel(level);
    }, 100);

    return () => clearInterval(interval);
  }, [isRecording]);

  return { isRecording, audioLevel, duration, startRecording, stopRecording };
};
```

### Audio Format Specifications

**WAV File Format:**
- **Container**: WAV (RIFF)
- **Codec**: PCM (uncompressed)
- **Sample Rate**: 44100 Hz (CD quality) or 48000 Hz
- **Bit Depth**: 16-bit signed integer or 32-bit float
- **Channels**: 2 (stereo) or 1 (mono)
- **Byte Rate**: `sampleRate * channels * (bitDepth/8)`

**File Size Estimation:**
- 16-bit stereo @ 44.1kHz: ~10.5 MB per minute
- 32-bit stereo @ 44.1kHz: ~21 MB per minute

### Device Testing

**Test Procedure:**
1. Enumerate available audio devices
2. Test loopback capture initialization
3. Verify format compatibility
4. Check for audio access permissions

**Important Notes:**
- WASAPI loopback requires audio to be actively playing
- Administrator privileges may be required on some systems
- Antivirus software may block audio capture
- Virtual audio devices (e.g., VoiceMeeter) are supported

---

## Transcription & AI

### Azure Speech Service Integration

**Service Details:**
- **Region**: France Central (`francecentral`)
- **Endpoint**: `https://francecentral.api.cognitive.microsoft.com/`
- **API**: Speech SDK (Continuous Recognition)
- **Languages Supported**: 9+ languages

**Authentication:**
- Subscription key (`Ocp-Apim-Subscription-Key`), stored in the Windows Credential Manager
  (Settings > Transcription, Azure Speech engine) and read by the Rust backend only.
- The Microsoft sign-in (MSAL, optional, Settings > General) only gates access to the app:
  its token is never sent to Azure Speech or AI Inference.

### Transcription Process Flow

```
┌────────────┐    ┌──────────────┐    ┌────────────────┐
│ WAV File   │───>│ Azure Speech │───>│ Transcription  │
│ (Recorded) │    │   Service    │    │   Segments     │
└────────────┘    └──────────────┘    └────────────────┘
                         │                     │
                         │                     ├─> Timestamps
                         │                     ├─> Speaker IDs
                         │                     ├─> Confidence
                         │                     └─> Language
                         │
                  ┌──────┴───────────┐
                  │  HTTP REST API   │
                  │- Speech-to-Text  │
                  │- Real-time Events│
                  └──────────────────┘
```

### REST API Integration

The application communicates with Azure Speech Service using REST APIs instead of SDKs. This approach provides better control and simpler dependency management.

**Rust Backend Implementation:**
```rust
use reqwest::Client;

#[tauri::command]
async fn transcribe_audio(
    audio_path: String, 
    language: String,
    speech_key: String,
    region: String
) -> Result<Vec<TranscriptionSegment>, String> {
    // Read audio file
    let audio_bytes = tokio::fs::read(&audio_path).await?;
    
    // Create HTTP client for Azure Speech Service
    let client = Client::new();
    
    // Send audio for transcription via REST API
    let endpoint = format!(
        "https://{}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1",
        region
    );
    
    let response = client.post(&endpoint)
        .header("Ocp-Apim-Subscription-Key", speech_key)
        .header("Content-Type", "audio/wav; codecs=audio/pcm; samplerate=16000")
        .query(&[("language", language)])
        .body(audio_bytes)
        .send()
        .await?;
    
    // Parse and return segments
}
```

### Azure AI Inference (Summaries)

**Service Details:**
- **Endpoint**: `https://fd-transcribe.services.ai.azure.com/models`
- **Model**: Mistral-Large-3
- **API**: Azure AI Inference (Chat Completions)

**Configuration:**
```json
{
  "AzureAIInference": {
    "Endpoint": "https://fd-transcribe.services.ai.azure.com/models",
    "Model": "Mistral-Large-3",
    "ApiKey": "SECRET_KEY",
    "MaxTokens": 2048,
    "Temperature": 0.3,
    "NucleusSamplingFactor": 0.1
  }
}
```

**Summary Generation Parameters:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **Temperature** | 0.3 | Lower = more focused, deterministic |
| **MaxTokens** | 2048 | Maximum response length |
| **NucleusSamplingFactor** (Top-P) | 0.1 | Narrow probability distribution |

**Summary Styles:**

1. **Comprehensive** (Default)
   - Full overview with context
   - Key discussion points
   - Decisions made
   - Action items with context
   - Mentioned dates/deadlines

2. **Bullet Points**
   - Numbered list of key items
   - Concise, scannable format
   - Main topics only

3. **Executive Brief**
   - 2-3 sentences maximum
   - High-level overview only
   - Decision-focused

4. **Action Items**
   - Tasks and next steps only
   - Owner assignments (if mentioned)
   - Deadlines highlighted
   - Decision records

**Prompt Template (Comprehensive):**
```
Please provide a comprehensive summary of the following meeting transcript:

[TRANSCRIPT TEXT WITH SPEAKERS]

Include:
- Key discussion points
- Decisions made
- Action items
- Important dates or deadlines mentioned

Summary:
```

### Rust Backend (HTTP Client)

```rust
use reqwest::Client;
use serde_json::json;

#[tauri::command]
async fn generate_summary(
    transcript: String,
    style: String,
    api_key: String,
    endpoint: String
) -> Result<String, String> {
    let client = Client::new();
    
    let prompt = format_prompt(&transcript, &style);
    
    let response = client.post(&format!("{}/chat/completions", endpoint))
        .header("api-key", api_key)
        .json(&json!({
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 2048,
            "temperature": 0.3,
            "top_p": 0.1
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    
    let body = response.json::<serde_json::Value>().await
        .map_err(|e| e.to_string())?;
    
    body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid response format".to_string())
}
```

### Language Support

**Available Languages:**
```typescript
const SUPPORTED_LANGUAGES = [
  { code: 'en-US', name: 'English (US)' },
  { code: 'fr-FR', name: 'French (France)' },
  { code: 'de-DE', name: 'German (Germany)' },
  { code: 'es-ES', name: 'Spanish (Spain)' },
  { code: 'it-IT', name: 'Italian (Italy)' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'ja-JP', name: 'Japanese (Japan)' },
  { code: 'ko-KR', name: 'Korean (Korea)' },
  { code: 'zh-CN', name: 'Chinese (Simplified)' }
];
```

---

## Data Models

### TypeScript Interfaces (for Tauri/React)

```typescript
// User Authentication
interface UserSession {
  userId: string;
  displayName: string;
  email: string;
  tenantId: string;
  authenticatedAt: Date;
  isAuthenticated: boolean;
  accessToken: string;
}

// Meeting Session
interface MeetingSession {
  id: string; // UUID
  title: string;
  startTime: Date;
  endTime?: Date;
  duration: number; // seconds
  filePath?: string; // WAV file path
  transcriptionPath?: string; // Markdown file path
  status: MeetingStatus;
  speakers: Speaker[];
}

enum MeetingStatus {
  Stopped = 'stopped',
  Recording = 'recording',
  Processing = 'processing',
  Completed = 'completed'
}

// Speaker
interface Speaker {
  label: number;
  name: string;
}

// Transcription Segment
interface TranscriptionSegment {
  text: string;
  startTime: number; // seconds
  endTime: number; // seconds
  speakerId: string;
  speakerName: string;
  confidence: number; // 0.0 to 1.0
  language: string;
}

// Meeting Transcription
interface MeetingTranscription {
  sessionId: string;
  segments: TranscriptionSegment[];
  speakerMap: Record<string, string>; // speakerId -> speakerName
  createdAt: Date;
  language: string;
  summary?: string;
}

// Application Settings
interface AppSettings {
  azureAd: AzureADSettings;
  azureAiInference: AzureAIInferenceSettings;
  azureSpeech: AzureSpeechSettings;
}

interface AzureADSettings {
  clientId: string;
  tenantId: string;
  redirectUri: string;
  authorityBaseUrl: string;
  scopes: string[];
}

interface AzureAIInferenceSettings {
  endpoint: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  nucleusSamplingFactor: number;
}

interface AzureSpeechSettings {
  region: string;
  resourceName: string;
  subscriptionKey: string;
  speechEndpointBaseUrl: string;
}

// Audio Level Event
interface AudioLevelEvent {
  level: number; // 0.0 to 1.0
  timestamp: Date;
}

// User Preferences
interface UserPreferences {
  defaultLanguage: string;
  outputDirectory: string;
  autoGenerateSummary: boolean;
  summaryStyle: 'Comprehensive' | 'Bullet Points' | 'Executive Brief' | 'Action Items';
  theme: 'light' | 'dark' | 'system';
}
```

### Rust Structures (Backend)

```rust
use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct MeetingSession {
    pub id: Uuid,
    pub title: String,
    pub start_time: DateTime<Utc>,
    pub end_time: Option<DateTime<Utc>>,
    pub file_path: Option<String>,
    pub transcription_path: Option<String>,
    pub status: MeetingStatus,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum MeetingStatus {
    Stopped,
    Recording,
    Processing,
    Completed,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TranscriptionSegment {
    pub text: String,
    pub start_time: f64,
    pub end_time: f64,
    pub speaker_id: String,
    pub speaker_name: String,
    pub confidence: f32,
    pub language: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MeetingTranscription {
    pub session_id: Uuid,
    pub segments: Vec<TranscriptionSegment>,
    pub speaker_map: std::collections::HashMap<String, String>,
    pub created_at: DateTime<Utc>,
    pub language: String,
    pub summary: Option<String>,
}
```

---

## User Interface

### Design Principles

**Liquid Design (Apple-inspired):**
- Smooth animations (200-300ms transitions)
- Rounded corners (12-16px border radius)
- Subtle shadows for depth perception
- Clean typography hierarchy
- Generous whitespace
- Responsive layout
- Accessibility-first approach

### Color Palette

```css
/* Primary Colors */
--color-primary: #007AFF;      /* Apple Blue */
--color-primary-hover: #0051D5;
--color-danger: #FF3B30;       /* Apple Red */
--color-danger-hover: #D70015;
--color-success: #34C759;      /* Apple Green */
--color-warning: #FF9500;      /* Apple Orange */

/* Neutral Colors */
--color-bg-primary: #FFFFFF;
--color-bg-secondary: #F5F5F7;
--color-bg-tertiary: #E5E5EA;
--color-text-primary: #1D1D1F;
--color-text-secondary: #6E6E73;
--color-text-tertiary: #86868B;

/* Dark Mode */
--color-bg-primary-dark: #000000;
--color-bg-secondary-dark: #1C1C1E;
--color-bg-tertiary-dark: #2C2C2E;
--color-text-primary-dark: #FFFFFF;
--color-text-secondary-dark: #EBEBF5;
```

### Main Application Screens

#### 1. Login Screen
**Purpose**: Authenticate user with Microsoft SSO

**Layout:**
```
┌────────────────────────────────────────┐
│                                        │
│         [App Icon/Logo]                │
│                                        │
│           SealedScribe                   │
│                                        │
│   ┌──────────────────────────────┐    │
│   │  Sign in with Microsoft      │    │
│   └──────────────────────────────┘    │
│                                        │
│   Secure access with your Microsoft   │
│   account to use Azure services       │
│                                        │
└────────────────────────────────────────┘
```

**Components:**
- Centered layout
- Large app logo/icon
- "Sign in with Microsoft" button (branded)
- Explanatory text
- Loading state during authentication

#### 2. Main Application Window

**Layout Structure:**
```
┌─────────────────────────────────────────────────────────┐
│  [Logo] SealedScribe          [User: John]  [⚙️ Settings] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Recording   │  │  Recordings  │  │   Summary     │ │
│  └─────────────┘  └──────────────┘  └───────────────┘ │
│                                                         │
│  [ACTIVE TAB CONTENT]                                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### 3. Recording Tab

**Components:**

**Meeting Configuration:**
```
Meeting Title: [____________________________________________]
Language:      [French (France)         ▼]

[Test Audio Devices]
```

**Recording Controls:**
```
┌────────────────────────────────────────┐
│                                        │
│         ●  00:00:00                    │
│         REC                            │
│                                        │
│    [Waveform Visualization]            │
│    ▁▃▅▇▆▄▂▁▃▅▇▆▄▂▁▃▅▇▆▄▂▁            │
│                                        │
│    Audio Level: ████████░░ 80%         │
│                                        │
│    [    STOP RECORDING    ]            │
│                                        │
└────────────────────────────────────────┘
```

**Status Messages:**
- "Ready to record"
- "Recording in progress... (Make sure audio is playing)"
- "Processing transcription..."
- "Completed ✓"

#### 4. Recordings Tab

**Components:**
- List of recent meetings
- Each item shows:
  - Meeting title
  - Date/time
  - Duration
  - Status badge
  - Action buttons (View, Remove)

**Layout:**
```
┌──────────────────────────────────────────────┐
│  Team Standup                  [View] [✕]    │
│  2024-12-18 09:30 • 15:32 • Completed        │
├──────────────────────────────────────────────┤
│  Product Review                [View] [✕]    │
│  2024-12-17 14:00 • 42:18 • Completed        │
├──────────────────────────────────────────────┤
│  Client Call                   [View] [✕]    │
│  2024-12-16 11:00 • 28:45 • Completed        │
└──────────────────────────────────────────────┘
```

#### 5. Summary Tab

**Components:**
- Meeting selector
- Summary style dropdown
- Length slider
- Generate button
- Generated summary display
- Copy/Export actions

**Layout:**
```
Select Meeting: [Team Standup - 2024-12-18  ▼]
Summary Style:  [Comprehensive              ▼]
Length:         [────────────●──] 200 chars

           [Generate Summary]

┌──────────────────────────────────────────────┐
│                                              │
│  [Generated summary appears here]           │
│                                              │
│                                              │
└──────────────────────────────────────────────┘

[Copy to Clipboard]  [Export as Markdown]
```

#### 6. Settings/Preferences

**Sections:**
- **Azure Configuration**
  - Speech Service region
  - AI Inference endpoint
  - Test connections
- **Recording Preferences**
  - Default language
  - Output directory
  - Auto-generate summary
- **UI Preferences**
  - Theme (Light/Dark/System)
  - Animation speed
- **About**
  - Version information
  - Licenses

### Tailwind CSS Utilities

**Key Classes for Liquid Design:**

```jsx
// Buttons
<button className="
  px-6 py-3 
  bg-blue-500 hover:bg-blue-600 
  text-white font-medium 
  rounded-xl 
  shadow-md hover:shadow-lg 
  transition-all duration-300 
  transform hover:scale-105
">
  Sign in with Microsoft
</button>

// Cards
<div className="
  bg-white dark:bg-gray-800 
  rounded-2xl 
  shadow-xl 
  p-6 
  transition-all duration-300 
  hover:shadow-2xl
">
  {/* Content */}
</div>

// Input Fields
<input className="
  w-full 
  px-4 py-3 
  bg-gray-50 dark:bg-gray-700 
  border-2 border-gray-200 dark:border-gray-600 
  rounded-xl 
  focus:outline-none focus:ring-2 focus:ring-blue-500 
  transition-all duration-200
" />
```

### Animations (Framer Motion)

**Recommended Animations:**

```jsx
import { motion } from 'framer-motion';

// Fade in animation
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.3 }}
>
  {/* Content */}
</motion.div>

// Recording pulse
<motion.div
  animate={{
    scale: [1, 1.1, 1],
    opacity: [1, 0.8, 1]
  }}
  transition={{
    duration: 1.5,
    repeat: Infinity,
    ease: "easeInOut"
  }}
  className="text-red-500"
>
  ● REC
</motion.div>

// Waveform bars
{audioSamples.map((level, i) => (
  <motion.div
    key={i}
    animate={{ height: `${level * 100}%` }}
    transition={{ duration: 0.1 }}
    className="bg-blue-500 w-1 rounded-full"
  />
))}
```

### Accessibility

**WCAG 2.1 AA Compliance:**
- Color contrast ratios ≥ 4.5:1 for text
- Keyboard navigation support
- ARIA labels for screen readers
- Focus indicators on all interactive elements
- Skip navigation links
- Proper heading hierarchy

```jsx
<button
  aria-label="Start recording meeting"
  role="button"
  tabIndex={0}
  className="focus:ring-2 focus:ring-blue-500 focus:outline-none"
>
  Start Recording
</button>
```

---

## Configuration

### Environment Variables

Sensitive configuration is managed via environment variables in a `.env` file at the project root.

**Required Variables:**

```bash
# Azure AD Authentication
VITE_AZURE_AD_CLIENT_ID=your-client-id-guid
VITE_AZURE_AD_TENANT_ID=your-tenant-id-guid

# Azure Speech Service (Transcription)
AZURE_SPEECH_KEY=your-subscription-key
AZURE_SPEECH_REGION=francecentral

# Azure AI Inference (Summaries)
AZURE_AI_INFERENCE_ENDPOINT=your-ai-inference-endpoint
AZURE_AI_INFERENCE_KEY=your-api-key
```

**Note**: Variables prefixed with `VITE_` are exposed to the frontend. Never expose secrets directly.

### Tauri Configuration

**tauri.conf.json:**
```json
{
  "build": {
    "distDir": "../dist",
    "devPath": "http://localhost:5173"
  },
  "tauri": {
    "allowlist": {
      "all": false,
      "fs": {
        "all": false,
        "readFile": true,
        "writeFile": true,
        "createDir": true,
        "scope": ["$DESKTOP/Recordings/*"]
      },
      "dialog": {
        "all": true
      },
      "shell": {
        "open": true
      },
      "http": {
        "all": true,
        "scope": [
          "https://login.microsoftonline.com/*",
          "https://francecentral.api.cognitive.microsoft.com/*",
          "https://fd-transcribe.services.ai.azure.com/*"
        ]
      }
    },
    "bundle": {
      "identifier": "com.meetscribe.app",
      "icon": ["icons/icon.png"],
      "active": true
    },
    "windows": [
      {
        "title": "SealedScribe",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "fullscreen": false
      }
    ]
  }
}
```

### Secrets Management

**Tauri Secure Storage:**
- Use `tauri-plugin-store` for encrypted local storage
- Store access tokens securely
- Never commit secrets to version control

```rust
use tauri_plugin_store::StoreBuilder;

let mut store = StoreBuilder::new(app, "secure.json").build();
store.set("access_token", token)?;
store.save()?;
```

---

## File Export

### Markdown Export Format

**Full Transcript Example:**

```markdown
# Team Standup Meeting

**Date:** 2024-12-18 09:30  
**Language:** French (France)  
**Duration:** 15:32  

## Participants

- **Alice Dupont** (Speaker1)
- **Bob Martin** (Speaker2)
- **Claire Bernard** (Speaker3)

## Summary

The team discussed project progress, identifying three key blockers...
[AI-generated comprehensive summary]

## Transcript

**Alice Dupont** `[00:00]`
Bonjour à tous, commençons notre standup quotidien.

**Bob Martin** `[00:05]`
Hier, j'ai terminé la fonctionnalité d'authentification...

**Claire Bernard** `[00:45]`
J'ai rencontré un problème avec l'API Azure...

---
*Generated by SealedScribe on 2024-12-18 10:00*
```

**Summary-Only Export:**

```markdown
# Team Standup Meeting - Summary

**Date:** 2024-12-18 09:30  
**Language:** French (France)  

## Key Points

1. Authentication feature completed by Bob
2. Azure API integration issue identified by Claire
3. Action item: Schedule technical review for tomorrow

---
*Generated by Meeting Recorder on 2024-12-18 10:00*
```

### File Naming Convention

```
Format: YYYY-MM-DD_HHMM_MeetingTitle.extension

Examples:
- 2024-12-18_0930_Team_Standup.wav
- 2024-12-18_0930_Team_Standup.md
- 2024-12-18_0930_Team_Standup_summary.md
```

### File Organization

```
Desktop/
└── Recordings/
    ├── 2024-12-18_0930_Team_Standup.wav
    ├── 2024-12-18_0930_Team_Standup.md
    ├── 2024-12-18_0930_Team_Standup_summary.md
    ├── 2024-12-17_1400_Product_Review.wav
    ├── 2024-12-17_1400_Product_Review.md
    └── 2024-12-17_1400_Product_Review_summary.md
```

### Export Service Implementation

**Rust Tauri Command:**
```rust
#[tauri::command]
async fn export_to_markdown(
    transcription: MeetingTranscription,
    title: String,
    output_path: String
) -> Result<String, String> {
    let mut markdown = String::new();
    
    // Header
    markdown.push_str(&format!("# {}\n\n", title));
    markdown.push_str(&format!("**Date:** {}\n", transcription.created_at));
    markdown.push_str(&format!("**Language:** {}\n", transcription.language));
    
    // Participants
    markdown.push_str("\n## Participants\n\n");
    for (id, name) in &transcription.speaker_map {
        markdown.push_str(&format!("- **{}** ({})\n", name, id));
    }
    
    // Summary
    if let Some(summary) = &transcription.summary {
        markdown.push_str("\n## Summary\n\n");
        markdown.push_str(summary);
        markdown.push_str("\n");
    }
    
    // Transcript
    markdown.push_str("\n## Transcript\n\n");
    for segment in &transcription.segments {
        let speaker_name = transcription.speaker_map
            .get(&segment.speaker_id)
            .unwrap_or(&segment.speaker_name);
        
        markdown.push_str(&format!(
            "**{}** `[{:02}:{:02}]`\n{}\n\n",
            speaker_name,
            (segment.start_time as u32) / 60,
            (segment.start_time as u32) % 60,
            segment.text
        ));
    }
    
    // Write to file
    tokio::fs::write(&output_path, markdown).await?;
    
    Ok(output_path)
}
```

---

## Migration Notes

The application has successfully migrated from Avalonia/.NET to Tauri/React. The new architecture provides:

- **Better UI/UX**: Modern React components with smooth Tailwind CSS styling
- **Improved Performance**: Native Rust backend with async/await for system operations
- **Cross-platform Ready**: Tauri supports Windows, macOS, and Linux
- **Smaller Bundle**: Single executable instead of .NET runtime dependency
- **Web Technologies**: Leverage rich React ecosystem and community support

### Key Technology Decisions

| Aspect | Technology | Reason |
|--------|-----------|--------|
| **Frontend** | React + TypeScript | Modern, reactive UI framework |
| **Styling** | Tailwind CSS | Utility-first, rapid development |
| **State** | Zustand | Lightweight, minimal boilerplate |
| **Desktop** | Tauri + Rust | Native performance, small footprint |
| **Audio** | CPAL + hound | Cross-platform, Rust-native |
| **Auth** | MSAL React | Enterprise Azure integration |
| **Build** | Vite | Fast HMR, optimized builds |

### Performance Considerations

1. **Audio Buffering**: Use appropriate buffer sizes (512-2048 samples)
2. **Transcription**: Process in chunks for long recordings
3. **UI Responsiveness**: Offload heavy operations to Rust backend
4. **Memory Management**: Stream large audio files rather than loading entirely
5. **Token Refresh**: Implement background token refresh logic

### Security Best Practices

1. **Never commit secrets** to version control
2. **Use environment variables** for API keys
3. **Validate all user inputs** before processing
4. **Sanitize file paths** to prevent directory traversal
5. **Implement HTTPS** for all Azure API calls
6. **Encrypt tokens** at rest using Tauri's secure storage
7. **Follow principle of least privilege** for file system access

---

## Appendix: API References

### Azure Speech Service API

**REST Endpoint:**
```
POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
```

**Headers:**
```
Ocp-Apim-Subscription-Key: {subscription_key}
Content-Type: audio/wav; codecs=audio/pcm; samplerate=16000
```

### Azure AI Inference API

**REST Endpoint:**
```
POST {endpoint}/chat/completions
```

**Headers:**
```
api-key: {api_key}
Content-Type: application/json
```

**Request Body:**
```json
{
  "messages": [
    {"role": "user", "content": "prompt"}
  ],
  "max_tokens": 2048,
  "temperature": 0.3,
  "top_p": 0.1
}
```

---

## Implementation Status

### ✅ Completed Components

- **Project Setup**: Tauri 2.9 + React 18 + Vite 7 configured
- **Build System**: TypeScript, Tailwind CSS, PostCSS configured
- **Authentication UI**: Login screen with MSAL integration
- **State Management**: Zustand stores for auth, meetings, theme
- **Main Layout**: 3-tab main application interface (Recording, Recordings, Summary)
- **Recording Tab UI**: Simplified 3-state UX (idle → recording → saving) with language selector, start/stop buttons, and post-recording name/tag form
- **Recordings Tab UI**: Meeting list display with metadata and optional tags
- **Summary Tab UI**: Summary generation interface with style selection
- **Settings Modal**: User preferences and configuration
- **Theme System**: Dark/light mode with system preference detection
- **Application Icons**: Multi-resolution icons for Windows packaging
- **Audio Recording Backend**: CPAL 0.16 integration for Windows WASAPI input capture with async Tokio runtime
- **WAV File Writing**: hound 3.5 crate for 16-bit PCM WAV file storage
- **Audio Level Monitoring**: Real-time RMS level calculation with std::sync::Mutex for thread-safe updates
- **Tauri Commands**: IPC bridges (`start_recording`, `stop_recording`, `get_audio_level`, `test_audio_devices`, `set_recording_mode`, `get_recording_mode`, `get_audio_devices`, `transcribe_audio`, `transcribe_audio_with_config`, `configure_transcription`, `configure_summary`, `generate_summary`, `generate_summary_with_config`, `is_summary_configured`, `export_full_transcript`, `export_summary_file`, `export_transcript_only`, `generate_markdown_content`, `export_to_path`, `get_export_directory`) with proper async/blocking separation
- **Waveform Visualizer**: Real-time audio level visualization component
- **WASAPI Loopback Capture**: Native Windows WASAPI loopback capture for system audio recording (what you hear through speakers/headphones). Supports multiple audio formats (16-bit, 24-bit, 32-bit integer and float), automatic format conversion to 16-bit WAV, and real-time audio level monitoring.
- **Transcription Service**: Azure Speech Service REST API integration with support for short (<60s) and long audio files via chunked processing. Includes word-level timestamps, confidence scoring, and automatic WAV parsing.
- **AI Summary Service**: Azure AI Inference (Mistral-Large-3) integration with 4 summary styles (Comprehensive, Bullet Points, Executive Brief, Action Items). Includes configurable temperature, top-p, and max tokens. Frontend hook (`useSummary`) for React integration.
- **Speaker Identification**: Speaker diarization service with Azure Speech Service integration. Includes pause-based speaker detection, speaker mapping UI for renaming speakers (e.g., "Speaker1" → "Alice"), diarized transcript display with speaker colors, and Markdown export with speaker attribution. Frontend hook (`useDiarization`) and components (`SpeakerMappingPanel`, `DiarizedTranscript`) for React integration.
- **Markdown Export**: Full transcript and summary export with formatting. Includes ExportService in Rust backend with file writing, frontend `useExport` hook, file save dialog integration, quick export to default Recordings folder, copy to clipboard, and proper file naming (YYYY-MM-DD_HHMM_Title.md). Supports three export types: full (metadata + summary + transcript), summary-only, and transcript-only.

### 🚧 In Progress

- **Frontend-Backend Integration**: Testing end-to-end recording and transcription flow with IPC

### ⏳ Planned Features

- **Meeting Storage**: Local meeting history and metadata persistence with file system
- **Meeting List**: Load and display recorded meetings from storage
- **Error Handling**: Comprehensive error management and user-friendly recovery
- **Logging**: Diagnostic logging for troubleshooting
- **Performance**: Memory and CPU optimization for long recordings

## Conclusion

**SealedScribe** is now built on a modern, performant architecture using Tauri and React. The application provides:

- **SSO Authentication** with Azure AD using MSAL for React
- **Desktop Audio Recording** using CPAL with WASAPI loopback (Windows)
- **Real-time Processing** with Rust async runtime (Tokio)
- **Azure Speech Service** integration for transcription
- **Azure AI Inference** for multi-style meeting summaries
- **Professional UI** with Tailwind CSS and Framer Motion animations
- **Cross-platform Ready** architecture supporting Windows, macOS, and Linux

The new stack maintains all planned core functionality while providing superior performance, smaller footprint, and leveraging modern web technologies for rapid development.

---

## Tray, démarrage Windows et jobs de traitement

### 1. Présence dans la barre des tâches (system tray)
- Icône SealedScribe dans la zone de notification, avec tooltip `SealedScribe` (ou `SealedScribe — enregistrement en cours`).
- Menu contextuel : **Afficher SealedScribe**, **Démarrer l'enregistrement** / **Arrêter l'enregistrement** (libellé mis à jour selon l'état), séparateur, **Quitter**.
- Clic gauche sur l'icône : affiche la fenêtre principale.
- Fermer la fenêtre (croix) la masque sans quitter l'application. Seul **Quitter** ferme l'app.
- Quitter pendant un enregistrement : l'enregistrement est arrêté proprement (fichier WAV finalisé) avant la sortie.

### 2. Démarrage avec Windows
- Réglage « Lancer SealedScribe au démarrage de Windows » dans les préférences, **désactivé par défaut**.
- Implémenté via `tauri-plugin-autostart` (entrée `HKCU\...\Run`, sans droits admin). L'état réel est celui du système.
- Le lancement automatique passe `--minimized` : la fenêtre reste masquée, seule l'icône tray apparaît.

### 3. Règle de sécurité : aucun enregistrement au démarrage
- Au démarrage (automatique ou manuel), **aucun flux audio n'est ouvert**. Le micro et le loopback ne sont ouverts que sur action explicite de l'utilisateur (bouton de la fenêtre ou entrée du tray).
- Aucun composant ne démarre l'enregistrement au montage.
- Un seul point d'entrée : le bouton du tray émet `tray-toggle-recording`, traité par le même handler que le bouton de la fenêtre.
- L'état d'enregistrement est renvoyé au tray (`set_tray_recording`) pour garder le libellé et le tooltip synchronisés.

### 4. Jobs de traitement (transcription)
- Chaque transcription est un **job** : `id`, `kind`, `label` (nom du fichier), `status`, `progress` (0-100, réel), `message`, `error`, `startedAt`, `updatedAt`.
- Statuts : `running`, `done`, `failed`, `cancelled`, `interrupted`.
- Progression réelle émise via l'événement `job-updated` (et `transcription-progress` conservé pour compatibilité).
- **Annulation** : la commande `cancel_job` lève un drapeau ; la boucle de chunks s'arrête avant d'envoyer de nouveaux chunks et abandonne les requêtes en vol.
- **Persistance** : liste des jobs dans `%LOCALAPPDATA%\MeetScribe\jobs.json` (50 derniers conservés).
- **Redémarrage** : un job resté `running` (app fermée en cours de traitement) passe à `interrupted`.
- Commandes : `list_jobs`, `cancel_job`, `transcribe_audio` et `transcribe_audio_with_config` acceptent un `jobId`.

### Hors périmètre de cette version
- Progression réelle pour le résumé et la diarisation (aujourd'hui simulée côté client) : à faire.
- Notifications système à la fin d'un traitement (plugin de notification) : à faire.
- Reprise d'un job interrompu : à faire (le fichier audio reste disponible).
