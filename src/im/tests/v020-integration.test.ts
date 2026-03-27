/**
 * Prismer IM v0.2.0 Integration Tests
 *
 * Tests: Register, /me, Contacts, Discover, Unread, Token Refresh, E2E flows
 *
 * Usage: DATABASE_URL="file:./prisma/data/dev.db" npx tsx src/im/tests/v020-integration.test.ts
 */

const BASE = process.env.IM_BASE_URL || "http://localhost:3200";

// ─── Test Infrastructure ────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    const msg = err.message || String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual: any, expected: any, field: string) {
  if (actual !== expected) {
    throw new Error(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function api(
  method: string,
  path: string,
  body?: any,
  token?: string
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  return { status: res.status, data };
}

// ─── Test State ─────────────────────────────────────────────
// We'll use the existing users/login endpoint to create initial JWT tokens
// Then test the new v0.2.0 features

let agentAToken = "";
let agentAId = "";
let agentBToken = "";
let agentBId = "";
let humanToken = "";
let humanId = "";

// ─── Helper: Register via old /users/register ──────────────
async function createTestUser(
  username: string,
  displayName: string,
  role: string = "human",
  agentType?: string
): Promise<{ id: string; token: string }> {
  const res = await api("POST", "/users/register", {
    username,
    displayName,
    role,
    agentType,
  });
  if (!res.data.ok) {
    // Maybe already exists, try login
    const loginRes = await api("POST", "/users/login", { username });
    if (!loginRes.data.ok) {
      throw new Error(`Cannot create/login user ${username}: ${JSON.stringify(res.data)}`);
    }
    return { id: loginRes.data.data.user.id, token: loginRes.data.data.token };
  }
  return { id: res.data.data.user.id, token: res.data.data.token };
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 1: Agent Self-Registration
// ═══════════════════════════════════════════════════════════

async function testRegistration() {
  console.log("\n🔹 Registration Tests");

  // First create a user via old API to get a token (simulates API Key proxy creating a user)
  const setupUser = await createTestUser(
    `setup_user_${String(Date.now()).slice(-8)}`,
    "Setup User"
  );
  const setupToken = setupUser.token;

  await test("R1: Agent first registration", async () => {
    const username = `test_agent_r1_${String(Date.now()).slice(-8)}`;
    const res = await api("POST", "/register", {
      type: "agent",
      username,
      displayName: "Test Agent R1",
      agentType: "specialist",
      capabilities: ["code", "review"],
      description: "A test agent",
    }, setupToken);

    assertEqual(res.data.ok, true, "ok");
    assert(res.data.data.imUserId, "should have imUserId");
    assert(res.data.data.token, "should have token");
    assertEqual(res.data.data.username, username, "username");
    assertEqual(res.data.data.role, "agent", "role");
    assert(Array.isArray(res.data.data.capabilities), "should have capabilities");
    assert(res.data.data.capabilities.includes("code"), "should include 'code' capability");

    // Save for later tests
    agentAToken = res.data.data.token;
    agentAId = res.data.data.imUserId;
  });

  await test("R2: Agent re-registration (update)", async () => {
    // Use the same token from R1 to update capabilities
    const ts = String(Date.now()).slice(-8);
    const res = await api("POST", "/register", {
      type: "agent",
      username: `agent_upd_${ts}`,
      displayName: "Updated Agent",
      agentType: "specialist",
      capabilities: ["code", "review", "debug"],
    }, agentAToken);

    if (!res.data.ok) {
      throw new Error(`Registration failed: ${res.data.error} (status: ${res.status})`);
    }

    assertEqual(res.data.data.imUserId, agentAId, "imUserId should be same");
    assertEqual(res.data.data.isNew, false, "isNew should be false");
    assert(res.data.data.capabilities.includes("debug"), "should include new capability");

    // Update token
    agentAToken = res.data.data.token;
  });

  // Create Agent B
  const setupUser2 = await createTestUser(
    `setup_user2_${String(Date.now()).slice(-8)}`,
    "Setup User 2"
  );

  await test("R3: Second agent registration", async () => {
    const username = `test_agent_b_${String(Date.now()).slice(-8)}`;
    const res = await api("POST", "/register", {
      type: "agent",
      username,
      displayName: "Agent B - Search",
      agentType: "assistant",
      capabilities: ["search", "summarize"],
    }, setupUser2.token);

    assertEqual(res.data.ok, true, "ok");
    agentBToken = res.data.data.token;
    agentBId = res.data.data.imUserId;
  });

  await test("R4: Invalid username (too short)", async () => {
    const res = await api("POST", "/register", {
      type: "agent",
      username: "ab",
      displayName: "Bad Agent",
    }, setupToken);

    assertEqual(res.data.ok, false, "ok should be false");
    assertEqual(res.status, 400, "status");
  });

  await test("R5: Invalid username (special chars)", async () => {
    const res = await api("POST", "/register", {
      type: "agent",
      username: "bad agent!@#",
      displayName: "Bad Agent",
    }, setupToken);

    assertEqual(res.data.ok, false, "ok should be false");
    assertEqual(res.status, 400, "status");
  });

  await test("R6: Missing auth header", async () => {
    const res = await api("POST", "/register", {
      type: "agent",
      username: "noauth_agent",
      displayName: "No Auth",
    });

    assertEqual(res.status, 401, "status");
  });

  await test("R7: Human registration", async () => {
    const setupUser3 = await createTestUser(
      `setup_human_${String(Date.now()).slice(-8)}`,
      "Setup Human"
    );
    const username = `test_human_${String(Date.now()).slice(-8)}`;
    const res = await api("POST", "/register", {
      type: "human",
      username,
      displayName: "Test Human",
    }, setupUser3.token);

    assertEqual(res.data.ok, true, "ok");
    assertEqual(res.data.data.role, "human", "role");
    assert(!res.data.data.capabilities, "human should not have capabilities");

    humanToken = res.data.data.token;
    humanId = res.data.data.imUserId;
  });

  await test("R8: Missing required fields", async () => {
    const res = await api("POST", "/register", {
      type: "agent",
    }, setupToken);

    assertEqual(res.data.ok, false, "ok should be false");
    assertEqual(res.status, 400, "status");
  });

  await test("R9: Invalid type", async () => {
    const res = await api("POST", "/register", {
      type: "invalid",
      username: "test_invalid",
      displayName: "Invalid",
    }, setupToken);

    assertEqual(res.data.ok, false, "ok should be false");
    assertEqual(res.status, 400, "status");
  });
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 2: Self-Awareness (/me)
// ═══════════════════════════════════════════════════════════

async function testMe() {
  console.log("\n🔹 Self-Awareness (/me) Tests");

  await test("M1: Agent self-awareness", async () => {
    const res = await api("GET", "/me", undefined, agentAToken);

    assertEqual(res.data.ok, true, "ok");
    assert(res.data.data.user, "should have user");
    assertEqual(res.data.data.user.id, agentAId, "user.id");
    assertEqual(res.data.data.user.role, "agent", "user.role");
    assert(res.data.data.stats, "should have stats");
    assert(typeof res.data.data.stats.conversationCount === "number", "should have conversationCount");
    assert(typeof res.data.data.stats.messagesSent === "number", "should have messagesSent");
    assert(typeof res.data.data.stats.unreadCount === "number", "should have unreadCount");
    assert(res.data.data.agentCard, "agent should have agentCard");
    assert(Array.isArray(res.data.data.agentCard.capabilities), "should have capabilities array");
  });

  await test("M2: Human self-awareness", async () => {
    const res = await api("GET", "/me", undefined, humanToken);

    assertEqual(res.data.ok, true, "ok");
    assertEqual(res.data.data.user.id, humanId, "user.id");
    assertEqual(res.data.data.user.role, "human", "user.role");
    assert(res.data.data.stats, "should have stats");
    // Human should not have agentCard
    assert(!res.data.data.agentCard, "human should not have agentCard");
  });

  await test("M3: /me without auth", async () => {
    const res = await api("GET", "/me");

    assertEqual(res.status, 401, "status");
  });
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 3: Contacts System
// ═══════════════════════════════════════════════════════════

async function testContacts() {
  console.log("\n🔹 Contacts Tests");

  await test("C1: Empty contacts list", async () => {
    const res = await api("GET", "/contacts", undefined, agentAToken);

    assertEqual(res.data.ok, true, "ok");
    assert(Array.isArray(res.data.data), "should be array");
    // May have contacts from previous test runs, just verify structure
  });

  // Create a direct conversation between Agent A and Human
  await test("C2: Contact appears after direct message", async () => {
    // Create direct conversation
    const convRes = await api("POST", "/conversations/direct", {
      otherUserId: humanId,
    }, agentAToken);

    assertEqual(convRes.data.ok, true, "create conversation ok");
    const convId = convRes.data.data.id;

    // Send a message
    const msgRes = await api("POST", `/messages/${convId}`, {
      content: "Hello human, this is Agent A!",
      type: "text",
    }, agentAToken);

    assertEqual(msgRes.data.ok, true, "send message ok");

    // Check Agent A's contacts - Human should appear
    const contactsRes = await api("GET", "/contacts", undefined, agentAToken);
    assertEqual(contactsRes.data.ok, true, "contacts ok");

    const humanContact = contactsRes.data.data.find(
      (c: any) => c.userId === humanId
    );
    assert(humanContact, "human should be in agent's contacts");
    assertEqual(humanContact.role, "human", "contact role");
    assert(humanContact.conversationId, "should have conversationId");
  });

  // Create conversation between Agent A and Agent B
  await test("C3: Contacts after group chat", async () => {
    // Create group with Agent A, Agent B, and Human
    const groupRes = await api("POST", "/conversations/group", {
      title: "Test Group",
      memberIds: [agentBId, humanId],
    }, agentAToken);

    assertEqual(groupRes.data.ok, true, "create group ok");
    const groupId = groupRes.data.data.id;

    // Send a message in the group
    await api("POST", `/messages/${groupId}`, {
      content: "Group message from Agent A",
      type: "text",
    }, agentAToken);

    // Check Agent B's contacts - Agent A and Human should appear
    const contactsRes = await api("GET", "/contacts", undefined, agentBToken);
    assertEqual(contactsRes.data.ok, true, "contacts ok");

    const agentAContact = contactsRes.data.data.find(
      (c: any) => c.userId === agentAId
    );
    assert(agentAContact, "Agent A should be in Agent B's contacts");
  });

  await test("C4: Filter contacts by role", async () => {
    const res = await api("GET", "/contacts?role=agent", undefined, humanToken);
    assertEqual(res.data.ok, true, "ok");

    // All results should be agents
    for (const contact of res.data.data) {
      assertEqual(contact.role, "agent", "filtered contact role");
    }
  });

  await test("C5: Contacts pagination", async () => {
    const res = await api("GET", "/contacts?limit=1&offset=0", undefined, agentAToken);
    assertEqual(res.data.ok, true, "ok");
    assert(res.data.data.length <= 1, "should respect limit");
    assert(typeof res.data.meta.total === "number", "should have total");
  });
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 4: Discovery
// ═══════════════════════════════════════════════════════════

async function testDiscover() {
  console.log("\n🔹 Discovery Tests");

  await test("C7: Discover agents", async () => {
    const res = await api("GET", "/discover?type=agent", undefined, humanToken);

    assertEqual(res.data.ok, true, "ok");
    assert(Array.isArray(res.data.data), "should be array");
    assert(res.data.data.length > 0, "should find some agents");

    // All results should be agents
    for (const agent of res.data.data) {
      assertEqual(agent.role, "agent", "discovered role");
    }
  });

  await test("C8: Discover by capability", async () => {
    const res = await api(
      "GET",
      "/discover?type=agent&capability=code",
      undefined,
      humanToken
    );

    assertEqual(res.data.ok, true, "ok");

    // All results should have 'code' capability
    for (const agent of res.data.data) {
      assert(
        agent.capabilities && agent.capabilities.some((c: string) =>
          c.toLowerCase().includes("code")
        ),
        `agent ${agent.username} should have 'code' capability`
      );
    }
  });

  await test("C9: Discover with keyword search", async () => {
    const res = await api(
      "GET",
      "/discover?q=Search",
      undefined,
      humanToken
    );

    assertEqual(res.data.ok, true, "ok");
    // Results should match the search query
    if (res.data.data.length > 0) {
      const match = res.data.data.some(
        (a: any) =>
          a.username.toLowerCase().includes("search") ||
          a.displayName.toLowerCase().includes("search")
      );
      assert(match, "should find agents matching 'Search'");
    }
  });

  await test("C10: isContact flag", async () => {
    const res = await api("GET", "/discover?type=agent", undefined, humanToken);

    assertEqual(res.data.ok, true, "ok");
    // At least Agent A should be a contact (we had a conversation)
    const agentA = res.data.data.find((a: any) => a.userId === agentAId);
    if (agentA) {
      assertEqual(agentA.isContact, true, "Agent A should be a contact");
    }
  });

  await test("C11: Discover excludes self", async () => {
    const res = await api("GET", "/discover", undefined, agentAToken);

    assertEqual(res.data.ok, true, "ok");
    const self = res.data.data.find((a: any) => a.userId === agentAId);
    assert(!self, "should not discover self");
  });
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 5: Unread Tracking
// ═══════════════════════════════════════════════════════════

async function testUnread() {
  console.log("\n🔹 Unread Tracking Tests");

  // Create a fresh direct conversation
  const convRes = await api("POST", "/conversations/direct", {
    otherUserId: agentBId,
  }, agentAToken);
  const convId = convRes.data.data.id;

  await test("U1: New conversation has zero unread", async () => {
    const res = await api(
      "GET",
      "/conversations?withUnread=true",
      undefined,
      agentBToken
    );

    assertEqual(res.data.ok, true, "ok");
    const conv = res.data.data.find((c: any) => c.id === convId);
    if (conv) {
      assertEqual(conv.unreadCount, 0, "unreadCount");
    }
  });

  await test("U2: Unread increases after receiving message", async () => {
    // Agent A sends a message
    await api("POST", `/messages/${convId}`, {
      content: "Message 1 from A",
      type: "text",
    }, agentAToken);

    await api("POST", `/messages/${convId}`, {
      content: "Message 2 from A",
      type: "text",
    }, agentAToken);

    // Agent B checks unread
    const res = await api(
      "GET",
      "/conversations?withUnread=true",
      undefined,
      agentBToken
    );

    assertEqual(res.data.ok, true, "ok");
    const conv = res.data.data.find((c: any) => c.id === convId);
    assert(conv, "should find conversation");
    assert(conv.unreadCount >= 2, `unreadCount should be >= 2, got ${conv.unreadCount}`);
  });

  await test("U3: Mark as read resets unread count", async () => {
    // Agent B marks as read
    const readRes = await api("POST", `/conversations/${convId}/read`, undefined, agentBToken);
    assertEqual(readRes.data.ok, true, "mark read ok");

    // Check unread again
    const res = await api(
      "GET",
      "/conversations?withUnread=true",
      undefined,
      agentBToken
    );

    const conv = res.data.data.find((c: any) => c.id === convId);
    assert(conv, "should find conversation");
    assertEqual(conv.unreadCount, 0, "unreadCount after read");
  });

  await test("U4: Own messages don't count as unread", async () => {
    // Agent B sends a message
    await api("POST", `/messages/${convId}`, {
      content: "Reply from B",
      type: "text",
    }, agentBToken);

    // Agent B checks unread - own message shouldn't count
    const res = await api(
      "GET",
      "/conversations?withUnread=true",
      undefined,
      agentBToken
    );

    const conv = res.data.data.find((c: any) => c.id === convId);
    assert(conv, "should find conversation");
    assertEqual(conv.unreadCount, 0, "own message should not be unread");
  });

  await test("U5: /me shows total unread", async () => {
    // Agent A sends another message so Agent B has unread
    await api("POST", `/messages/${convId}`, {
      content: "New message from A",
      type: "text",
    }, agentAToken);

    const res = await api("GET", "/me", undefined, agentBToken);
    assertEqual(res.data.ok, true, "ok");
    assert(res.data.data.stats.unreadCount >= 1, "should have unread in /me");
  });

  await test("U6: unreadOnly filter", async () => {
    const res = await api(
      "GET",
      "/conversations?unreadOnly=true",
      undefined,
      agentBToken
    );

    assertEqual(res.data.ok, true, "ok");
    // All returned conversations should have unread > 0
    for (const conv of res.data.data) {
      assert(conv.unreadCount > 0, `unreadOnly conversation should have unread > 0`);
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 6: Token Refresh
// ═══════════════════════════════════════════════════════════

async function testTokenRefresh() {
  console.log("\n🔹 Token Refresh Tests");

  await test("T1: Refresh valid token", async () => {
    // Wait 1.1s so JWT iat differs (JWT timestamps are in seconds)
    await new Promise((r) => setTimeout(r, 1100));
    const res = await api("POST", "/token/refresh", undefined, agentAToken);

    assertEqual(res.data.ok, true, "ok");
    assert(res.data.data.token, "should have new token");
    assert(res.data.data.token !== agentAToken, "should be a different token");
    assertEqual(res.data.data.expiresIn, "7d", "expiresIn");
  });

  await test("T2: New token works", async () => {
    const refreshRes = await api("POST", "/token/refresh", undefined, agentAToken);
    const newToken = refreshRes.data.data.token;

    const meRes = await api("GET", "/me", undefined, newToken);
    assertEqual(meRes.data.ok, true, "ok");
    assertEqual(meRes.data.data.user.id, agentAId, "same user");

    // Update token for subsequent tests
    agentAToken = newToken;
  });

  await test("T3: Old token still works (not expired)", async () => {
    // The old token should still work until expiry
    const meRes = await api("GET", "/me", undefined, agentAToken);
    assertEqual(meRes.data.ok, true, "old token should still work");
  });

  await test("T4: Refresh without auth", async () => {
    const res = await api("POST", "/token/refresh");
    assertEqual(res.status, 401, "status");
  });
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 7: End-to-End Integration
// ═══════════════════════════════════════════════════════════

async function testE2E() {
  console.log("\n🔹 End-to-End Integration Tests");

  await test("E1: Agent complete lifecycle", async () => {
    // 1. Register
    const setupUser = await createTestUser(
      `e2e_setup_${String(Date.now()).slice(-8)}`,
      "E2E Setup"
    );
    const regRes = await api("POST", "/register", {
      type: "agent",
      username: `e2e_agent_${String(Date.now()).slice(-8)}`,
      displayName: "E2E Agent",
      agentType: "assistant",
      capabilities: ["chat"],
    }, setupUser.token);
    assertEqual(regRes.data.ok, true, "register ok");
    const e2eToken = regRes.data.data.token;
    const e2eId = regRes.data.data.imUserId;

    // 2. Self-awareness
    const meRes = await api("GET", "/me", undefined, e2eToken);
    assertEqual(meRes.data.ok, true, "/me ok");
    assertEqual(meRes.data.data.user.id, e2eId, "identity matches");

    // 3. Discover others
    const discoverRes = await api("GET", "/discover?type=agent", undefined, e2eToken);
    assertEqual(discoverRes.data.ok, true, "discover ok");

    // 4. Create conversation and send message
    const target = discoverRes.data.data[0];
    if (target) {
      const convRes = await api("POST", "/conversations/direct", {
        otherUserId: target.userId,
      }, e2eToken);
      assertEqual(convRes.data.ok, true, "create conv ok");

      const msgRes = await api("POST", `/messages/${convRes.data.data.id}`, {
        content: "Hello from E2E test!",
        type: "text",
      }, e2eToken);
      assertEqual(msgRes.data.ok, true, "send message ok");

      // 5. Check contacts
      const contactsRes = await api("GET", "/contacts", undefined, e2eToken);
      assertEqual(contactsRes.data.ok, true, "contacts ok");
      const hasTarget = contactsRes.data.data.some(
        (c: any) => c.userId === target.userId
      );
      assert(hasTarget, "target should be in contacts");

      // 6. Mark as read
      const readRes = await api(
        "POST",
        `/conversations/${convRes.data.data.id}/read`,
        undefined,
        e2eToken
      );
      assertEqual(readRes.data.ok, true, "mark read ok");
    }
  });

  await test("E2: Multi-agent collaboration", async () => {
    // Agent A creates a group, adds Agent B and Human
    const groupRes = await api("POST", "/conversations/group", {
      title: "E2E Collaboration Test",
      memberIds: [agentBId, humanId],
    }, agentAToken);
    assertEqual(groupRes.data.ok, true, "create group ok");
    const groupId = groupRes.data.data.id;

    // Agent A sends message
    await api("POST", `/messages/${groupId}`, {
      content: "Hello team!",
      type: "text",
    }, agentAToken);

    // Agent B sends message
    await api("POST", `/messages/${groupId}`, {
      content: "Hi Agent A!",
      type: "text",
    }, agentBToken);

    // Human checks contacts - both agents should appear
    const contactsRes = await api("GET", "/contacts?role=agent", undefined, humanToken);
    assertEqual(contactsRes.data.ok, true, "contacts ok");
    assert(contactsRes.data.data.length >= 2, "should have at least 2 agent contacts");

    // Human checks unread
    const convRes = await api(
      "GET",
      "/conversations?withUnread=true",
      undefined,
      humanToken
    );
    assertEqual(convRes.data.ok, true, "conversations ok");
    const group = convRes.data.data.find((c: any) => c.id === groupId);
    assert(group, "should find group");
    assert(group.unreadCount >= 2, `should have >= 2 unread messages, got ${group.unreadCount}`);

    // Human marks read
    await api("POST", `/conversations/${groupId}/read`, undefined, humanToken);

    // Verify unread is 0
    const convRes2 = await api(
      "GET",
      "/conversations?withUnread=true",
      undefined,
      humanToken
    );
    const group2 = convRes2.data.data.find((c: any) => c.id === groupId);
    assertEqual(group2.unreadCount, 0, "unread should be 0 after mark read");
  });

  await test("E4: Human + Agent interaction with full flow", async () => {
    // Human sends a message to Agent A via direct API
    const convRes = await api("POST", "/conversations/direct", {
      otherUserId: agentAId,
    }, humanToken);
    const convId = convRes.data.data.id;

    // Human sends
    await api("POST", `/messages/${convId}`, {
      content: "Hey Agent A, can you help me?",
      type: "text",
    }, humanToken);

    // Agent A checks /me for unread
    const meRes = await api("GET", "/me", undefined, agentAToken);
    assert(meRes.data.data.stats.unreadCount >= 1, "Agent A should have unread");

    // Agent A reads messages
    const historyRes = await api(
      "GET",
      `/messages/${convId}?limit=10`,
      undefined,
      agentAToken
    );
    assertEqual(historyRes.data.ok, true, "history ok");
    assert(historyRes.data.data.length >= 1, "should have messages");

    // Agent A marks read
    await api("POST", `/conversations/${convId}/read`, undefined, agentAToken);

    // Agent A replies
    await api("POST", `/messages/${convId}`, {
      content: "Sure, I can help!",
      type: "text",
    }, agentAToken);

    // Verify Agent A's stats updated
    const meRes2 = await api("GET", "/me", undefined, agentAToken);
    assert(
      meRes2.data.data.stats.messagesSent >= 1,
      "messagesSent should be >= 1"
    );
  });
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════╗");
  console.log("║   Prismer IM v0.2.0 Integration Tests    ║");
  console.log("╚═══════════════════════════════════════════╝");
  console.log(`\nServer: ${BASE}`);

  // Verify server is running
  try {
    const health = await api("GET", "/health");
    console.log(`Health: ${health.data.ok ? "✅" : "❌"} (v${health.data.version})`);
  } catch (err) {
    console.error("❌ Cannot connect to IM server. Is it running?");
    process.exit(1);
  }

  const startTime = Date.now();

  await testRegistration();
  await testMe();
  await testContacts();
  await testDiscover();
  await testUnread();
  await testTokenRefresh();
  await testE2E();

  const elapsed = Date.now() - startTime;

  console.log("\n═══════════════════════════════════════════");
  console.log(`Total: ${passed + failed} tests | ✅ ${passed} passed | ❌ ${failed} failed`);
  console.log(`Time: ${elapsed}ms`);

  if (failures.length > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  • ${f}`));
  }

  console.log("═══════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
