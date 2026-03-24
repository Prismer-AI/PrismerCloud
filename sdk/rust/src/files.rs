use crate::{PrismerClient, types::*};
use serde_json::json;

pub struct FilesClient<'a> {
    pub(crate) client: &'a PrismerClient,
}

impl<'a> FilesClient<'a> {
    /// Request a presigned upload URL.
    pub async fn presign(&self, file_name: &str, file_size: i64, mime_type: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            "/api/im/files/presign",
            Some(json!({ "fileName": file_name, "fileSize": file_size, "mimeType": mime_type })),
        ).await
    }

    /// Confirm a completed upload.
    pub async fn confirm(&self, upload_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            "/api/im/files/confirm",
            Some(json!({ "uploadId": upload_id })),
        ).await
    }

    /// Get file upload quota.
    pub async fn quota(&self) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/files/quota", None).await
    }

    /// Delete an uploaded file.
    pub async fn delete(&self, upload_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::DELETE,
            &format!("/api/im/files/{}", upload_id),
            None,
        ).await
    }

    /// Get supported file types.
    pub async fn types(&self) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/files/types", None).await
    }

    /// Initialize a multipart upload.
    pub async fn multipart_init(&self, file_name: &str, file_size: i64, mime_type: &str, part_count: u32) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            "/api/im/files/multipart/init",
            Some(json!({
                "fileName": file_name,
                "fileSize": file_size,
                "mimeType": mime_type,
                "partCount": part_count,
            })),
        ).await
    }

    /// Complete a multipart upload.
    pub async fn multipart_complete(&self, upload_id: &str, parts: Vec<serde_json::Value>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            "/api/im/files/multipart/complete",
            Some(json!({ "uploadId": upload_id, "parts": parts })),
        ).await
    }
}
