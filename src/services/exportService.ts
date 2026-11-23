/**
 * Export Service - Handles Markdown export of meeting transcripts and summaries
 */

import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { MeetingSession, MeetingDiarization } from '../store/meetingStore';
import { speakerName } from '../utils/speakers';

// Types matching Rust backend
export interface MeetingSessionBackend {
  id: string;
  title: string;
  language: string;
  duration: number;
  recorded_at: string;
  status: 'stopped' | 'recording' | 'processing' | 'completed';
  audio_path?: string;
  speakers: { label: number; name: string }[];
}

export interface DiarizationResultBackend {
  segments: {
    text: string;
    speaker_id: string;
    speaker_name: string;
    start_time: number;
    end_time: number;
    confidence: number;
    language: string;
  }[];
  speakers: {
    speaker_id: string;
    display_name: string;
    total_speaking_time: number;
    segment_count: number;
  }[];
  full_text: string;
  language: string;
  duration_seconds: number;
}

export interface SummaryResultBackend {
  summary: string;
  style: string;
  tokens_used?: number;
  model: string;
}

export interface ExportResult {
  filePath: string;
  fileSize: number;
  exportType: string;
}

export type ExportType = 'full' | 'summary' | 'transcript';

/**
 * Convert frontend MeetingSession to backend format
 */
function toBackendSession(session: MeetingSession): MeetingSessionBackend {
  const backendStatus = session.status === 'failed' ? 'completed' : session.status;

  return {
    id: session.id,
    title: session.title,
    language: session.language,
    duration: session.duration,
    recorded_at: session.recordedAt instanceof Date 
      ? session.recordedAt.toISOString() 
      : new Date(session.recordedAt).toISOString(),
    status: backendStatus,
    audio_path: session.audioPath,
    speakers: session.speakers.map(s => ({ label: s.label, name: s.name })),
  };
}

/**
 * Diarisation construite à partir de la transcription active.
 * `session.diarization` n'est jamais renseignée : sans ce repli, le backend
 * exporterait « No transcript available ».
 */
export function diarizationFromTranscription(session: MeetingSession): MeetingDiarization | undefined {
  const segments = session.transcription?.segments;
  if (!segments?.length) return undefined;
  const nameOf = (label: number) => speakerName(label, session.speakers);
  const speakers = new Map<number, { time: number; count: number }>();
  for (const seg of segments) {
    const stats = speakers.get(seg.speaker) ?? { time: 0, count: 0 };
    stats.time += Math.max(0, seg.endTime - seg.startTime);
    stats.count += 1;
    speakers.set(seg.speaker, stats);
  }
  return {
    sessionId: session.id,
    segments: segments.map((seg) => ({
      text: seg.text,
      speakerId: String(seg.speaker),
      speakerName: nameOf(seg.speaker),
      startTime: seg.startTime,
      endTime: seg.endTime,
      confidence: seg.confidence,
      language: seg.language,
    })),
    speakers: [...speakers.entries()].map(([label, stats]) => ({
      speakerId: String(label),
      displayName: nameOf(label),
      totalSpeakingTime: stats.time,
      segmentCount: stats.count,
    })),
    fullText: segments.map((seg) => seg.text).join(' '),
    language: session.language,
    durationSeconds: session.duration,
  };
}

/** Diarisation fournie, sinon celle déduite de la transcription active. */
function effectiveDiarization(session: MeetingSession, diarization?: MeetingDiarization) {
  const d = diarization ?? diarizationFromTranscription(session);
  return d ? toBackendDiarization(d) : null;
}

/**
 * Convert frontend MeetingDiarization to backend format
 */
function toBackendDiarization(diarization: MeetingDiarization): DiarizationResultBackend {
  return {
    segments: diarization.segments.map(seg => ({
      text: seg.text,
      speaker_id: seg.speakerId,
      speaker_name: seg.speakerName,
      start_time: seg.startTime,
      end_time: seg.endTime,
      confidence: seg.confidence,
      language: seg.language,
    })),
    speakers: diarization.speakers.map(spk => ({
      speaker_id: spk.speakerId,
      display_name: spk.displayName,
      total_speaking_time: spk.totalSpeakingTime,
      segment_count: spk.segmentCount,
    })),
    full_text: diarization.fullText,
    language: diarization.language,
    duration_seconds: diarization.durationSeconds,
  };
}

/**
 * Export full meeting transcript (with summary and transcript)
 */
export async function exportFullTranscript(
  session: MeetingSession,
  diarization?: MeetingDiarization,
  summary?: { summary: string; style: string; tokensUsed?: number; model?: string },
  outputDirectory?: string
): Promise<ExportResult> {
  const backendSession = toBackendSession(session);
  const backendDiarization = effectiveDiarization(session, diarization);
  const backendSummary = summary ? {
    summary: summary.summary,
    style: summary.style,
    tokens_used: summary.tokensUsed,
    model: summary.model || 'Azure AI',
  } : null;

  // Get default export directory if not provided
  const exportDir = outputDirectory || await getExportDirectory();

  return invoke<ExportResult>('export_full_transcript', {
    session: backendSession,
    diarization: backendDiarization,
    summary: backendSummary,
    outputDirectory: exportDir,
  });
}

/**
 * Export summary only
 */
export async function exportSummaryFile(
  session: MeetingSession,
  summary: { summary: string; style: string; tokensUsed?: number; model?: string },
  outputDirectory?: string
): Promise<ExportResult> {
  const backendSession = toBackendSession(session);
  const backendSummary = {
    summary: summary.summary,
    style: summary.style,
    tokens_used: summary.tokensUsed,
    model: summary.model || 'Azure AI',
  };

  const exportDir = outputDirectory || await getExportDirectory();

  return invoke<ExportResult>('export_summary_file', {
    session: backendSession,
    summary: backendSummary,
    outputDirectory: exportDir,
  });
}

/**
 * Export transcript only (without summary)
 */
export async function exportTranscriptOnly(
  session: MeetingSession,
  diarization: MeetingDiarization,
  outputDirectory?: string
): Promise<ExportResult> {
  const backendSession = toBackendSession(session);
  const backendDiarization = toBackendDiarization(diarization);

  const exportDir = outputDirectory || await getExportDirectory();

  return invoke<ExportResult>('export_transcript_only', {
    session: backendSession,
    diarization: backendDiarization,
    outputDirectory: exportDir,
  });
}

/**
 * Generate Markdown content as string (for clipboard)
 */
export async function generateMarkdownContent(
  session: MeetingSession,
  diarization?: MeetingDiarization,
  summary?: { summary: string; style: string; tokensUsed?: number; model?: string },
  includeSummary: boolean = true,
  includeTranscript: boolean = true
): Promise<string> {
  const backendSession = toBackendSession(session);
  const backendDiarization = effectiveDiarization(session, diarization);
  const backendSummary = summary ? {
    summary: summary.summary,
    style: summary.style,
    tokens_used: summary.tokensUsed,
    model: summary.model || 'Azure AI',
  } : null;

  return invoke<string>('generate_markdown_content', {
    session: backendSession,
    diarization: backendDiarization,
    summary: backendSummary,
    includeSummary,
    includeTranscript,
  });
}

/**
 * Export to a custom path with file dialog
 */
export async function exportWithDialog(
  session: MeetingSession,
  exportType: ExportType = 'full',
  diarization?: MeetingDiarization,
  summary?: { summary: string; style: string; tokensUsed?: number; model?: string }
): Promise<ExportResult | null> {
  // Generate default filename
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5).replace(':', '');
  const safeTitle = session.title.replace(/[^a-zA-Z0-9 _-]/g, '_').replace(/ /g, '_');
  
  let suffix = '';
  if (exportType === 'summary') suffix = '_summary';
  else if (exportType === 'transcript') suffix = '_transcript';
  
  const defaultFilename = `${dateStr}_${timeStr}_${safeTitle}${suffix}.md`;

  // Open save dialog
  const filePath = await save({
    defaultPath: defaultFilename,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });

  if (!filePath) {
    return null; // User cancelled
  }

  // Le backend n'écrit que des fichiers .md : on complète l'extension si l'utilisateur l'a omise.
  const outputPath = /\.md$/i.test(filePath) ? filePath : `${filePath}.md`;

  const backendSession = toBackendSession(session);
  const backendDiarization = effectiveDiarization(session, diarization);
  const backendSummary = summary ? {
    summary: summary.summary,
    style: summary.style,
    tokens_used: summary.tokensUsed,
    model: summary.model || 'Azure AI',
  } : null;

  return invoke<ExportResult>('export_to_path', {
    session: backendSession,
    diarization: backendDiarization,
    summary: backendSummary,
    outputPath,
    exportType,
  });
}

/**
 * Get the default export directory
 */
export async function getExportDirectory(): Promise<string> {
  return invoke<string>('get_export_directory');
}

/**
 * Copy Markdown to clipboard (frontend fallback when backend not available)
 */
export function generateMarkdownFallback(
  session: MeetingSession,
  diarization?: MeetingDiarization,
  summary?: { summary: string; style: string }
): string {
  let markdown = `# ${session.title}\n\n`;
  
  // Metadata
  const recordedAt = session.recordedAt instanceof Date 
    ? session.recordedAt 
    : new Date(session.recordedAt);
  markdown += `**Date:** ${recordedAt.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}  \n`;
  markdown += `**Language:** ${getLanguageName(session.language)}  \n`;
  markdown += `**Duration:** ${formatDuration(session.duration)}  \n\n`;
  
  // Participants
  if (diarization && diarization.speakers.length > 0) {
    markdown += '## Participants\n\n';
    for (const speaker of diarization.speakers) {
      markdown += `- **${speaker.displayName}** (${speaker.segmentCount} segments, ${formatDuration(speaker.totalSpeakingTime)} speaking time)\n`;
    }
    markdown += '\n';
  } else if (session.speakers.length > 0) {
    markdown += '## Participants\n\n';
    for (const speaker of session.speakers) {
      markdown += `- **${speaker.name}** (Speaker ${speaker.label})\n`;
    }
    markdown += '\n';
  }
  
  // Summary
  if (summary) {
    markdown += '## Summary\n\n';
    markdown += summary.summary;
    markdown += '\n\n';
  }
  
  // Transcript
  if (diarization && diarization.segments.length > 0) {
    markdown += '## Transcript\n\n';
    for (const segment of diarization.segments) {
      const timestamp = formatTimestamp(segment.startTime);
      markdown += `**${segment.speakerName}** \`[${timestamp}]\`\n${segment.text}\n\n`;
    }
  }
  
  // Footer
  markdown += '---\n';
  markdown += `*Generated by SealedScribe on ${new Date().toLocaleDateString()}*\n`;
  
  return markdown;
}

// Helper functions
function formatDuration(seconds: number): string {
  const totalSecs = Math.floor(seconds);
  const hours = Math.floor(totalSecs / 3600);
  const minutes = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  
  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatTimestamp(seconds: number): string {
  const totalSecs = Math.floor(seconds);
  const minutes = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function getLanguageName(code: string): string {
  const languages: Record<string, string> = {
    'en-US': 'English (US)',
    'fr-FR': 'French (France)',
    'de-DE': 'German (Germany)',
    'es-ES': 'Spanish (Spain)',
    'it-IT': 'Italian (Italy)',
    'pt-BR': 'Portuguese (Brazil)',
    'ja-JP': 'Japanese (Japan)',
    'ko-KR': 'Korean (Korea)',
    'zh-CN': 'Chinese (Simplified)',
  };
  return languages[code] || code;
}
