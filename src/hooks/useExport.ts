/**
 * useExport Hook - React hook for exporting meeting data to Markdown
 */

import { translate } from '../i18n';
import { useState, useCallback } from 'react';
import { MeetingSession, MeetingDiarization } from '../store/meetingStore';
import {
  diarizationFromTranscription,
  exportFullTranscript,
  exportSummaryFile,
  exportTranscriptOnly,
  exportWithDialog,
  generateMarkdownContent,
  generateMarkdownFallback,
  getExportDirectory,
  ExportResult,
  ExportType,
} from '../services/exportService';

interface UseExportReturn {
  // State
  isExporting: boolean;
  lastExport: ExportResult | null;
  error: string | null;
  
  // Actions
  exportFull: (
    session: MeetingSession,
    diarization?: MeetingDiarization,
    summary?: SummaryData,
    outputDirectory?: string
  ) => Promise<ExportResult | null>;
  
  exportSummary: (
    session: MeetingSession,
    summary: SummaryData,
    outputDirectory?: string
  ) => Promise<ExportResult | null>;
  
  exportTranscript: (
    session: MeetingSession,
    diarization: MeetingDiarization,
    outputDirectory?: string
  ) => Promise<ExportResult | null>;
  
  exportWithSaveDialog: (
    session: MeetingSession,
    exportType?: ExportType,
    diarization?: MeetingDiarization,
    summary?: SummaryData
  ) => Promise<ExportResult | null>;
  
  copyToClipboard: (
    session: MeetingSession,
    diarization?: MeetingDiarization,
    summary?: SummaryData,
    includeSummary?: boolean,
    includeTranscript?: boolean
  ) => Promise<boolean>;
  
  getDefaultDirectory: () => Promise<string>;
  
  clearError: () => void;
}

interface SummaryData {
  summary: string;
  style: string;
  tokensUsed?: number;
  model?: string;
}

/**
 * Hook for exporting meeting data to Markdown files
 */
export function useExport(): UseExportReturn {
  const [isExporting, setIsExporting] = useState(false);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  /**
   * Export full meeting (metadata + summary + transcript)
   */
  const exportFull = useCallback(async (
    session: MeetingSession,
    diarization?: MeetingDiarization,
    summary?: SummaryData,
    outputDirectory?: string
  ): Promise<ExportResult | null> => {
    setIsExporting(true);
    setError(null);
    
    try {
      const result = await exportFullTranscript(session, diarization, summary, outputDirectory);
      setLastExport(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : translate('export.failed');
      setError(message);
      console.error('[useExport] Export full error:', err);
      return null;
    } finally {
      setIsExporting(false);
    }
  }, []);

  /**
   * Export summary only
   */
  const exportSummary = useCallback(async (
    session: MeetingSession,
    summary: SummaryData,
    outputDirectory?: string
  ): Promise<ExportResult | null> => {
    setIsExporting(true);
    setError(null);
    
    try {
      const result = await exportSummaryFile(session, summary, outputDirectory);
      setLastExport(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : translate('export.failed');
      setError(message);
      console.error('[useExport] Export summary error:', err);
      return null;
    } finally {
      setIsExporting(false);
    }
  }, []);

  /**
   * Export transcript only (no summary)
   */
  const exportTranscript = useCallback(async (
    session: MeetingSession,
    diarization: MeetingDiarization,
    outputDirectory?: string
  ): Promise<ExportResult | null> => {
    setIsExporting(true);
    setError(null);
    
    try {
      const result = await exportTranscriptOnly(session, diarization, outputDirectory);
      setLastExport(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : translate('export.failed');
      setError(message);
      console.error('[useExport] Export transcript error:', err);
      return null;
    } finally {
      setIsExporting(false);
    }
  }, []);

  /**
   * Export with file save dialog
   */
  const exportWithSaveDialog = useCallback(async (
    session: MeetingSession,
    exportType: ExportType = 'full',
    diarization?: MeetingDiarization,
    summary?: SummaryData
  ): Promise<ExportResult | null> => {
    setIsExporting(true);
    setError(null);
    
    try {
      const result = await exportWithDialog(session, exportType, diarization, summary);
      if (result) {
        setLastExport(result);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : translate('export.failed');
      setError(message);
      console.error('[useExport] Export with dialog error:', err);
      return null;
    } finally {
      setIsExporting(false);
    }
  }, []);

  /**
   * Copy Markdown content to clipboard
   */
  const copyToClipboard = useCallback(async (
    session: MeetingSession,
    diarization?: MeetingDiarization,
    summary?: SummaryData,
    includeSummary: boolean = true,
    includeTranscript: boolean = true
  ): Promise<boolean> => {
    setError(null);
    
    try {
      let markdown: string;
      
      try {
        // Try to use backend for generation
        markdown = await generateMarkdownContent(
          session,
          diarization,
          summary,
          includeSummary,
          includeTranscript
        );
      } catch {
        // Fall back to frontend generation
        console.warn('[useExport] Backend unavailable, using frontend fallback');
        markdown = generateMarkdownFallback(
          session,
          includeTranscript ? diarization ?? diarizationFromTranscription(session) : undefined,
          includeSummary ? summary : undefined
        );
      }
      
      await navigator.clipboard.writeText(markdown);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : translate('export.copyFailed');
      setError(message);
      console.error('[useExport] Copy to clipboard error:', err);
      return false;
    }
  }, []);

  /**
   * Get the default export directory
   */
  const getDefaultDirectory = useCallback(async (): Promise<string> => {
    try {
      return await getExportDirectory();
    } catch (err) {
      console.error('[useExport] Failed to get export directory:', err);
      // Return a reasonable fallback
      return './Recordings';
    }
  }, []);

  return {
    isExporting,
    lastExport,
    error,
    exportFull,
    exportSummary,
    exportTranscript,
    exportWithSaveDialog,
    copyToClipboard,
    getDefaultDirectory,
    clearError,
  };
}
