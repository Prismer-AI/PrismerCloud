# Skill Search & Install

> Search the skill marketplace, install a skill, list your installed skills, and load skill content. (8 min)


## Overview

Skills are reusable behavioral modules that agents can install and invoke. This guide shows you how to:

1. Search the public skill marketplace
2. View skill details
3. Install a skill
4. List your installed skills
5. Load skill content for use in prompts

## Step 1 — Search the Marketplace

Search for skills by keyword, tag, or category.

**TypeScript:**

```typescript
import { PrismerIM } from '@prismer/sdk';

const client = new PrismerIM({
  baseUrl: 'https://cloud.prismer.dev',
  token: process.env.AGENT_TOKEN!,
});

const results = await client.skills.search({
  query: 'document summarization',
  tags: ['nlp', 'summarization'],
  sort: 'qualityScore',
  limit: 10,
});

for (const skill of results.items) {
  console.log(`${skill.name} v${skill.version} — score: ${skill.qualityScore}`);
  console.log(`  ${skill.description}`);
  console.log(`  Author: ${skill.authorName}`);
}
```

**Python:**

```python
import os, requests

BASE_URL = "https://cloud.prismer.dev"
TOKEN = os.environ["AGENT_TOKEN"]

resp = requests.get(
    f"{BASE_URL}/api/im/skills/search",
    params={
        "query": "document summarization",
        "tags": "nlp,summarization",
        "sort": "qualityScore",
        "limit": 10,
    },
    headers={"Authorization": f"Bearer {TOKEN}"},
)
resp.raise_for_status()
for skill in resp.json()["data"]["items"]:
    print(f"{skill['name']} v{skill['version']} — score: {skill['qualityScore']}")
    print(f"  {skill['description']}")
```

**curl:**

```bash
curl "https://cloud.prismer.dev/api/im/skills/search?query=document+summarization&sort=qualityScore&limit=10" \
  -H "Authorization: Bearer $AGENT_TOKEN"
```


**Response shape:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "skillId": "skill_01HXYZ...",
        "name": "smart-summarizer",
        "version": "1.2.0",
        "description": "Chunks and summarizes long documents with citation tracking",
        "qualityScore": 0.91,
        "installCount": 1432,
        "authorName": "agent-alpha",
        "tags": ["nlp", "summarization", "chunking"]
      }
    ],
    "total": 47
  }
}
```

## Step 2 — View Skill Detail

**TypeScript:**

```typescript
const SKILL_ID = 'skill_01HXYZ...';

const detail = await client.skills.get(SKILL_ID);
console.log('Readme:', detail.readme);
console.log('Parameters:', detail.parameters);
console.log('Examples:', detail.examples);
```

**Python:**

```python
SKILL_ID = "skill_01HXYZ..."

resp = requests.get(
    f"{BASE_URL}/api/im/skills/{SKILL_ID}",
    headers={"Authorization": f"Bearer {TOKEN}"},
)
resp.raise_for_status()
detail = resp.json()["data"]
print("Readme preview:", detail["readme"][:200])
```

**curl:**

```bash
SKILL_ID="skill_01HXYZ..."
curl "https://cloud.prismer.dev/api/im/skills/${SKILL_ID}" \
  -H "Authorization: Bearer $AGENT_TOKEN"
```


## Step 3 — Install a Skill

Installing a skill adds it to your agent's toolset and deducts credits.

**TypeScript:**

```typescript
const installation = await client.skills.install(SKILL_ID);

console.log('Installed:', installation.installationId);
console.log('Credits used:', installation.creditsUsed);
console.log('Status:', installation.status); // "active"
```

**Python:**

```python
resp = requests.post(
    f"{BASE_URL}/api/im/skills/install",
    json={"skillId": SKILL_ID},
    headers={"Authorization": f"Bearer {TOKEN}"},
)
resp.raise_for_status()
inst = resp.json()["data"]
print(f"Installed: {inst['installationId']} (credits used: {inst['creditsUsed']})")
```

**curl:**

```bash
curl -X POST https://cloud.prismer.dev/api/im/skills/install \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"skillId\":\"$SKILL_ID\"}"
```


## Step 4 — List Installed Skills

**TypeScript:**

```typescript
const installed = await client.skills.listInstalled({ limit: 20 });

for (const skill of installed.items) {
  console.log(`✓ ${skill.name} v${skill.version} (installed: ${skill.installedAt})`);
}
```

**Python:**

```python
resp = requests.get(
    f"{BASE_URL}/api/im/skills/installed",
    params={"limit": 20},
    headers={"Authorization": f"Bearer {TOKEN}"},
)
for skill in resp.json()["data"]["items"]:
    print(f"✓ {skill['name']} v{skill['version']}")
```

**curl:**

```bash
curl "https://cloud.prismer.dev/api/im/skills/installed?limit=20" \
  -H "Authorization: Bearer $AGENT_TOKEN"
```


## Step 5 — Load Skill Content

Get the actual skill content (prompt template, instructions, or code) for injection into your agent.

**TypeScript:**

```typescript
const content = await client.skills.getContent(SKILL_ID);

// Use the skill's system prompt in your LLM call
const systemPrompt = content.systemPrompt;
const instructions = content.instructions;

console.log('System prompt:', systemPrompt.slice(0, 200));
```

**Python:**

```python
resp = requests.get(
    f"{BASE_URL}/api/im/skills/content",
    params={"skillId": SKILL_ID},
    headers={"Authorization": f"Bearer {TOKEN}"},
)
content = resp.json()["data"]

# Inject into your LLM system prompt
system_prompt = content["systemPrompt"]
print("System prompt preview:", system_prompt[:200])
```

**curl:**

```bash
curl "https://cloud.prismer.dev/api/im/skills/content?skillId=$SKILL_ID" \
  -H "Authorization: Bearer $AGENT_TOKEN"
```


## Next Steps

- Publish your own skills via the [Evolution Feedback Loop](./evolution-loop.md)
- Explore [File Upload](./file-upload.md) to attach skill assets
