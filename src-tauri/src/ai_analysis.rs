use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::ipc::Channel;

use crate::ai_configuration::{
    self, AiProfileRecord, AiProtocol, PublicAiConfigurationState, SaveAiProfileInput,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnalyzeInput {
    prompt: String,
    input_characters: usize,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnalyzeResult {
    content: String,
    provider: String,
    model: String,
    duration_ms: u128,
    input_characters: usize,
    truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiStreamEvent {
    Chunk { content: String },
}

pub type AiChunkSink = Arc<dyn Fn(String) + Send + Sync>;

#[tauri::command]
pub async fn load_ai_configuration() -> Result<PublicAiConfigurationState, String> {
    Ok(ai_configuration::load_state().await?.public())
}

#[tauri::command]
pub async fn save_ai_configuration(
    input: SaveAiProfileInput,
) -> Result<PublicAiConfigurationState, String> {
    Ok(ai_configuration::save_profile(input).await?.public())
}

#[tauri::command]
pub async fn activate_ai_configuration(id: String) -> Result<PublicAiConfigurationState, String> {
    Ok(ai_configuration::activate_profile(&id).await?.public())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverAiModelsInput {
    profile_id: Option<String>,
    provider: String,
    protocol: AiProtocol,
    base_url: String,
    api_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelDescriptor {
    id: String,
    label: String,
    context_tokens: Option<u64>,
    max_output_tokens: Option<u64>,
    recommended_log_characters: Option<u64>,
    limits_source: Option<String>,
}

#[tauri::command]
pub async fn discover_ai_models(
    input: DiscoverAiModelsInput,
) -> Result<Vec<AiModelDescriptor>, String> {
    let _provider = &input.provider;
    let state = ai_configuration::load_state().await?;
    let stored_key = input
        .profile_id
        .as_ref()
        .and_then(|id| state.profiles.iter().find(|profile| &profile.id == id))
        .and_then(|profile| profile.api_key.clone());
    let api_key = input
        .api_key
        .filter(|key| !key.trim().is_empty())
        .or(stored_key);
    let suffix = if input.protocol == AiProtocol::OllamaNative {
        "api/tags"
    } else {
        "models"
    };
    let url = endpoint(&input.base_url, suffix)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("无法初始化 AI 客户端：{error}"))?;
    let mut request = client.get(url.clone());
    if let Some(key) = api_key {
        request = if input.protocol == AiProtocol::GeminiNative {
            request.header("x-goog-api-key", key)
        } else {
            request.bearer_auth(key)
        };
    }
    let response = request.send().await.map_err(|error| {
        format!(
            "无法连接模型服务 {}：{error}",
            url.origin().ascii_serialization()
        )
    })?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("无法读取模型列表：{error}"))?;
    if !status.is_success() {
        return Err(format!(
            "拉取模型列表失败（HTTP {}）：{}",
            status.as_u16(),
            body.chars().take(800).collect::<String>()
        ));
    }
    let value = serde_json::from_str::<Value>(&body)
        .map_err(|error| format!("模型列表不是有效 JSON：{error}"))?;
    let rows = if input.protocol == AiProtocol::OllamaNative {
        value.get("models")
    } else {
        value.get("data").or_else(|| value.get("models"))
    }
    .and_then(Value::as_array)
    .ok_or_else(|| "模型服务返回了无法识别的模型列表".to_string())?;
    let mut models = rows.iter().filter_map(model_descriptor).collect::<Vec<_>>();
    models.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(models)
}

fn model_descriptor(value: &Value) -> Option<AiModelDescriptor> {
    let id = value.as_str().map(str::to_string).or_else(|| {
        ["id", "name", "model"]
            .iter()
            .find_map(|key| value.get(key)?.as_str().map(str::to_string))
    })?;
    let label = value
        .get("display_name")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let details = value.get("details").unwrap_or(&Value::Null);
    let context_tokens = [
        value.get("context_length"),
        value.get("max_context_length"),
        value.get("inputTokenLimit"),
        details.get("context_length"),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_u64);
    let max_output_tokens = [
        value.get("max_output_tokens"),
        value.get("outputTokenLimit"),
        details.get("max_output_tokens"),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_u64);
    let recommended_log_characters = context_tokens
        .map(|context| {
            let output_budget = max_output_tokens
                .unwrap_or_else(|| ((context as f64 * 0.08).ceil() as u64).max(2_048));
            let prompt_budget = (context as f64 * 0.05).ceil() as u64;
            ((context.saturating_sub(output_budget + prompt_budget.max(2_048))) as f64 * 2.8)
                .floor() as u64
        })
        .map(|characters| characters.clamp(1, 100_000_000));
    Some(AiModelDescriptor {
        id,
        label,
        context_tokens,
        max_output_tokens,
        recommended_log_characters,
        limits_source: (context_tokens.is_some() || max_output_tokens.is_some())
            .then(|| "模型服务".into()),
    })
}

#[tauri::command]
pub async fn analyze_log_with_ai(
    input: AiAnalyzeInput,
    on_event: Channel<AiStreamEvent>,
) -> Result<AiAnalyzeResult, String> {
    let sink: AiChunkSink = Arc::new(move |content| {
        let _ = on_event.send(AiStreamEvent::Chunk { content });
    });
    analyze_log(input, Some(sink)).await
}

pub async fn analyze_log(
    input: AiAnalyzeInput,
    on_chunk: Option<AiChunkSink>,
) -> Result<AiAnalyzeResult, String> {
    if input.prompt.trim().is_empty() {
        return Err("没有可分析的日志内容".to_string());
    }
    if input.prompt.len() > 1_200_000 {
        return Err("发送给 AI 的日志上下文超过 120 万字符".to_string());
    }
    let configuration = ai_configuration::load_state().await?.active()?;
    if !configuration.is_configured() {
        return Err("请先完成 AI 配置".to_string());
    }

    let started_at = Instant::now();
    let content = request_analysis(&configuration, &input.prompt, on_chunk.as_ref()).await?;
    Ok(AiAnalyzeResult {
        content,
        provider: configuration.provider,
        model: configuration.model,
        duration_ms: started_at.elapsed().as_millis(),
        input_characters: input.input_characters,
        truncated: input.truncated,
    })
}

async fn request_analysis(
    configuration: &AiProfileRecord,
    prompt: &str,
    on_chunk: Option<&AiChunkSink>,
) -> Result<String, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(240))
        .build()
        .map_err(|error| format!("无法初始化 AI 客户端：{error}"))?;

    let response = match &configuration.protocol {
        AiProtocol::OpenaiCompatible => {
            request_openai_compatible(&client, configuration, prompt).await?
        }
        AiProtocol::GeminiNative => request_gemini(&client, configuration, prompt).await?,
        AiProtocol::OllamaNative => request_ollama(&client, configuration, prompt).await?,
    };
    if configuration.stream_response {
        parse_streaming_response(response, &configuration.protocol, on_chunk).await
    } else {
        parse_successful_response(response, &configuration.protocol).await
    }
}

fn endpoint(base_url: &str, suffix: &str) -> Result<Url, String> {
    let normalized = if base_url.ends_with(suffix) {
        base_url.to_string()
    } else {
        format!(
            "{}/{}",
            base_url.trim_end_matches('/'),
            suffix.trim_start_matches('/')
        )
    };
    Url::parse(&normalized).map_err(|_| "AI 请求地址无效".to_string())
}

async fn request_openai_compatible(
    client: &Client,
    configuration: &AiProfileRecord,
    prompt: &str,
) -> Result<Response, String> {
    let url = endpoint(&configuration.base_url, "chat/completions")?;
    let mut body = json!({
        "model": configuration.model,
        "messages": [
            { "role": "system", "content": configuration.system_prompt },
            { "role": "user", "content": prompt }
        ],
        "temperature": configuration.temperature,
        "stream": configuration.stream_response
    });
    let output_limit_key = if configuration.provider == "openai" {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    body[output_limit_key] = json!(configuration.max_output_tokens);
    if is_deepseek(configuration) {
        body["thinking"] = json!({ "type": "disabled" });
    }
    let mut request = client.post(url).json(&body);
    if let Some(api_key) = configuration.api_key.as_ref().filter(|key| !key.is_empty()) {
        request = request.bearer_auth(api_key);
    }
    request.send().await.map_err(connection_error)
}

fn is_deepseek(configuration: &AiProfileRecord) -> bool {
    if configuration.provider == "deepseek" {
        return true;
    }
    Url::parse(&configuration.base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .is_some_and(|host| host.ends_with("deepseek.com"))
}

async fn request_gemini(
    client: &Client,
    configuration: &AiProfileRecord,
    prompt: &str,
) -> Result<Response, String> {
    let suffix = if configuration.stream_response {
        format!(
            "models/{}:streamGenerateContent?alt=sse",
            configuration.model
        )
    } else {
        format!("models/{}:generateContent", configuration.model)
    };
    let url = endpoint(&configuration.base_url, &suffix)?;
    let mut request = client.post(url).json(&json!({
        "system_instruction": { "parts": [{ "text": configuration.system_prompt }] },
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": {
            "temperature": configuration.temperature,
            "maxOutputTokens": configuration.max_output_tokens
        }
    }));
    if let Some(api_key) = configuration.api_key.as_ref().filter(|key| !key.is_empty()) {
        request = request.header("x-goog-api-key", api_key);
    }
    request.send().await.map_err(connection_error)
}

async fn request_ollama(
    client: &Client,
    configuration: &AiProfileRecord,
    prompt: &str,
) -> Result<Response, String> {
    let url = endpoint(&configuration.base_url, "api/chat")?;
    client
        .post(url)
        .json(&json!({
            "model": configuration.model,
            "messages": [
                { "role": "system", "content": configuration.system_prompt },
                { "role": "user", "content": prompt }
            ],
            "stream": configuration.stream_response,
            "options": {
                "temperature": configuration.temperature,
                "num_predict": configuration.max_output_tokens
            }
        }))
        .send()
        .await
        .map_err(connection_error)
}

fn connection_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return "AI 服务响应超时，请检查网络、模型状态或上下文长度".to_string();
    }
    format!("无法连接 AI 服务：{error}")
}

async fn parse_streaming_response(
    response: Response,
    protocol: &AiProtocol,
    on_chunk: Option<&AiChunkSink>,
) -> Result<String, String> {
    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .map_err(|error| format!("无法读取 AI 响应：{error}"))?;
        return Err(format!(
            "AI 服务返回 HTTP {}：{}",
            status.as_u16(),
            body.chars().take(1_200).collect::<String>()
        ));
    }
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut content = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(connection_error)?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim_end_matches('\r').to_string();
            buffer.drain(..=line_end);
            consume_stream_line(protocol, &line, &mut content, on_chunk)?;
        }
    }
    if !buffer.trim().is_empty() {
        consume_stream_line(protocol, &buffer, &mut content, on_chunk)?;
    }
    if content.trim().is_empty() {
        return Err("AI 响应中没有可显示的分析内容".to_string());
    }
    Ok(content)
}

fn consume_stream_line(
    protocol: &AiProtocol,
    line: &str,
    content: &mut String,
    on_chunk: Option<&AiChunkSink>,
) -> Result<(), String> {
    let trimmed = line.trim();
    let payload = match protocol {
        AiProtocol::OllamaNative => trimmed,
        _ if trimmed.starts_with("data:") => trimmed.trim_start_matches("data:").trim(),
        _ => return Ok(()),
    };
    if payload.is_empty() || payload == "[DONE]" {
        return Ok(());
    }
    let value = serde_json::from_str::<Value>(payload)
        .map_err(|error| format!("AI 流式响应不是有效 JSON：{error}"))?;
    let chunk = stream_delta(protocol, &value).unwrap_or_default();
    if chunk.is_empty() {
        return Ok(());
    }
    content.push_str(&chunk);
    if let Some(sink) = on_chunk {
        sink(chunk);
    }
    Ok(())
}

fn stream_delta(protocol: &AiProtocol, value: &Value) -> Option<String> {
    match protocol {
        AiProtocol::OpenaiCompatible => {
            let delta = value.pointer("/choices/0/delta/content")?;
            if let Some(text) = delta.as_str() {
                return Some(text.to_string());
            }
            Some(
                delta
                    .as_array()?
                    .iter()
                    .filter_map(|part| part.get("text")?.as_str())
                    .collect::<String>(),
            )
        }
        AiProtocol::GeminiNative => value
            .pointer("/candidates/0/content/parts")?
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text")?.as_str())
                    .collect::<String>()
            }),
        AiProtocol::OllamaNative => value
            .pointer("/message/content")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

async fn parse_successful_response(
    response: Response,
    protocol: &AiProtocol,
) -> Result<String, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("无法读取 AI 响应：{error}"))?;
    if !status.is_success() {
        let detail = body.chars().take(1_200).collect::<String>();
        return Err(format!("AI 服务返回 HTTP {}：{}", status.as_u16(), detail));
    }
    let value = serde_json::from_str::<Value>(&body)
        .map_err(|error| format!("AI 响应不是有效 JSON：{error}"))?;
    let content = match protocol {
        AiProtocol::OpenaiCompatible => openai_content(&value),
        AiProtocol::GeminiNative => gemini_content(&value),
        AiProtocol::OllamaNative => value
            .pointer("/message/content")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    if content.as_ref().is_some_and(|text| !text.trim().is_empty()) {
        return Ok(content.unwrap_or_default());
    }
    let exhausted_during_reasoning = value
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        == Some("length")
        && value
            .pointer("/choices/0/message/reasoning_content")
            .and_then(Value::as_str)
            .is_some_and(|reasoning| !reasoning.trim().is_empty());
    if exhausted_during_reasoning {
        return Err(
            "模型的思考过程耗尽了输出 Token，尚未生成最终结论；请提高最大输出 Token 后重试"
                .to_string(),
        );
    }
    Err("AI 响应中没有可显示的分析内容".to_string())
}

fn openai_content(value: &Value) -> Option<String> {
    let content = value.pointer("/choices/0/message/content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let parts = content
        .as_array()?
        .iter()
        .filter_map(|part| part.get("text")?.as_str());
    Some(parts.collect::<Vec<_>>().join("\n"))
}

fn gemini_content(value: &Value) -> Option<String> {
    let parts = value.pointer("/candidates/0/content/parts")?.as_array()?;
    Some(
        parts
            .iter()
            .filter_map(|part| part.get("text")?.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_protocol_endpoint_once() {
        assert_eq!(
            endpoint("https://example.com/v1", "chat/completions")
                .unwrap()
                .as_str(),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint(
                "https://example.com/v1/chat/completions",
                "chat/completions"
            )
            .unwrap()
            .as_str(),
            "https://example.com/v1/chat/completions"
        );
    }

    #[test]
    fn reads_openai_text_and_content_parts() {
        assert_eq!(
            openai_content(&json!({ "choices": [{ "message": { "content": "ok" } }] })).as_deref(),
            Some("ok")
        );
        assert_eq!(openai_content(&json!({ "choices": [{ "message": { "content": [{ "text": "a" }, { "text": "b" }] } }] })).as_deref(), Some("a\nb"));
    }

    #[test]
    fn reads_stream_deltas_for_supported_protocols() {
        assert_eq!(
            stream_delta(
                &AiProtocol::OpenaiCompatible,
                &json!({ "choices": [{ "delta": { "content": "open" } }] })
            )
            .as_deref(),
            Some("open")
        );
        assert_eq!(
            stream_delta(
                &AiProtocol::GeminiNative,
                &json!({ "candidates": [{ "content": { "parts": [{ "text": "gem" }, { "text": "ini" }] } }] })
            )
            .as_deref(),
            Some("gemini")
        );
        assert_eq!(
            stream_delta(
                &AiProtocol::OllamaNative,
                &json!({ "message": { "content": "ollama" } })
            )
            .as_deref(),
            Some("ollama")
        );
    }

    #[test]
    fn detects_deepseek_by_provider_or_host() {
        let mut configuration = AiProfileRecord::default();
        configuration.provider = "deepseek".to_string();
        assert!(is_deepseek(&configuration));

        configuration.provider = "custom".to_string();
        configuration.base_url = "https://api.deepseek.com".to_string();
        assert!(is_deepseek(&configuration));

        configuration.base_url = "https://api.example.com/v1".to_string();
        assert!(!is_deepseek(&configuration));
    }
}
