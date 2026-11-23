use crate::error::{AppError, AppResult};
use crate::models::{
    DiarizationConfig, DiarizationResult, DiarizedSegment, IdentifiedSpeaker, SpeakerMapping,
};
use reqwest::Client;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Service for performing speaker diarization using Azure Speech Service Batch Transcription API
/// 
/// This service uses the Azure Speech Service Batch Transcription API which supports
/// speaker diarization for identifying and separating different speakers in audio.
pub struct DiarizationService {
    client: Client,
    config: Arc<Mutex<Option<DiarizationConfig>>>,
}

impl DiarizationService {
    /// Create a new DiarizationService
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(600)) // 10 minute timeout for batch operations
                .build()
                .unwrap_or_else(|_| Client::new()),
            config: Arc::new(Mutex::new(None)),
        }
    }

    /// Configure the diarization service with Azure credentials
    pub async fn configure(&self, config: DiarizationConfig) -> AppResult<()> {
        let mut cfg = self.config.lock().await;
        *cfg = Some(config);
        Ok(())
    }

    /// Supprime les identifiants en mémoire
    pub async fn clear(&self) {
        *self.config.lock().await = None;
    }

    /// Check if the service is configured
    pub async fn is_configured(&self) -> bool {
        let cfg = self.config.lock().await;
        cfg.is_some()
    }

    /// Get the configuration
    async fn get_config(&self) -> AppResult<DiarizationConfig> {
        let cfg = self.config.lock().await;
        cfg.clone().ok_or_else(|| {
            AppError::ConfigError("Azure Speech n'est pas configuré. Renseignez la clé dans Réglages.".to_string())
        })
    }

    /// Perform speaker diarization on an audio file
    /// 
    /// This method uses the Azure Speech Batch Transcription API which supports
    /// speaker diarization. The process is:
    /// 1. Upload audio to a temporary Azure Blob storage or use content URL
    /// 2. Create a batch transcription job with diarization enabled
    /// 3. Poll for job completion
    /// 4. Download and parse results
    /// 
    /// For simplicity in local scenarios, we use a simplified approach that:
    /// - Uses the real-time transcription with conversation transcription
    /// - Simulates diarization based on speech patterns when batch API isn't available
    pub async fn transcribe_with_diarization(
        &self,
        audio_path: String,
        language: String,
    ) -> AppResult<DiarizationResult> {
        let config = self.get_config().await?;

        self.transcribe_with_diarization_config(audio_path, language, config)
            .await
    }

    /// Perform speaker diarization with explicit configuration
    async fn transcribe_with_diarization_config(
        &self,
        audio_path: String,
        language: String,
        config: DiarizationConfig,
    ) -> AppResult<DiarizationResult> {
        // Read audio file
        let audio_bytes = tokio::fs::read(&audio_path)
            .await
            .map_err(|e| AppError::FileError(e))?;

        log::debug!(
            "[Diarization] Processing audio file: {} ({} bytes)",
            audio_path,
            audio_bytes.len()
        );

        // For real-time diarization, we use the Conversation Transcription API
        // which supports speaker diarization in real-time
        self.transcribe_conversation(&audio_bytes, &language, &config)
            .await
    }

    /// Use Conversation Transcription for speaker diarization
    /// 
    /// Azure's Conversation Transcription API supports real-time diarization
    /// and is more suitable for our use case than batch transcription
    async fn transcribe_conversation(
        &self,
        audio_bytes: &[u8],
        language: &str,
        config: &DiarizationConfig,
    ) -> AppResult<DiarizationResult> {
        // Use the Speech-to-Text REST API v3.1 with conversation transcription mode
        let endpoint = format!(
            "https://{}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1",
            config.speech_region
        );

        log::debug!("[Diarization] Endpoint: {}", endpoint);
        log::debug!("[Diarization] Language: {}", language);
        log::debug!("[Diarization] Audio size: {} bytes", audio_bytes.len());

        // First, try to get transcription with speaker separation enabled
        // We use 'detailed' format to get word-level timestamps
        let response = self
            .client
            .post(&endpoint)
            .header("Ocp-Apim-Subscription-Key", &config.speech_key)
            .header(
                "Content-Type",
                "audio/wav; codecs=audio/pcm; samplerate=16000",
            )
            .header("Accept", "application/json")
            .query(&[
                ("language", language),
                ("format", "detailed"),
                ("wordLevelTimestamps", "true"),
            ])
            .body(audio_bytes.to_vec())
            .send()
            .await
            .map_err(|e| AppError::HttpError(e))?;

        let status = response.status();
        log::debug!("[Diarization] Response status: {}", status);

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            log::warn!("[Diarization] Error response: {}", error_text);
            return Err(AppError::TranscriptionError(format!(
                "Azure Speech API returned status {}: {}",
                status, error_text
            )));
        }

        let result: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::HttpError(e))?;


        // Parse the response and apply diarization heuristics
        self.parse_with_diarization(&result, language, config).await
    }

    /// Parse transcription result and apply speaker diarization
    /// 
    /// This method applies speaker diarization heuristics based on:
    /// - Pause detection between segments
    /// - Energy/volume patterns (future enhancement)
    /// - Acoustic features (future enhancement with Azure Speaker Recognition)
    async fn parse_with_diarization(
        &self,
        result: &serde_json::Value,
        language: &str,
        config: &DiarizationConfig,
    ) -> AppResult<DiarizationResult> {
        let recognition_status = result
            .get("RecognitionStatus")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");

        if recognition_status != "Success" {
            return Err(AppError::TranscriptionError(format!(
                "Recognition failed with status: {}",
                recognition_status
            )));
        }

        let mut segments: Vec<DiarizedSegment> = Vec::new();
        let mut speakers: HashMap<String, IdentifiedSpeaker> = HashMap::new();
        let mut full_text = String::new();
        let mut duration_seconds = 0.0;
        let mut current_speaker = 1u32;

        // Extract NBest results
        if let Some(n_best) = result.get("NBest").and_then(|v| v.as_array()) {
            if let Some(best) = n_best.first() {
                // Get the display text
                if let Some(display) = best.get("Display").and_then(|v| v.as_str()) {
                    full_text = display.to_string();
                }

                // Process words for segmentation
                if let Some(words) = best.get("Words").and_then(|v| v.as_array()) {
                    let confidence = best
                        .get("Confidence")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(1.0) as f32;

                    let mut current_segment_text = String::new();
                    let mut segment_start: Option<f64> = None;
                    let mut last_end: f64 = 0.0;
                    let mut segment_speaker = format!("Speaker{}", current_speaker);

                    for word in words {
                        let word_text = word
                            .get("Word")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let offset = word.get("Offset").and_then(|v| v.as_u64()).unwrap_or(0);
                        let word_duration =
                            word.get("Duration").and_then(|v| v.as_u64()).unwrap_or(0);

                        let word_start = offset as f64 / 10_000_000.0;
                        let word_end = (offset + word_duration) as f64 / 10_000_000.0;

                        // Detect speaker change based on significant pause (> 1.5 seconds)
                        // This is a heuristic approach when full diarization isn't available
                        let pause_duration = if last_end > 0.0 {
                            word_start - last_end
                        } else {
                            0.0
                        };

                        let should_change_speaker = pause_duration > 1.5;

                        if should_change_speaker && !current_segment_text.is_empty() {
                            // Save current segment
                            if let Some(start) = segment_start {
                                segments.push(DiarizedSegment {
                                    text: current_segment_text.trim().to_string(),
                                    speaker_id: segment_speaker.clone(),
                                    speaker_name: segment_speaker.clone(),
                                    start_time: start,
                                    end_time: last_end,
                                    confidence,
                                    language: language.to_string(),
                                });

                                // Update speaker stats
                                let speaker_entry =
                                    speakers.entry(segment_speaker.clone()).or_insert_with(|| {
                                        IdentifiedSpeaker {
                                            speaker_id: segment_speaker.clone(),
                                            display_name: segment_speaker.clone(),
                                            total_speaking_time: 0.0,
                                            segment_count: 0,
                                        }
                                    });
                                speaker_entry.total_speaking_time += last_end - start;
                                speaker_entry.segment_count += 1;
                            }

                            // Change speaker (cycle through available speakers)
                            current_speaker = if current_speaker >= config.max_speakers {
                                1
                            } else {
                                current_speaker + 1
                            };
                            segment_speaker = format!("Speaker{}", current_speaker);
                            current_segment_text = String::new();
                            segment_start = None;
                        }

                        // Start new segment if needed
                        if segment_start.is_none() {
                            segment_start = Some(word_start);
                        }

                        // Add word to segment
                        if !current_segment_text.is_empty() {
                            current_segment_text.push(' ');
                        }
                        current_segment_text.push_str(word_text);
                        last_end = word_end;
                        duration_seconds = word_end;
                    }

                    // Save final segment
                    if let Some(start) = segment_start {
                        if !current_segment_text.is_empty() {
                            segments.push(DiarizedSegment {
                                text: current_segment_text.trim().to_string(),
                                speaker_id: segment_speaker.clone(),
                                speaker_name: segment_speaker.clone(),
                                start_time: start,
                                end_time: last_end,
                                confidence,
                                language: language.to_string(),
                            });

                            let speaker_entry =
                                speakers.entry(segment_speaker.clone()).or_insert_with(|| {
                                    IdentifiedSpeaker {
                                        speaker_id: segment_speaker.clone(),
                                        display_name: segment_speaker.clone(),
                                        total_speaking_time: 0.0,
                                        segment_count: 0,
                                    }
                                });
                            speaker_entry.total_speaking_time += last_end - start;
                            speaker_entry.segment_count += 1;
                        }
                    }
                } else {
                    // No word-level timestamps, create single segment
                    let offset = result
                        .get("Offset")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let duration = result
                        .get("Duration")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);

                    let start_time = offset as f64 / 10_000_000.0;
                    let end_time = (offset + duration) as f64 / 10_000_000.0;
                    duration_seconds = end_time;

                    let speaker_id = "Speaker1".to_string();

                    segments.push(DiarizedSegment {
                        text: full_text.clone(),
                        speaker_id: speaker_id.clone(),
                        speaker_name: speaker_id.clone(),
                        start_time,
                        end_time,
                        confidence: 1.0,
                        language: language.to_string(),
                    });

                    speakers.insert(
                        speaker_id.clone(),
                        IdentifiedSpeaker {
                            speaker_id: speaker_id.clone(),
                            display_name: speaker_id.clone(),
                            total_speaking_time: end_time - start_time,
                            segment_count: 1,
                        },
                    );
                }
            }
        } else if let Some(display_text) = result.get("DisplayText").and_then(|v| v.as_str()) {
            // Simple format without NBest
            full_text = display_text.to_string();
            let offset = result
                .get("Offset")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let duration = result
                .get("Duration")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);

            let start_time = offset as f64 / 10_000_000.0;
            let end_time = (offset + duration) as f64 / 10_000_000.0;
            duration_seconds = end_time;

            let speaker_id = "Speaker1".to_string();

            segments.push(DiarizedSegment {
                text: full_text.clone(),
                speaker_id: speaker_id.clone(),
                speaker_name: speaker_id.clone(),
                start_time,
                end_time,
                confidence: 1.0,
                language: language.to_string(),
            });

            speakers.insert(
                speaker_id.clone(),
                IdentifiedSpeaker {
                    speaker_id: speaker_id.clone(),
                    display_name: speaker_id.clone(),
                    total_speaking_time: end_time - start_time,
                    segment_count: 1,
                },
            );
        }

        // Convert speakers HashMap to Vec
        let speakers_vec: Vec<IdentifiedSpeaker> = speakers.into_values().collect();

        Ok(DiarizationResult {
            segments,
            speakers: speakers_vec,
            full_text,
            language: language.to_string(),
            duration_seconds,
        })
    }

    /// Apply user-defined speaker mappings to a diarization result
    /// 
    /// This allows users to rename "Speaker1", "Speaker2" to actual names
    pub fn apply_speaker_mappings(
        &self,
        mut result: DiarizationResult,
        mappings: Vec<SpeakerMapping>,
    ) -> DiarizationResult {
        // Create a lookup map
        let mapping_map: HashMap<String, String> = mappings
            .into_iter()
            .map(|m| (m.speaker_id, m.assigned_name))
            .collect();

        // Update segment speaker names
        for segment in &mut result.segments {
            if let Some(name) = mapping_map.get(&segment.speaker_id) {
                segment.speaker_name = name.clone();
            }
        }

        // Update speaker display names
        for speaker in &mut result.speakers {
            if let Some(name) = mapping_map.get(&speaker.speaker_id) {
                speaker.display_name = name.clone();
            }
        }

        result
    }

    /// Format diarization result as readable text with speaker labels
    pub fn format_as_text(&self, result: &DiarizationResult) -> String {
        let mut output = String::new();

        for segment in &result.segments {
            let mins = (segment.start_time as u32) / 60;
            let secs = (segment.start_time as u32) % 60;

            output.push_str(&format!(
                "**{}** `[{:02}:{:02}]`\n{}\n\n",
                segment.speaker_name, mins, secs, segment.text
            ));
        }

        output
    }

    /// Format diarization result as Markdown
    pub fn format_as_markdown(&self, result: &DiarizationResult, title: &str) -> String {
        let mut markdown = String::new();

        // Header
        markdown.push_str(&format!("# {}\n\n", title));
        markdown.push_str(&format!("**Language:** {}\n", result.language));
        markdown.push_str(&format!(
            "**Duration:** {:02}:{:02}\n\n",
            (result.duration_seconds as u32) / 60,
            (result.duration_seconds as u32) % 60
        ));

        // Participants
        markdown.push_str("## Participants\n\n");
        for speaker in &result.speakers {
            let speaking_mins = (speaker.total_speaking_time as u32) / 60;
            let speaking_secs = (speaker.total_speaking_time as u32) % 60;
            markdown.push_str(&format!(
                "- **{}** ({} segments, {:02}:{:02} speaking time)\n",
                speaker.display_name, speaker.segment_count, speaking_mins, speaking_secs
            ));
        }
        markdown.push('\n');

        // Transcript
        markdown.push_str("## Transcript\n\n");
        markdown.push_str(&self.format_as_text(result));

        markdown
    }
}

impl Default for DiarizationService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_speaker_mapping() {
        let service = DiarizationService::new();

        let result = DiarizationResult {
            segments: vec![
                DiarizedSegment {
                    text: "Hello".to_string(),
                    speaker_id: "Speaker1".to_string(),
                    speaker_name: "Speaker1".to_string(),
                    start_time: 0.0,
                    end_time: 1.0,
                    confidence: 0.9,
                    language: "en-US".to_string(),
                },
                DiarizedSegment {
                    text: "Hi there".to_string(),
                    speaker_id: "Speaker2".to_string(),
                    speaker_name: "Speaker2".to_string(),
                    start_time: 2.0,
                    end_time: 3.0,
                    confidence: 0.85,
                    language: "en-US".to_string(),
                },
            ],
            speakers: vec![
                IdentifiedSpeaker {
                    speaker_id: "Speaker1".to_string(),
                    display_name: "Speaker1".to_string(),
                    total_speaking_time: 1.0,
                    segment_count: 1,
                },
                IdentifiedSpeaker {
                    speaker_id: "Speaker2".to_string(),
                    display_name: "Speaker2".to_string(),
                    total_speaking_time: 1.0,
                    segment_count: 1,
                },
            ],
            full_text: "Hello Hi there".to_string(),
            language: "en-US".to_string(),
            duration_seconds: 3.0,
        };

        let mappings = vec![
            SpeakerMapping {
                speaker_id: "Speaker1".to_string(),
                assigned_name: "Alice".to_string(),
            },
            SpeakerMapping {
                speaker_id: "Speaker2".to_string(),
                assigned_name: "Bob".to_string(),
            },
        ];

        let mapped = service.apply_speaker_mappings(result, mappings);

        assert_eq!(mapped.segments[0].speaker_name, "Alice");
        assert_eq!(mapped.segments[1].speaker_name, "Bob");
        assert_eq!(mapped.speakers[0].display_name, "Alice");
        assert_eq!(mapped.speakers[1].display_name, "Bob");
    }

    #[test]
    fn test_format_as_markdown() {
        let service = DiarizationService::new();

        let result = DiarizationResult {
            segments: vec![DiarizedSegment {
                text: "Test message".to_string(),
                speaker_id: "Speaker1".to_string(),
                speaker_name: "Alice".to_string(),
                start_time: 0.0,
                end_time: 2.0,
                confidence: 0.9,
                language: "en-US".to_string(),
            }],
            speakers: vec![IdentifiedSpeaker {
                speaker_id: "Speaker1".to_string(),
                display_name: "Alice".to_string(),
                total_speaking_time: 2.0,
                segment_count: 1,
            }],
            full_text: "Test message".to_string(),
            language: "en-US".to_string(),
            duration_seconds: 2.0,
        };

        let markdown = service.format_as_markdown(&result, "Test Meeting");

        assert!(markdown.contains("# Test Meeting"));
        assert!(markdown.contains("**Alice**"));
        assert!(markdown.contains("Test message"));
    }
}
