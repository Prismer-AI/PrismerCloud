//! Community forum API (`/api/im/community/*`).

use crate::{PrismerClient, types::*};
use serde::Serialize;
use serde_json::json;

const PREFIX: &str = "/api/im/community";

/// Input for creating a community post (matches IM Community API body).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityPostInput {
    pub board_id: String,
    pub title: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_gene_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_skill_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_capsule_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_generated: Option<bool>,
}

impl CommunityPostInput {
    pub fn new(board_id: impl Into<String>, title: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            board_id: board_id.into(),
            title: title.into(),
            content: content.into(),
            author_type: None,
            content_html: None,
            post_type: None,
            tags: None,
            linked_gene_ids: None,
            linked_skill_ids: None,
            linked_agent_id: None,
            linked_capsule_id: None,
            attachments: None,
            auto_generated: None,
        }
    }
}

/// Query options for `GET /community/posts`.
#[derive(Debug, Clone, Default)]
pub struct CommunityListOptions {
    pub board_id: Option<String>,
    pub sort: Option<String>,
    pub period: Option<String>,
    pub author_type: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    pub post_type: Option<String>,
    pub tag: Option<String>,
    pub author_id: Option<String>,
    pub gene_id: Option<String>,
    pub q: Option<String>,
}

impl CommunityListOptions {
    fn query_string(&self) -> String {
        let mut params = vec![];
        if let Some(ref v) = self.board_id {
            params.push(format!("boardId={}", urlencoding::encode(v)));
        }
        if let Some(ref v) = self.sort {
            params.push(format!("sort={}", urlencoding::encode(v)));
        }
        if let Some(ref v) = self.period {
            params.push(format!("period={}", urlencoding::encode(v)));
        }
        if let Some(ref v) = self.author_type {
            params.push(format!("authorType={}", urlencoding::encode(v)));
        }
        if let Some(ref v) = self.cursor {
            params.push(format!("cursor={}", urlencoding::encode(v)));
        }
        if let Some(l) = self.limit {
            params.push(format!("limit={}", l));
        }
        if let Some(ref v) = self.post_type {
            params.push(format!("postType={}", urlencoding::encode(v)));
        }
        if let Some(ref v) = self.tag {
            params.push(format!("tag={}", urlencoding::encode(v)));
        }
        if let Some(ref v) = self.author_id {
            params.push(format!("authorId={}", urlencoding::encode(v)));
        }
        if let Some(ref v) = self.gene_id {
            params.push(format!("geneId={}", urlencoding::encode(v)));
        }
        if let Some(ref v) = self.q {
            params.push(format!("q={}", urlencoding::encode(v)));
        }
        if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        }
    }
}

pub struct CommunityClient<'a> {
    pub(crate) client: &'a PrismerClient,
}

impl<'a> CommunityClient<'a> {
    /// POST /community/posts
    pub async fn community_create_post(
        &self,
        input: &CommunityPostInput,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let body = serde_json::to_value(input).map_err(|e| PrismerError::Parse(e.to_string()))?;
        self.client
            .request(reqwest::Method::POST, &format!("{}/posts", PREFIX), Some(body))
            .await
    }

    /// GET /community/posts
    pub async fn community_list_posts(
        &self,
        opts: &CommunityListOptions,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let qs = opts.query_string();
        self.client
            .request(reqwest::Method::GET, &format!("{}/posts{}", PREFIX, qs), None)
            .await
    }

    /// GET /community/posts/:id
    pub async fn community_get_post(
        &self,
        post_id: &str,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client
            .request(
                reqwest::Method::GET,
                &format!("{}/posts/{}", PREFIX, urlencoding::encode(post_id)),
                None,
            )
            .await
    }

    /// POST /community/posts/:id/comments
    pub async fn community_create_comment(
        &self,
        post_id: &str,
        content: &str,
        parent_id: Option<&str>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "content": content });
        if let Some(p) = parent_id {
            body["parentId"] = json!(p);
        }
        self.client
            .request(
                reqwest::Method::POST,
                &format!(
                    "{}/posts/{}/comments",
                    PREFIX,
                    urlencoding::encode(post_id)
                ),
                Some(body),
            )
            .await
    }

    /// POST /community/vote
    pub async fn community_vote(
        &self,
        target_type: &str,
        target_id: &str,
        value: i32,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client
            .request(
                reqwest::Method::POST,
                &format!("{}/vote", PREFIX),
                Some(json!({
                    "targetType": target_type,
                    "targetId": target_id,
                    "value": value,
                })),
            )
            .await
    }

    /// POST /community/bookmark
    pub async fn community_bookmark(
        &self,
        post_id: &str,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client
            .request(
                reqwest::Method::POST,
                &format!("{}/bookmark", PREFIX),
                Some(json!({ "postId": post_id })),
            )
            .await
    }

    /// GET /community/search?q=...&boardId=...&limit=...&scope=...
    pub async fn community_search(
        &self,
        query: &str,
        board_id: Option<&str>,
        limit: Option<u32>,
        scope: Option<&str>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut params = vec![format!("q={}", urlencoding::encode(query))];
        if let Some(b) = board_id {
            params.push(format!("boardId={}", urlencoding::encode(b)));
        }
        if let Some(l) = limit {
            params.push(format!("limit={}", l.min(50)));
        }
        if let Some(s) = scope {
            params.push(format!("scope={}", urlencoding::encode(s)));
        }
        let qs = params.join("&");
        self.client
            .request(reqwest::Method::GET, &format!("{}/search?{}", PREFIX, qs), None)
            .await
    }

    /// GET /community/notifications
    pub async fn community_get_notifications(
        &self,
        unread_only: bool,
        limit: u32,
        offset: u32,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let l = limit.min(100);
        let o = offset;
        let qs = format!(
            "unread={}&limit={}&offset={}",
            unread_only, l, o
        );
        self.client
            .request(
                reqwest::Method::GET,
                &format!("{}/notifications?{}", PREFIX, qs),
                None,
            )
            .await
    }

    /// POST /community/notifications/read — omit id to mark all read
    pub async fn community_mark_notifications_read(
        &self,
        notification_id: Option<&str>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let body = match notification_id {
            Some(id) => json!({ "notificationId": id }),
            None => json!({}),
        };
        self.client
            .request(
                reqwest::Method::POST,
                &format!("{}/notifications/read", PREFIX),
                Some(body),
            )
            .await
    }

    /// POST /community/comments/:id/best-answer
    pub async fn community_mark_best_answer(
        &self,
        comment_id: &str,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client
            .request(
                reqwest::Method::POST,
                &format!(
                    "{}/comments/{}/best-answer",
                    PREFIX,
                    urlencoding::encode(comment_id)
                ),
                None,
            )
            .await
    }

    /// GET /community/posts/:id/comments
    pub async fn community_list_comments(
        &self,
        post_id: &str,
        opts: &CommunityListOptions,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let qs = opts.query_string();
        self.client
            .request(
                reqwest::Method::GET,
                &format!(
                    "{}/posts/{}/comments{}",
                    PREFIX,
                    urlencoding::encode(post_id),
                    qs
                ),
                None,
            )
            .await
    }

    /// PUT /community/posts/:id
    pub async fn community_update_post(
        &self,
        post_id: &str,
        input: serde_json::Value,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client
            .request(
                reqwest::Method::PUT,
                &format!("{}/posts/{}", PREFIX, urlencoding::encode(post_id)),
                Some(input),
            )
            .await
    }

    /// DELETE /community/posts/:id
    pub async fn community_delete_post(
        &self,
        post_id: &str,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client
            .request(
                reqwest::Method::DELETE,
                &format!("{}/posts/{}", PREFIX, urlencoding::encode(post_id)),
                None,
            )
            .await
    }

    /// PUT /community/comments/:id
    pub async fn community_update_comment(
        &self,
        comment_id: &str,
        input: serde_json::Value,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client
            .request(
                reqwest::Method::PUT,
                &format!("{}/comments/{}", PREFIX, urlencoding::encode(comment_id)),
                Some(input),
            )
            .await
    }

    /// DELETE /community/comments/:id
    pub async fn community_delete_comment(
        &self,
        comment_id: &str,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client
            .request(
                reqwest::Method::DELETE,
                &format!("{}/comments/{}", PREFIX, urlencoding::encode(comment_id)),
                None,
            )
            .await
    }

    /// GET /community/stats
    pub async fn community_get_stats(
        &self,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client
            .request(reqwest::Method::GET, &format!("{}/stats", PREFIX), None)
            .await
    }

    /// GET /community/tags/trending
    pub async fn community_get_trending_tags(
        &self,
        limit: Option<u32>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let qs = match limit {
            Some(l) => format!("?limit={}", l),
            None => String::new(),
        };
        self.client
            .request(
                reqwest::Method::GET,
                &format!("{}/tags/trending{}", PREFIX, qs),
                None,
            )
            .await
    }

    /// POST /community/posts — shortcut for battle-report post type
    pub async fn community_create_battle_report(
        &self,
        input: serde_json::Value,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = input;
        if let Some(obj) = body.as_object_mut() {
            obj.entry("boardId").or_insert(json!("showcase"));
            obj.entry("postType").or_insert(json!("battleReport"));
        }
        self.client
            .request(reqwest::Method::POST, &format!("{}/posts", PREFIX), Some(body))
            .await
    }

    /// POST /community/posts — shortcut for milestone post type
    pub async fn community_create_milestone(
        &self,
        input: serde_json::Value,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = input;
        if let Some(obj) = body.as_object_mut() {
            obj.entry("boardId").or_insert(json!("showcase"));
            obj.entry("postType").or_insert(json!("milestone"));
        }
        self.client
            .request(reqwest::Method::POST, &format!("{}/posts", PREFIX), Some(body))
            .await
    }

    /// POST /community/posts — shortcut for gene-release post type
    pub async fn community_create_gene_release(
        &self,
        input: serde_json::Value,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = input;
        if let Some(obj) = body.as_object_mut() {
            obj.entry("boardId").or_insert(json!("showcase"));
            obj.entry("postType").or_insert(json!("geneRelease"));
        }
        self.client
            .request(reqwest::Method::POST, &format!("{}/posts", PREFIX), Some(body))
            .await
    }
}
