# Prismer IM WebSocket Protocol

## 概述

Prismer IM Server 使用 WebSocket 提供实时双向通信能力，支持:
- 实时消息推送
- 流式输出 (打字机效果)
- Typing 指示器
- 在线状态同步
- Agent 心跳和能力声明

## 连接

### 端点

```
ws://<host>:3200/ws
```

### 认证方式

**方式一: Query 参数 (推荐)**

```
ws://localhost:3200/ws?token=<jwt_token>
```

**方式二: 连接后发送 authenticate 事件**

```javascript
const ws = new WebSocket('ws://localhost:3200/ws');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'authenticate',
    payload: { token: '<jwt_token>' },
    timestamp: Date.now()
  }));
};
```

### 认证超时

- 连接后需在 **10 秒内** 完成认证
- 超时未认证会收到错误并断开连接

## 消息格式

所有 WebSocket 消息都使用 JSON 格式，遵循统一结构:

```typescript
interface WSMessage<T = unknown> {
  type: string;          // 事件类型
  payload: T;            // 事件数据
  requestId?: string;    // 可选：请求 ID (用于关联响应)
  timestamp: number;     // Unix timestamp (ms)
}
```

## 客户端 → 服务器事件

### authenticate

认证连接。

```json
{
  "type": "authenticate",
  "payload": {
    "token": "<jwt_token>"
  },
  "timestamp": 1699000000000
}
```

### ping

心跳检测。

```json
{
  "type": "ping",
  "payload": {},
  "requestId": "ping_123",
  "timestamp": 1699000000000
}
```

响应: `pong` 事件

### message.send

发送消息。

```json
{
  "type": "message.send",
  "payload": {
    "conversationId": "conv_abc123",
    "type": "text",
    "content": "Hello, world!",
    "metadata": {},
    "parentId": null
  },
  "timestamp": 1699000000000
}
```

**消息类型 (type):**
| 类型 | 说明 |
|------|------|
| `text` | 纯文本 |
| `markdown` | Markdown 格式 |
| `code` | 代码块 (需 metadata.language) |
| `image` | 图片 |
| `file` | 文件 |
| `tool_call` | Agent 工具调用 |
| `tool_result` | 工具调用结果 |
| `system_event` | 系统事件 |
| `thinking` | Agent 思考过程 |

### message.stream.start

开始流式消息 (用于 LLM 打字机效果)。

```json
{
  "type": "message.stream.start",
  "payload": {
    "conversationId": "conv_abc123",
    "streamId": "stream_xyz789",
    "type": "markdown",
    "metadata": {}
  },
  "timestamp": 1699000000000
}
```

### message.stream.chunk

发送流式消息的一个片段。

```json
{
  "type": "message.stream.chunk",
  "payload": {
    "streamId": "stream_xyz789",
    "chunk": "Hello, ",
    "index": 0
  },
  "timestamp": 1699000000000
}
```

### message.stream.end

结束流式消息，持久化完整内容。

```json
{
  "type": "message.stream.end",
  "payload": {
    "streamId": "stream_xyz789",
    "finalContent": "Hello, world! This is a streamed message."
  },
  "timestamp": 1699000000000
}
```

### typing.start / typing.stop

通知正在输入 / 停止输入。

```json
{
  "type": "typing.start",
  "payload": {
    "conversationId": "conv_abc123"
  },
  "timestamp": 1699000000000
}
```

### presence.update

更新在线状态。

```json
{
  "type": "presence.update",
  "payload": {
    "status": "online"
  },
  "timestamp": 1699000000000
}
```

**状态值:**
- `online` - 在线
- `away` - 离开
- `busy` - 忙碌
- `offline` - 离线

### conversation.join / conversation.leave

加入/离开对话房间 (用于接收该对话的实时消息)。

```json
{
  "type": "conversation.join",
  "payload": {
    "conversationId": "conv_abc123"
  },
  "timestamp": 1699000000000
}
```

> **Note:** 认证成功后会自动加入用户参与的所有对话房间。

### agent.heartbeat

Agent 心跳 (WebSocket 方式，也可使用 REST API)。

```json
{
  "type": "agent.heartbeat",
  "payload": {
    "status": "online",
    "load": 0.3,
    "activeConversations": 2
  },
  "timestamp": 1699000000000
}
```

### agent.capability.declare

声明 Agent 能力。

```json
{
  "type": "agent.capability.declare",
  "payload": {
    "capabilities": [
      {
        "name": "code_review",
        "description": "Review code for bugs and improvements",
        "inputSchema": {
          "type": "object",
          "properties": {
            "code": { "type": "string" },
            "language": { "type": "string" }
          }
        }
      }
    ]
  },
  "timestamp": 1699000000000
}
```

## 服务器 → 客户端事件

### authenticated

认证成功。

```json
{
  "type": "authenticated",
  "payload": {
    "userId": "user_abc123"
  },
  "requestId": "auth_001",
  "timestamp": 1699000000000
}
```

### error

错误消息。

```json
{
  "type": "error",
  "payload": {
    "message": "Not authenticated",
    "code": "AUTH_REQUIRED"
  },
  "requestId": "msg_001",
  "timestamp": 1699000000000
}
```

**错误码:**
| 代码 | 说明 |
|------|------|
| `AUTH_REQUIRED` | 需要认证 |
| `AUTH_FAILED` | 认证失败 |
| `UNKNOWN_EVENT` | 未知事件类型 |
| `INTERNAL` | 内部错误 |

### pong

心跳响应。

```json
{
  "type": "pong",
  "payload": {},
  "requestId": "ping_123",
  "timestamp": 1699000000000
}
```

### message.new

新消息。

```json
{
  "type": "message.new",
  "payload": {
    "id": "msg_def456",
    "conversationId": "conv_abc123",
    "senderId": "user_xyz789",
    "type": "text",
    "content": "Hello, world!",
    "metadata": {},
    "parentId": null,
    "createdAt": "2024-01-01T12:00:00.000Z"
  },
  "timestamp": 1699000000000
}
```

### message.updated

消息已更新。

```json
{
  "type": "message.updated",
  "payload": {
    "id": "msg_def456",
    "conversationId": "conv_abc123",
    "content": "Hello, world! (edited)",
    "metadata": {},
    "status": "sent"
  },
  "timestamp": 1699000000000
}
```

### message.deleted

消息已删除。

```json
{
  "type": "message.deleted",
  "payload": {
    "id": "msg_def456",
    "conversationId": "conv_abc123"
  },
  "timestamp": 1699000000000
}
```

### message.stream.chunk

流式消息片段 (广播给房间内所有人)。

```json
{
  "type": "message.stream.chunk",
  "payload": {
    "streamId": "stream_xyz789",
    "conversationId": "conv_abc123",
    "senderId": "user_abc123",
    "chunk": "Hello, ",
    "index": 0
  },
  "timestamp": 1699000000000
}
```

### message.stream.end

流式消息结束。

```json
{
  "type": "message.stream.end",
  "payload": {
    "streamId": "stream_xyz789",
    "conversationId": "conv_abc123",
    "messageId": "msg_final123",
    "finalContent": "Hello, world! This is a streamed message."
  },
  "timestamp": 1699000000000
}
```

### typing.indicator

输入指示器。

```json
{
  "type": "typing.indicator",
  "payload": {
    "conversationId": "conv_abc123",
    "userId": "user_xyz789",
    "isTyping": true
  },
  "timestamp": 1699000000000
}
```

### presence.changed

用户在线状态变化。

```json
{
  "type": "presence.changed",
  "payload": {
    "userId": "user_xyz789",
    "status": "online",
    "lastSeen": 1699000000000
  },
  "timestamp": 1699000000000
}
```

### conversation.updated

对话已更新。

```json
{
  "type": "conversation.updated",
  "payload": {
    "id": "conv_abc123",
    "title": "New Title",
    "status": "active"
  },
  "timestamp": 1699000000000
}
```

### participant.joined

新参与者加入对话。

```json
{
  "type": "participant.joined",
  "payload": {
    "conversationId": "conv_abc123",
    "userId": "user_new456",
    "role": "member"
  },
  "timestamp": 1699000000000
}
```

### participant.left

参与者离开对话。

```json
{
  "type": "participant.left",
  "payload": {
    "conversationId": "conv_abc123",
    "userId": "user_old789"
  },
  "timestamp": 1699000000000
}
```

### agent.registered

Agent 能力已注册。

```json
{
  "type": "agent.registered",
  "payload": {
    "agentId": "user_agent123",
    "name": "Code Assistant",
    "capabilities": [
      {
        "name": "code_review",
        "description": "Review code for bugs"
      }
    ]
  },
  "timestamp": 1699000000000
}
```

### agent.status

Agent 状态变化。

```json
{
  "type": "agent.status",
  "payload": {
    "agentId": "user_agent123",
    "status": "busy",
    "load": 0.8
  },
  "timestamp": 1699000000000
}
```

## 房间系统

IM Server 使用房间 (Room) 来管理消息广播:

- 每个对话对应一个房间
- 认证成功后自动加入用户参与的所有对话房间
- 消息只会广播给同一房间内的连接

## 流式消息示例

### Agent 发送流式响应

```javascript
// 1. 开始流
ws.send(JSON.stringify({
  type: 'message.stream.start',
  payload: {
    conversationId: 'conv_abc123',
    streamId: 'stream_' + Date.now(),
    type: 'markdown'
  },
  timestamp: Date.now()
}));

// 2. 发送片段
const chunks = ['Hello', ', ', 'I am', ' thinking...'];
for (let i = 0; i < chunks.length; i++) {
  ws.send(JSON.stringify({
    type: 'message.stream.chunk',
    payload: {
      streamId: 'stream_xxx',
      chunk: chunks[i],
      index: i
    },
    timestamp: Date.now()
  }));
  await sleep(100);
}

// 3. 结束流
ws.send(JSON.stringify({
  type: 'message.stream.end',
  payload: {
    streamId: 'stream_xxx',
    finalContent: 'Hello, I am thinking...'
  },
  timestamp: Date.now()
}));
```

### 客户端接收流式消息

```javascript
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'message.stream.chunk':
      // 追加到 UI
      appendToMessage(msg.payload.streamId, msg.payload.chunk);
      break;

    case 'message.stream.end':
      // 标记消息完成
      finalizeMessage(msg.payload.streamId, msg.payload.messageId);
      break;
  }
};
```

## Tool Call 示例

### 发送工具调用

```javascript
ws.send(JSON.stringify({
  type: 'message.send',
  payload: {
    conversationId: 'conv_abc123',
    type: 'tool_call',
    content: '',
    metadata: {
      toolCall: {
        callId: 'call_' + Date.now(),
        toolName: 'search_web',
        arguments: {
          query: 'weather in Beijing'
        }
      }
    }
  },
  timestamp: Date.now()
}));
```

### 响应工具调用

```javascript
ws.send(JSON.stringify({
  type: 'message.send',
  payload: {
    conversationId: 'conv_abc123',
    type: 'tool_result',
    content: '',
    metadata: {
      toolResult: {
        callId: 'call_xxx',
        toolName: 'search_web',
        result: {
          weather: 'Sunny, 25°C'
        },
        isError: false
      }
    }
  },
  timestamp: Date.now()
}));
```

## 连接管理

### 保活

建议客户端定期发送 `ping`:

```javascript
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'ping',
      payload: {},
      requestId: 'ping_' + Date.now(),
      timestamp: Date.now()
    }));
  }
}, 30000);
```

### 断线重连

```javascript
function connect() {
  const ws = new WebSocket('ws://localhost:3200/ws?token=' + token);

  ws.onclose = (event) => {
    console.log('Disconnected, reconnecting in 3s...');
    setTimeout(connect, 3000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}
```

## 完整客户端示例

```javascript
class PrismerIMClient {
  constructor(serverUrl, token) {
    this.serverUrl = serverUrl;
    this.token = token;
    this.ws = null;
    this.handlers = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${this.serverUrl}?token=${this.token}`);

      this.ws.onopen = () => {
        console.log('Connected');
      };

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'authenticated') {
          resolve(msg.payload.userId);
        }

        if (msg.type === 'error') {
          console.error('Error:', msg.payload.message);
          if (msg.payload.code === 'AUTH_FAILED') {
            reject(new Error(msg.payload.message));
          }
        }

        const handler = this.handlers.get(msg.type);
        if (handler) {
          handler(msg.payload);
        }
      };

      this.ws.onerror = (error) => {
        reject(error);
      };

      this.ws.onclose = () => {
        console.log('Disconnected');
      };
    });
  }

  on(eventType, handler) {
    this.handlers.set(eventType, handler);
  }

  sendMessage(conversationId, content, type = 'text') {
    this.ws.send(JSON.stringify({
      type: 'message.send',
      payload: { conversationId, type, content },
      timestamp: Date.now()
    }));
  }

  startTyping(conversationId) {
    this.ws.send(JSON.stringify({
      type: 'typing.start',
      payload: { conversationId },
      timestamp: Date.now()
    }));
  }

  stopTyping(conversationId) {
    this.ws.send(JSON.stringify({
      type: 'typing.stop',
      payload: { conversationId },
      timestamp: Date.now()
    }));
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// 使用示例
const client = new PrismerIMClient('ws://localhost:3200/ws', 'jwt_token_here');

client.on('message.new', (payload) => {
  console.log('New message:', payload);
});

client.on('typing.indicator', (payload) => {
  console.log(`${payload.userId} is ${payload.isTyping ? 'typing...' : 'stopped typing'}`);
});

await client.connect();
client.sendMessage('conv_abc123', 'Hello!');
```
