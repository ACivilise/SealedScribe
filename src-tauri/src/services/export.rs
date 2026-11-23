use crate::error::{AppError, AppResult};
use crate::models::{
    DiarizationResult, MeetingSession, SummaryResult,
};
use chrono::{DateTime, Local};
use std::path::{Path, PathBuf};

/// Service for exporting meeting data to Markdown files
pub struct ExportService;

/// Represents a full meeting export with all associated data
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingExportData {
    /// Meeting session metadata
    pub session: MeetingSession,
    /// Optional diarization result with transcription
    pub diarization: Option<DiarizationResult>,
    /// Optional AI-generated summary
    pub summary: Option<SummaryResult>,
}

/// Result of an export operation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// Path to the exported file
    pub file_path: String,
    /// Size of the exported file in bytes
    pub file_size: u64,
    /// Type of export (transcript, summary, full)
    pub export_type: String,
}

impl ExportService {
    /// Create a new ExportService
    pub fn new() -> Self {
        Self
    }

    /// Generate a filename based on meeting data and current timestamp
    /// 
    /// Format: YYYY-MM-DD_HHMM_MeetingTitle.md
    pub fn generate_filename(title: &str, suffix: Option<&str>) -> String {
        let now = Local::now();
        let date_str = now.format("%Y-%m-%d_%H%M").to_string();
        
        // Sanitize title for filename
        let safe_title: String = title
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>()
            .replace(' ', "_");
        
        // Truncate if too long
        let safe_title = if safe_title.len() > 50 {
            safe_title[..50].to_string()
        } else {
            safe_title
        };
        
        match suffix {
            Some(s) => format!("{}_{}{}.md", date_str, safe_title, s),
            None => format!("{}_{}.md", date_str, safe_title),
        }
    }

    /// Format a duration in seconds to MM:SS or HH:MM:SS format
    fn format_duration(seconds: f64) -> String {
        let total_secs = seconds as u32;
        let hours = total_secs / 3600;
        let minutes = (total_secs % 3600) / 60;
        let secs = total_secs % 60;
        
        if hours > 0 {
            format!("{:02}:{:02}:{:02}", hours, minutes, secs)
        } else {
            format!("{:02}:{:02}", minutes, secs)
        }
    }

    /// Format a timestamp in seconds to [MM:SS] format
    fn format_timestamp(seconds: f64) -> String {
        let total_secs = seconds as u32;
        let minutes = total_secs / 60;
        let secs = total_secs % 60;
        format!("{:02}:{:02}", minutes, secs)
    }

    /// Get language display name from code
    fn get_language_name(code: &str) -> &str {
        match code {
            "en-US" => "English (US)",
            "fr-FR" => "French (France)",
            "de-DE" => "German (Germany)",
            "es-ES" => "Spanish (Spain)",
            "it-IT" => "Italian (Italy)",
            "pt-BR" => "Portuguese (Brazil)",
            "ja-JP" => "Japanese (Japan)",
            "ko-KR" => "Korean (Korea)",
            "zh-CN" => "Chinese (Simplified)",
            _ => code,
        }
    }

    /// Export full meeting transcript as Markdown
    /// 
    /// Includes metadata, participants, summary, and full transcript
    pub async fn export_full_transcript(
        &self,
        data: &MeetingExportData,
        output_path: &Path,
    ) -> AppResult<ExportResult> {
        let mut markdown = String::new();
        
        // Header
        markdown.push_str(&format!("# {}\n\n", data.session.title));
        
        // Metadata section
        let recorded_at: DateTime<Local> = data.session.recorded_at.with_timezone(&Local);
        markdown.push_str(&format!(
            "**Date:** {}  \n",
            recorded_at.format("%B %d, %Y at %H:%M")
        ));
        markdown.push_str(&format!(
            "**Language:** {}  \n",
            Self::get_language_name(&data.session.language)
        ));
        markdown.push_str(&format!(
            "**Duration:** {}  \n\n",
            Self::format_duration(data.session.duration as f64)
        ));
        
        // Participants section
        if let Some(ref diarization) = data.diarization {
            if !diarization.speakers.is_empty() {
                markdown.push_str("## Participants\n\n");
                for speaker in &diarization.speakers {
                    let speaking_time = Self::format_duration(speaker.total_speaking_time);
                    markdown.push_str(&format!(
                        "- **{}** ({} segments, {} speaking time)\n",
                        speaker.display_name, speaker.segment_count, speaking_time
                    ));
                }
                markdown.push('\n');
            }
        } else if !data.session.speakers.is_empty() {
            markdown.push_str("## Participants\n\n");
            for speaker in &data.session.speakers {
                markdown.push_str(&format!("- **{}** (Speaker {})\n", speaker.name, speaker.label));
            }
            markdown.push('\n');
        }
        
        // Summary section
        if let Some(ref summary) = data.summary {
            markdown.push_str("## Summary\n\n");
            markdown.push_str(&summary.summary);
            markdown.push_str("\n\n");
        }
        
        // Transcript section
        markdown.push_str("## Transcript\n\n");
        
        if let Some(ref diarization) = data.diarization {
            // Use diarization segments (preferred)
            for segment in &diarization.segments {
                markdown.push_str(&format!(
                    "**{}** `[{}]`\n{}\n\n",
                    segment.speaker_name,
                    Self::format_timestamp(segment.start_time),
                    segment.text
                ));
            }
        } else if let Some(full_text) = self.get_session_transcript(&data.session) {
            // Fall back to basic transcript
            markdown.push_str(&full_text);
            markdown.push('\n');
        } else {
            markdown.push_str("*No transcript available.*\n\n");
        }
        
        // Footer
        markdown.push_str("---\n");
        markdown.push_str(&format!(
            "*Generated by SealedScribe on {}*\n",
            Local::now().format("%Y-%m-%d %H:%M")
        ));
        
        // Write to file
        tokio::fs::write(&output_path, &markdown)
            .await
            .map_err(|e| AppError::FileError(e))?;
        
        let metadata = tokio::fs::metadata(&output_path)
            .await
            .map_err(|e| AppError::FileError(e))?;
        
        Ok(ExportResult {
            file_path: output_path.to_string_lossy().to_string(),
            file_size: metadata.len(),
            export_type: "full".to_string(),
        })
    }

    /// Export summary only as Markdown
    pub async fn export_summary(
        &self,
        data: &MeetingExportData,
        output_path: &Path,
    ) -> AppResult<ExportResult> {
        let mut markdown = String::new();
        
        // Header
        markdown.push_str(&format!("# {} - Summary\n\n", data.session.title));
        
        // Metadata
        let recorded_at: DateTime<Local> = data.session.recorded_at.with_timezone(&Local);
        markdown.push_str(&format!(
            "**Date:** {}  \n",
            recorded_at.format("%B %d, %Y at %H:%M")
        ));
        markdown.push_str(&format!(
            "**Language:** {}  \n\n",
            Self::get_language_name(&data.session.language)
        ));
        
        // Summary content
        if let Some(ref summary) = data.summary {
            markdown.push_str("## Key Points\n\n");
            markdown.push_str(&summary.summary);
            markdown.push_str("\n\n");
            
            if let Some(style) = Some(&summary.style) {
                markdown.push_str(&format!("*Summary Style: {}*\n\n", style));
            }
        } else {
            markdown.push_str("*No summary available.*\n\n");
        }
        
        // Footer
        markdown.push_str("---\n");
        markdown.push_str(&format!(
            "*Generated by SealedScribe on {}*\n",
            Local::now().format("%Y-%m-%d %H:%M")
        ));
        
        // Write to file
        tokio::fs::write(&output_path, &markdown)
            .await
            .map_err(|e| AppError::FileError(e))?;
        
        let metadata = tokio::fs::metadata(&output_path)
            .await
            .map_err(|e| AppError::FileError(e))?;
        
        Ok(ExportResult {
            file_path: output_path.to_string_lossy().to_string(),
            file_size: metadata.len(),
            export_type: "summary".to_string(),
        })
    }

    /// Export transcript only (without summary) as Markdown
    pub async fn export_transcript_only(
        &self,
        data: &MeetingExportData,
        output_path: &Path,
    ) -> AppResult<ExportResult> {
        let mut markdown = String::new();
        
        // Header
        markdown.push_str(&format!("# {} - Transcript\n\n", data.session.title));
        
        // Metadata
        let recorded_at: DateTime<Local> = data.session.recorded_at.with_timezone(&Local);
        markdown.push_str(&format!(
            "**Date:** {}  \n",
            recorded_at.format("%B %d, %Y at %H:%M")
        ));
        markdown.push_str(&format!(
            "**Language:** {}  \n",
            Self::get_language_name(&data.session.language)
        ));
        markdown.push_str(&format!(
            "**Duration:** {}  \n\n",
            Self::format_duration(data.session.duration as f64)
        ));
        
        // Participants
        if let Some(ref diarization) = data.diarization {
            if !diarization.speakers.is_empty() {
                markdown.push_str("## Participants\n\n");
                for speaker in &diarization.speakers {
                    markdown.push_str(&format!("- **{}**\n", speaker.display_name));
                }
                markdown.push('\n');
            }
        }
        
        // Transcript
        markdown.push_str("## Transcript\n\n");
        
        if let Some(ref diarization) = data.diarization {
            for segment in &diarization.segments {
                markdown.push_str(&format!(
                    "**{}** `[{}]`\n{}\n\n",
                    segment.speaker_name,
                    Self::format_timestamp(segment.start_time),
                    segment.text
                ));
            }
        } else {
            markdown.push_str("*No transcript available.*\n\n");
        }
        
        // Footer
        markdown.push_str("---\n");
        markdown.push_str(&format!(
            "*Generated by SealedScribe on {}*\n",
            Local::now().format("%Y-%m-%d %H:%M")
        ));
        
        // Write to file
        tokio::fs::write(&output_path, &markdown)
            .await
            .map_err(|e| AppError::FileError(e))?;
        
        let metadata = tokio::fs::metadata(&output_path)
            .await
            .map_err(|e| AppError::FileError(e))?;
        
        Ok(ExportResult {
            file_path: output_path.to_string_lossy().to_string(),
            file_size: metadata.len(),
            export_type: "transcript".to_string(),
        })
    }

    /// Generate Markdown content as a string (for clipboard)
    pub fn generate_markdown_string(
        &self,
        data: &MeetingExportData,
        include_summary: bool,
        include_transcript: bool,
    ) -> String {
        let mut markdown = String::new();
        
        // Header
        markdown.push_str(&format!("# {}\n\n", data.session.title));
        
        // Metadata
        let recorded_at: DateTime<Local> = data.session.recorded_at.with_timezone(&Local);
        markdown.push_str(&format!(
            "**Date:** {}  \n",
            recorded_at.format("%B %d, %Y at %H:%M")
        ));
        markdown.push_str(&format!(
            "**Language:** {}  \n",
            Self::get_language_name(&data.session.language)
        ));
        markdown.push_str(&format!(
            "**Duration:** {}  \n\n",
            Self::format_duration(data.session.duration as f64)
        ));
        
        // Participants
        if let Some(ref diarization) = data.diarization {
            if !diarization.speakers.is_empty() {
                markdown.push_str("## Participants\n\n");
                for speaker in &diarization.speakers {
                    let speaking_time = Self::format_duration(speaker.total_speaking_time);
                    markdown.push_str(&format!(
                        "- **{}** ({} segments, {} speaking time)\n",
                        speaker.display_name, speaker.segment_count, speaking_time
                    ));
                }
                markdown.push('\n');
            }
        } else if !data.session.speakers.is_empty() {
            markdown.push_str("## Participants\n\n");
            for speaker in &data.session.speakers {
                markdown.push_str(&format!("- **{}** (Speaker {})\n", speaker.name, speaker.label));
            }
            markdown.push('\n');
        }
        
        // Summary
        if include_summary {
            if let Some(ref summary) = data.summary {
                markdown.push_str("## Summary\n\n");
                markdown.push_str(&summary.summary);
                markdown.push_str("\n\n");
            }
        }
        
        // Transcript
        if include_transcript {
            markdown.push_str("## Transcript\n\n");
            
            if let Some(ref diarization) = data.diarization {
                for segment in &diarization.segments {
                    markdown.push_str(&format!(
                        "**{}** `[{}]`\n{}\n\n",
                        segment.speaker_name,
                        Self::format_timestamp(segment.start_time),
                        segment.text
                    ));
                }
            } else if let Some(full_text) = self.get_session_transcript(&data.session) {
                markdown.push_str(&full_text);
                markdown.push('\n');
            }
        }
        
        // Footer
        markdown.push_str("---\n");
        markdown.push_str(&format!(
            "*Generated by SealedScribe on {}*\n",
            Local::now().format("%Y-%m-%d %H:%M")
        ));
        
        markdown
    }

    /// Helper to extract transcript text from session (if no diarization available)
    fn get_session_transcript(&self, _session: &MeetingSession) -> Option<String> {
        // For now, return None as we'll use diarization data
        // This could be extended to read from session.transcription in the future
        None
    }

    /// Ensure directory exists and create it if needed
    pub async fn ensure_directory(&self, dir_path: &Path) -> AppResult<()> {
        if !dir_path.exists() {
            tokio::fs::create_dir_all(dir_path)
                .await
                .map_err(|e| AppError::FileError(e))?;
        }
        Ok(())
    }

    /// Get the full output path for an export
    pub fn get_output_path(&self, directory: &Path, filename: &str) -> PathBuf {
        directory.join(filename)
    }
}

impl Default for ExportService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_filename() {
        let filename = ExportService::generate_filename("Team Standup", None);
        assert!(filename.ends_with("_Team_Standup.md"));
        assert!(filename.contains("_"));
        
        let filename_summary = ExportService::generate_filename("Team Standup", Some("_summary"));
        assert!(filename_summary.ends_with("_Team_Standup_summary.md"));
    }

    #[test]
    fn test_sanitize_filename() {
        let filename = ExportService::generate_filename("Meeting: Q4 Review!", None);
        assert!(!filename.contains(":"));
        assert!(!filename.contains("!"));
    }

    #[test]
    fn test_format_duration() {
        assert_eq!(ExportService::format_duration(65.0), "01:05");
        assert_eq!(ExportService::format_duration(3725.0), "01:02:05");
        assert_eq!(ExportService::format_duration(45.0), "00:45");
    }

    #[test]
    fn test_format_timestamp() {
        assert_eq!(ExportService::format_timestamp(65.5), "01:05");
        assert_eq!(ExportService::format_timestamp(0.0), "00:00");
        assert_eq!(ExportService::format_timestamp(3599.0), "59:59");
    }
}
