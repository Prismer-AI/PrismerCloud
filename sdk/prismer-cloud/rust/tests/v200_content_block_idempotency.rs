//! v2.0 §3.0.2 Gap A-④ + §4.6 — ContentBlock + send X-Idempotency-Key
//!
//! Wave 3 Agent D1 (track 14 §3.0.2): protocol-layer SDK upgrades.
//!
//!   1. ContentBlock 8-variant serde round-trips with Anthropic-shape `kind`.
//!   2. ChatMessage.content polymorphism (string | Vec<ContentBlock>).
//!   3. TaskInput flattens `extra` into the top-level JSON object.
//!   4. generate_idempotency_key emits UUID v4 + unique per call.
//!   5. build_send_payload / build_send_payload_blocks behaviour.
//!
//! These are pure unit tests — no live server needed.

use prismer_sdk::im::{
    build_send_payload, build_send_payload_blocks, generate_idempotency_key, SendMessageOptions,
};
use prismer_sdk::types::{ChatMessage, ContentBlock, MessageContent, TaskInput};
use serde_json::json;

/// Stdlib-only RFC 4122 v4 UUID matcher (no regex dep).
/// Layout: 8-4-4-4-12 hex; version nibble = 4; variant nibble ∈ {8,9,a,b}.
fn is_uuid_v4(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, c) in bytes.iter().enumerate() {
        let is_dash = i == 8 || i == 13 || i == 18 || i == 23;
        if is_dash {
            if *c != b'-' {
                return false;
            }
            continue;
        }
        let ok = matches!(*c, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F');
        if !ok {
            return false;
        }
    }
    // Position 14 = version (must be '4')
    if bytes[14] != b'4' {
        return false;
    }
    // Position 19 = variant (must be 8, 9, a, or b)
    if !matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B') {
        return false;
    }
    true
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ContentBlock — 8 variants serde round-trip
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn content_block_all_variants_roundtrip() {
    let blocks = vec![
        ContentBlock::Text { text: "hi".into() },
        ContentBlock::Image {
            asset_id: "a1".into(),
            media_type: "image/png".into(),
            alt: Some("pic".into()),
        },
        ContentBlock::Audio {
            asset_id: "a2".into(),
            media_type: "audio/mpeg".into(),
            duration_ms: Some(120),
        },
        ContentBlock::Video {
            asset_id: "a3".into(),
            media_type: "video/mp4".into(),
            duration_ms: Some(4000),
            thumbnail_url: Some("https://x/y.jpg".into()),
        },
        ContentBlock::File {
            asset_id: "a4".into(),
            media_type: "application/pdf".into(),
            filename: "spec.pdf".into(),
        },
        ContentBlock::ToolUse {
            tool_call_id: "t1".into(),
            tool_name: "image_generate".into(),
            input_json: json!({"prompt":"cat"}),
        },
        ContentBlock::ToolResult {
            tool_call_id: "t1".into(),
            output: vec![ContentBlock::Text { text: "ok".into() }],
        },
        ContentBlock::Reasoning {
            text: "thinking".into(),
            redacted: Some(false),
        },
    ];

    let s = serde_json::to_string(&blocks).unwrap();
    for needle in [
        r#""kind":"text""#,
        r#""kind":"image""#,
        r#""kind":"audio""#,
        r#""kind":"video""#,
        r#""kind":"file""#,
        r#""kind":"tool_use""#,
        r#""kind":"tool_result""#,
        r#""kind":"reasoning""#,
        r#""assetId":"a1""#,
        r#""mediaType":"image/png""#,
        r#""thumbnailUrl":"https://x/y.jpg""#,
        r#""toolName":"image_generate""#,
        r#""inputJson":{"prompt":"cat"}"#,
    ] {
        assert!(s.contains(needle), "marshalled JSON missing {needle}:\n{s}");
    }

    // Round-trip
    let back: Vec<ContentBlock> = serde_json::from_str(&s).unwrap();
    assert_eq!(back.len(), 8);
    // Spot-check the nested tool_result
    if let ContentBlock::ToolResult { tool_call_id, output } = &back[6] {
        assert_eq!(tool_call_id, "t1");
        assert_eq!(output.len(), 1);
        if let ContentBlock::Text { text } = &output[0] {
            assert_eq!(text, "ok");
        } else {
            panic!("nested block kind wrong");
        }
    } else {
        panic!("block[6] not ToolResult");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ChatMessage.content polymorphism + TaskInput.extra flattening
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn chat_message_string_content() {
    let m = ChatMessage {
        role: "user".into(),
        content: MessageContent::Text("hello".into()),
        name: None,
        tool_call_id: None,
    };
    let s = serde_json::to_string(&m).unwrap();
    assert!(s.contains(r#""content":"hello""#), "string content shape: {s}");
    let back: ChatMessage = serde_json::from_str(&s).unwrap();
    assert_eq!(back.content, MessageContent::Text("hello".into()));
}

#[test]
fn chat_message_blocks_content() {
    let m = ChatMessage {
        role: "user".into(),
        content: MessageContent::Blocks(vec![
            ContentBlock::Text { text: "see".into() },
            ContentBlock::Image {
                asset_id: "a1".into(),
                media_type: "image/png".into(),
                alt: None,
            },
        ]),
        name: None,
        tool_call_id: None,
    };
    let s = serde_json::to_string(&m).unwrap();
    assert!(s.contains(r#""content":["#), "blocks content array: {s}");
    let back: ChatMessage = serde_json::from_str(&s).unwrap();
    match back.content {
        MessageContent::Blocks(b) => assert_eq!(b.len(), 2),
        _ => panic!("not blocks"),
    }
}

#[test]
fn task_input_flattens_extra() {
    let mut extra = std::collections::BTreeMap::new();
    extra.insert("captureScreenshot".to_string(), json!(true));
    let ti = TaskInput {
        prompt: Some("legacy".into()),
        messages: Some(vec![ChatMessage {
            role: "user".into(),
            content: MessageContent::Text("hi".into()),
            name: None,
            tool_call_id: None,
        }]),
        extra,
    };
    let s = serde_json::to_string(&ti).unwrap();
    for needle in [
        r#""prompt":"legacy""#,
        r#""messages":["#,
        r#""captureScreenshot":true"#,
    ] {
        assert!(s.contains(needle), "TaskInput JSON missing {needle}: {s}");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. generate_idempotency_key + build_send_payload
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn generate_idempotency_key_is_uuid_v4() {
    for _ in 0..200 {
        let k = generate_idempotency_key();
        assert!(is_uuid_v4(&k), "not uuid v4: {k}");
    }
    // Uniqueness — 200 calls must produce 200 distinct keys.
    use std::collections::HashSet;
    let set: HashSet<_> = (0..200).map(|_| generate_idempotency_key()).collect();
    assert_eq!(set.len(), 200);
}

#[test]
fn build_send_payload_string_auto_key() {
    let (body, key) = build_send_payload("hello", &SendMessageOptions::default());
    assert_eq!(body["content"], "hello");
    assert_eq!(body["type"], "text");
    assert_eq!(body["idempotencyKey"], key);
    assert!(is_uuid_v4(&key), "auto key not uuid v4: {key}");
    // No contentBlocks when not supplied
    assert!(body.get("contentBlocks").is_none());
}

#[test]
fn build_send_payload_explicit_key() {
    let opts = SendMessageOptions {
        idempotency_key: Some("my-custom-key".into()),
        ..Default::default()
    };
    let (body, key) = build_send_payload("retry", &opts);
    assert_eq!(key, "my-custom-key");
    assert_eq!(body["idempotencyKey"], "my-custom-key");
}

#[test]
fn build_send_payload_blocks_serialises_content_blocks() {
    let blocks = vec![
        ContentBlock::Text { text: "see".into() },
        ContentBlock::Image {
            asset_id: "a1".into(),
            media_type: "image/png".into(),
            alt: None,
        },
    ];
    let (body, key) = build_send_payload_blocks(blocks, &SendMessageOptions::default());
    assert_eq!(body["content"], "", "placeholder during double-write window");
    let arr = body["contentBlocks"].as_array().expect("contentBlocks array");
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["kind"], "text");
    assert_eq!(arr[1]["kind"], "image");
    assert_eq!(arr[1]["assetId"], "a1");
    assert!(is_uuid_v4(&key));
}

#[test]
fn build_send_payload_with_metadata_and_parent() {
    let opts = SendMessageOptions {
        msg_type: Some("markdown".into()),
        metadata: Some(json!({"clientTs": 12345})),
        parent_id: Some("m-parent".into()),
        quoted_message_id: Some("m-quoted".into()),
        idempotency_key: Some("k1".into()),
        ..Default::default()
    };
    let (body, _) = build_send_payload("hi", &opts);
    assert_eq!(body["type"], "markdown");
    assert_eq!(body["metadata"], json!({"clientTs": 12345}));
    assert_eq!(body["parentId"], "m-parent");
    assert_eq!(body["quotedMessageId"], "m-quoted");
    assert_eq!(body["idempotencyKey"], "k1");
}
