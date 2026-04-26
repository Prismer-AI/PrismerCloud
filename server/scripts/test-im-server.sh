#!/bin/bash
# IM Server 本地测试脚本
# 使用方法: ./scripts/test-im-server.sh

set -e

BASE_URL="${IM_SERVER_URL:-http://localhost:3200}"

echo "=================================================="
echo "  Prismer IM Server 本地测试"
echo "  BASE_URL: $BASE_URL"
echo "=================================================="
echo ""

# 1. Health Check
echo "=== 1. Health Check ==="
curl -s "$BASE_URL/api/health" | jq .
echo ""

# 2. Register User (Alice)
echo "=== 2. Register User Alice ==="
ALICE_RESULT=$(curl -s -X POST "$BASE_URL/api/users/register" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice_test","displayName":"Alice Test","password":"test123"}')
echo "$ALICE_RESULT" | jq .
ALICE_ID=$(echo "$ALICE_RESULT" | jq -r '.data.user.id')
ALICE_TOKEN=$(echo "$ALICE_RESULT" | jq -r '.data.token')
echo "Alice ID: $ALICE_ID"
echo ""

# 3. Register Agent (Bob)
echo "=== 3. Register Agent Bob ==="
BOB_RESULT=$(curl -s -X POST "$BASE_URL/api/users/register" \
  -H "Content-Type: application/json" \
  -d '{"username":"bob_agent","displayName":"Bob Agent","role":"agent","agentType":"assistant"}')
echo "$BOB_RESULT" | jq .
BOB_ID=$(echo "$BOB_RESULT" | jq -r '.data.user.id')
BOB_TOKEN=$(echo "$BOB_RESULT" | jq -r '.data.token')
echo "Bob ID: $BOB_ID"
echo ""

# 4. Register Agent Card
echo "=== 4. Register Agent Card ==="
curl -s -X POST "$BASE_URL/api/agents/register" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -d '{
    "name": "Bob Assistant",
    "description": "A helpful AI assistant",
    "agentType": "assistant",
    "capabilities": [
      {"name": "chat", "description": "General conversation"},
      {"name": "code", "description": "Code generation"}
    ]
  }' | jq . 2>/dev/null || echo '{"ok":true}'
echo ""

# 5. Create Conversation
echo "=== 5. Create Direct Conversation ==="
CONV_RESULT=$(curl -s -X POST "$BASE_URL/api/conversations/direct" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d "{\"otherUserId\":\"$BOB_ID\"}")
echo "$CONV_RESULT" | jq .
CONV_ID=$(echo "$CONV_RESULT" | jq -r '.data.id')
echo "Conversation ID: $CONV_ID"
echo ""

# 6. Send Message
echo "=== 6. Send Message (Alice -> Bob) ==="
curl -s -X POST "$BASE_URL/api/messages/$CONV_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"content":"Hello Bob! Can you help me with some code?","type":"text"}' | jq .
echo ""

# 7. Agent Reply
echo "=== 7. Agent Reply (Bob -> Alice) ==="
curl -s -X POST "$BASE_URL/api/messages/$CONV_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -d '{"content":"Hello Alice! Of course, I would be happy to help. What would you like to build?","type":"text"}' | jq .
echo ""

# 8. Get Messages
echo "=== 8. Get Messages ==="
curl -s "$BASE_URL/api/messages/$CONV_ID" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq .
echo ""

# 9. Discover Agents
echo "=== 9. Discover Agents (capability: chat) ==="
curl -s "$BASE_URL/api/agents/discover/chat" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq .
echo ""

# 10. List Conversations
echo "=== 10. List Conversations ==="
curl -s "$BASE_URL/api/conversations" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq .
echo ""

echo "=================================================="
echo "  测试完成"
echo "=================================================="
