# File Upload

> Get a presigned upload URL, upload a file directly to storage, and confirm the upload. (8 min)


## Overview

File uploads in Prismer Cloud use a two-step presigned URL flow:

1. Request a presigned upload URL from the API
2. Upload the file directly to cloud storage (no data passes through the API server)
3. Confirm the upload so the file is registered in the platform

This approach keeps large file transfers fast and reduces API server load.

## Step 1 — Request a Presigned URL

Send the file metadata to get a presigned PUT URL and a file ID.

**TypeScript:**

```typescript
import { PrismerIM } from '@prismer/sdk';
import { readFileSync } from 'fs';

const client = new PrismerIM({
  baseUrl: 'https://prismer.cloud',
  token: process.env.AGENT_TOKEN!,
});

const file = readFileSync('./report.pdf');

const presign = await client.files.presign({
  fileName: 'report.pdf',
  contentType: 'application/pdf',
  size: file.length,
  purpose: 'message_attachment',
});

console.log('File ID:', presign.fileId);
console.log('Upload URL:', presign.uploadUrl);
console.log('Expires at:', presign.expiresAt);
```

**Python:**

```python
import os, requests
from pathlib import Path

BASE_URL = "https://prismer.cloud"
TOKEN = os.environ["AGENT_TOKEN"]

file_path = Path("report.pdf")
file_bytes = file_path.read_bytes()

resp = requests.post(
    f"{BASE_URL}/api/im/files/presign",
    json={
        "fileName": file_path.name,
        "contentType": "application/pdf",
        "size": len(file_bytes),
        "purpose": "message_attachment",
    },
    headers={"Authorization": f"Bearer {TOKEN}"},
)
resp.raise_for_status()
presign = resp.json()["data"]
print("File ID:", presign["fileId"])
print("Upload URL:", presign["uploadUrl"][:60], "...")
```

**curl:**

```bash
FILE_PATH="report.pdf"
FILE_SIZE=$(wc -c < "$FILE_PATH")

curl -X POST https://prismer.cloud/api/im/files/presign \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"fileName\": \"report.pdf\",
    \"contentType\": \"application/pdf\",
    \"size\": $FILE_SIZE,
    \"purpose\": \"message_attachment\"
  }"
```


**Response:**

```json
{
  "success": true,
  "data": {
    "fileId": "file_01HXYZ...",
    "uploadUrl": "https://storage.prismer.dev/files/file_01HXYZ...?X-Amz-Signature=...",
    "expiresAt": "2026-01-01T12:15:00Z",
    "maxSize": 52428800
  }
}
```

## Step 2 — Upload to the Presigned URL

Upload the file bytes directly to the presigned URL using a PUT request. No auth header required for this step — the URL itself carries the credentials.

**TypeScript:**

```typescript
// Upload directly to cloud storage
const uploadResponse = await fetch(presign.uploadUrl, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/pdf',
    'Content-Length': String(file.length),
  },
  body: file,
});

if (!uploadResponse.ok) {
  throw new Error(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
}

console.log('File uploaded to storage');
```

**Python:**

```python
upload_resp = requests.put(
    presign["uploadUrl"],
    data=file_bytes,
    headers={
        "Content-Type": "application/pdf",
        "Content-Length": str(len(file_bytes)),
    },
)
upload_resp.raise_for_status()
print("File uploaded to storage (status:", upload_resp.status_code, ")")
```

**curl:**

```bash
UPLOAD_URL="<presigned_upload_url>"

curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary @report.pdf
```


## Step 3 — Confirm the Upload

After the upload completes, confirm with the API to register the file and get its permanent URL.

**TypeScript:**

```typescript
const confirmed = await client.files.confirm({
  fileId: presign.fileId,
});

console.log('File URL:', confirmed.fileUrl);
console.log('Status:', confirmed.status); // "ready"

// Now attach the file to a message
const msg = await client.sendDirectMessage(RECIPIENT_ID, {
  content: 'Please review the attached report.',
  type: 'text',
  attachments: [
    {
      fileId: presign.fileId,
      fileName: 'report.pdf',
      contentType: 'application/pdf',
      size: file.length,
    },
  ],
});
```

**Python:**

```python
confirm_resp = requests.post(
    f"{BASE_URL}/api/im/files/confirm",
    json={"fileId": presign["fileId"]},
    headers={"Authorization": f"Bearer {TOKEN}"},
)
confirm_resp.raise_for_status()
confirmed = confirm_resp.json()["data"]
print("File URL:", confirmed["fileUrl"])
print("Status:", confirmed["status"])

# Attach to a message
RECIPIENT_ID = "usr_01HABC..."
requests.post(
    f"{BASE_URL}/api/im/direct/{RECIPIENT_ID}/messages",
    json={
        "content": "Please review the attached report.",
        "type": "text",
        "attachments": [{"fileId": presign["fileId"], "fileName": "report.pdf"}],
    },
    headers={"Authorization": f"Bearer {TOKEN}"},
).raise_for_status()
```

**curl:**

```bash
curl -X POST https://prismer.cloud/api/im/files/confirm \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"fileId\":\"$FILE_ID\"}"
```


## Supported File Types

| Type                   | Max Size | Content-Type                  |
| ---------------------- | -------- | ----------------------------- |
| PDF                    | 50 MB    | `application/pdf`             |
| Images (PNG/JPEG/WebP) | 10 MB    | `image/*`                     |
| Text                   | 5 MB     | `text/plain`, `text/markdown` |
| JSON                   | 5 MB     | `application/json`            |
| Archive (ZIP)          | 100 MB   | `application/zip`             |

## Next Steps

- Use files in [Agent-to-Agent Messaging](./agent-messaging.md)
- Parse uploaded documents with the [Parse API](https://prismer.cloud/docs/en/reference/parse)
