/**
 * lcc-chat smoke test — runs against `wrangler dev` (see package.json `test`).
 *
 * Covers the testing priorities from the project instructions:
 *   - no-sign-up sessions + auth enforcement
 *   - deterministic DM ids and DM isolation
 *   - live messaging over WebSockets with optimistic-id reconciliation
 *   - persistence after reload, read receipts / unread counts
 *   - unauthorized access attempts
 */

const BASE = process.env.LCC_BASE_URL ?? "http://127.0.0.1:8787";

let passed = 0;
let failed = 0;

function ok(name, condition, extra = "") {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name} ${extra}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function api(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

/** Minimal promise-based socket wrapper for the tests. */
function openSocket(path, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${BASE.replace(/^http/, "ws")}${path}`);
    const inbox = [];
    const waiters = [];

    const api = {
      socket,
      closed: false,
      send: (payload) => socket.send(JSON.stringify(payload)),
      waitFor: (predicate, timeoutMs = 8000) =>
        new Promise((resolveWait, rejectWait) => {
          const existing = inbox.find(predicate);
          if (existing) return resolveWait(existing);
          const waiter = { predicate, resolve: resolveWait };
          waiters.push(waiter);
          setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
              rejectWait(new Error("timeout waiting for socket event"));
            }
          }, timeoutMs);
          return undefined;
        }),
      close: () => socket.close(1000, "test"),
    };

    socket.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      inbox.push(data);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(data)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(data);
        }
      }
    });

    const fail = (event) => {
      api.closed = true;
      if (allowFailure) resolve(api);
      else reject(new Error("socket error", { cause: event }));
    };
    socket.addEventListener("error", fail);
    socket.addEventListener("close", () => {
      api.closed = true;
      if (allowFailure) resolve(api);
    });

    socket.addEventListener("open", () => resolve(api));
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`lcc-chat smoke test against ${BASE}`);

  section("health");
  const health = await api("/health");
  ok("GET /health responds", health.status === 200 && health.data?.ok === true, JSON.stringify(health.data));

  section("no sign-up: a display name is all you need");
  const alice = await api("/api/session", { method: "POST", body: { displayName: "Alice Tester" } });
  ok("session created", alice.status === 201 && Boolean(alice.data?.token), JSON.stringify(alice.data));
  ok("profile has username", alice.data?.user?.username === "alicetester", alice.data?.user?.username);

  const bob = await api("/api/session", { method: "POST", body: { displayName: "Bob Tester" } });
  ok("second session created", bob.status === 201 && Boolean(bob.data?.token));
  const carol = await api("/api/session", { method: "POST", body: { displayName: "Carol Outsider" } });
  ok("third session created", carol.status === 201 && Boolean(carol.data?.token));

  const badName = await api("/api/session", { method: "POST", body: { displayName: "x" } });
  ok("rejects a 1-character name", badName.status === 422 && badName.data?.error?.code === "VALIDATION_FAILED", JSON.stringify(badName.data));

  section("authentication is required");
  const anonymous = await api("/api/conversations");
  ok("no token -> 401 UNAUTHORIZED", anonymous.status === 401 && anonymous.data?.error?.code === "UNAUTHORIZED", JSON.stringify(anonymous.data));
  const forged = await api("/api/conversations", { token: "lcc1.abc.def" });
  ok("forged token -> 401", forged.status === 401, JSON.stringify(forged.data));
  const me = await api("/api/me", { token: alice.data.token });
  ok("GET /api/me returns the token owner", me.status === 200 && me.data.user.id === alice.data.user.id);
  ok("user id is derived from the token, not the body", me.data.user.displayName === "Alice Tester");

  section("deterministic DM ids");
  const aliceId = alice.data.user.id;
  const bobId = bob.data.user.id;
  const dm1 = await api("/api/conversations/dm", { method: "POST", token: alice.data.token, body: { userId: bobId } });
  const dm2 = await api("/api/conversations/dm", { method: "POST", token: bob.data.token, body: { userId: aliceId } });
  ok("DM created", dm1.status === 201, JSON.stringify(dm1.data));
  ok("same thread from both sides", dm1.data?.conversation?.id === dm2.data?.conversation?.id, `${dm1.data?.conversation?.id} vs ${dm2.data?.conversation?.id}`);
  const [low, high] = [aliceId, bobId].sort();
  ok("id is dm:<sorted>:<sorted>", dm1.data?.conversation?.id === `dm:${low}:${high}`, dm1.data?.conversation?.id);

  const selfDm = await api("/api/conversations/dm", { method: "POST", token: alice.data.token, body: { userId: aliceId } });
  ok("cannot DM yourself", selfDm.status === 422, JSON.stringify(selfDm.data));

  section("authorization: outsiders stay out");
  const conversationId = dm1.data.conversation.id;
  const outsiderHistory = await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { token: carol.data.token });
  ok("outsider cannot read history", outsiderHistory.status === 403 && outsiderHistory.data?.error?.code === "FORBIDDEN", JSON.stringify(outsiderHistory.data));

  const outsiderSocket = await openSocket(`/ws?conversationId=${encodeURIComponent(conversationId)}&token=${carol.data.token}`, {
    allowFailure: true,
  });
  await wait(500);
  ok("outsider socket never opens", outsiderSocket.closed || outsiderSocket.socket.readyState !== 1);
  ok(
    "room refuses the outsider upgrade",
    outsiderSocket.socket.readyState === 3,
    `readyState=${outsiderSocket.socket.readyState}`,
  );

  section("realtime messaging over WebSockets");
  const aliceRoom = await openSocket(`/ws?conversationId=${encodeURIComponent(conversationId)}&token=${alice.data.token}`);
  const bobRoom = await openSocket(`/ws?conversationId=${encodeURIComponent(conversationId)}&token=${bob.data.token}`);
  await aliceRoom.waitFor((event) => event.type === "ready");
  ok("room socket handshake sends ready", true);

  const aliceSession = await openSocket(`/ws/session?token=${alice.data.token}`);
  const bobSession = await openSocket(`/ws/session?token=${bob.data.token}`);
  await bobSession.waitFor((event) => event.type === "ready");

  aliceRoom.send({ type: "message.send", content: "Hello Bob \u2014 first message!", clientMessageId: "local-1" });
  const bobGot = await bobRoom.waitFor((event) => event.type === "message.new");
  ok("recipient receives the message", bobGot.message.content === "Hello Bob \u2014 first message!", JSON.stringify(bobGot));

  const aliceGot = await aliceRoom.waitFor(
    (event) => event.type === "message.new" && event.clientMessageId === "local-1",
  );
  ok("sender gets the same message with its optimistic id", aliceGot.clientMessageId === "local-1");

  const hubNotification = await bobSession.waitFor(
    (event) => event.type === "message.new" && event.message.content.startsWith("Hello Bob"),
  );
  ok("message also reaches the session hub", Boolean(hubNotification));

  section("typing + presence");
  bobRoom.send({ type: "typing.start" });
  const typing = await aliceRoom.waitFor((event) => event.type === "typing.update" && event.typing === true);
  ok("typing indicator relayed", typing.userId === bobId);
  bobRoom.send({ type: "typing.stop" });

  const presenceList = await api("/api/presence", { token: alice.data.token });
  ok("alice shows as online", presenceList.data?.userIds?.includes(aliceId), JSON.stringify(presenceList.data));
  ok("bob shows as online", presenceList.data?.userIds?.includes(bobId));
  ok("carol is not online yet", !presenceList.data?.userIds?.includes(carol.data.user.id));

  section("history, unread counts and read receipts");
  bobRoom.send({ type: "message.send", content: "Hey Alice, got it!" });
  await aliceRoom.waitFor((event) => event.type === "message.new" && event.message.senderId === bobId);
  bobRoom.send({ type: "message.send", content: "Second one for the unread badge." });
  await aliceRoom.waitFor((event) => event.type === "message.new" && event.message.content.startsWith("Second one"));

  const history = await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { token: alice.data.token });
  ok("history has 3 messages", history.data?.messages?.length === 3, String(history.data?.messages?.length));
  ok("history carries sender profiles", Array.isArray(history.data?.users) && history.data.users.length === 2);
  ok("history is oldest-first", history.data?.messages?.[0]?.content?.startsWith("Hello Bob"));

  const summary = await api(`/api/conversations/${encodeURIComponent(conversationId)}`, { token: alice.data.token });
  ok("unread count reflects bob's messages", summary.data?.conversation?.unread === 2, String(summary.data?.conversation?.unread));

  // Read receipts are a watermark: marking the newest message read also
  // acknowledges everything before it.
  const newest = history.data.messages.at(-1);
  aliceRoom.send({ type: "message.read", messageIds: [newest.id] });
  const receipt = await bobRoom.waitFor((event) => event.type === "message.read" && event.userId === aliceId);
  ok("read receipt reaches other members", receipt.messageIds.includes(newest.id));
  const afterRead = await api(`/api/conversations/${encodeURIComponent(conversationId)}`, { token: alice.data.token });
  ok("unread drops to 0 after a receipt", afterRead.data?.conversation?.unread === 0, String(afterRead.data?.conversation?.unread));

  bobRoom.send({ type: "message.send", content: "One more after the receipt." });
  await aliceRoom.waitFor((event) => event.type === "message.new" && event.message.content.startsWith("One more"));
  const afterNew = await api(`/api/conversations/${encodeURIComponent(conversationId)}`, { token: alice.data.token });
  ok("new messages are unread again", afterNew.data?.conversation?.unread === 1, String(afterNew.data?.conversation?.unread));

  section("edit + delete");
  aliceRoom.send({ type: "message.edit", messageId: newest.id, content: "Trying to edit someone else's message" });
  const editError = await aliceRoom.waitFor((event) => event.type === "error" && event.code === "FORBIDDEN");
  ok("cannot edit another member's message", Boolean(editError.message));

  const own = history.data.messages[0];
  aliceRoom.send({ type: "message.edit", messageId: own.id, content: "Hello Bob \u2014 edited!" });
  const edited = await bobRoom.waitFor((event) => event.type === "message.updated" && event.message.id === own.id);
  ok("own message can be edited", edited.message.content === "Hello Bob \u2014 edited!" && Boolean(edited.message.editedAt));

  aliceRoom.send({ type: "message.delete", messageId: own.id });
  const deleted = await bobRoom.waitFor((event) => event.type === "message.deleted" && event.messageId === own.id);
  ok("own message can be deleted", deleted.senderId === aliceId);

  section("groups");
  const group = await api("/api/conversations/group", {
    method: "POST",
    token: alice.data.token,
    body: { title: "Launch crew", participantIds: [bobId] },
  });
  ok("group created", group.status === 201 && group.data?.conversation?.type === "group", JSON.stringify(group.data));
  ok("group has both members", group.data?.conversation?.participantIds?.length === 2);
  ok("group keeps its title", group.data?.conversation?.title === "Launch crew");

  const groupId = group.data.conversation.id;
  const carolPeek = await api(`/api/conversations/${encodeURIComponent(groupId)}/messages`, { token: carol.data.token });
  ok("non-member cannot read the group", carolPeek.status === 403);

  const carolList = await api("/api/conversations", { token: carol.data.token });
  ok("outsider sees no conversations", carolList.data?.conversations?.length === 0, JSON.stringify(carolList.data));

  const bobGroupNotification = await bobSession.waitFor(
    (event) => event.type === "conversation.created" && event.conversation.id === groupId,
  );
  ok("members are told about the new group", bobGroupNotification.conversation.title === "Launch crew");

  section("persistence after a cold Durable Object");
  await wait(500);
  const reloaded = await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { token: bob.data.token });
  ok("history survives", reloaded.data?.messages?.length === 4, String(reloaded.data?.messages?.length));
  ok("deleted message stays deleted", reloaded.data?.messages?.some((message) => message.id === own.id && Boolean(message.deletedAt)));

  section("media config");
  const media = await api("/api/media/config", { token: alice.data.token });
  ok("media config served after auth", media.status === 200 && Array.isArray(media.data?.iceServers) && media.data.iceServers.length > 0);
  ok("PeerJS cloud is the dev default", media.data?.peer?.host === null);
  ok("media config needs a token", (await api("/api/media/config")).status === 401);

  section("validation + rate limits");
  const longMessage = "x".repeat(5000);
  aliceRoom.send({ type: "message.send", content: longMessage });
  const trimmed = await aliceRoom.waitFor(
    (event) =>
      event.type === "message.new" &&
      event.message.senderId === aliceId &&
      event.message.content.length > 1000 &&
      event.message.content.length <= 4000,
  );
  ok("over-long messages are clamped", trimmed.message.content.length === 4000, String(trimmed.message.content.length));

  aliceRoom.send({ type: "message.send", content: "   " });
  const emptyError = await aliceRoom.waitFor((event) => event.type === "error" && event.code === "VALIDATION_FAILED");
  ok("blank messages rejected", Boolean(emptyError.message));

  let limited = false;
  for (let i = 0; i < 70; i += 1) aliceRoom.send({ type: "message.send", content: `spam ${i}` });
  limited = await aliceRoom
    .waitFor((event) => event.type === "error" && event.code === "RATE_LIMITED", 5000)
    .then(() => true)
    .catch(() => false);
  ok("message rate limit kicks in", limited);

  section("history pagination");
  const pager = (await api("/api/session", { method: "POST", body: { displayName: "Pager Person" } })).data;
  const partner = (await api("/api/session", { method: "POST", body: { displayName: "Pager Partner" } })).data;
  const pagerDm = await api("/api/conversations/dm", {
    method: "POST",
    token: pager.token,
    body: { userId: partner.user.id },
  });
  const pagerRoom = await openSocket(
    `/ws?conversationId=${encodeURIComponent(pagerDm.data.conversation.id)}&token=${pager.token}`,
  );
  await pagerRoom.waitFor((event) => event.type === "ready");
  for (let i = 1; i <= 25; i += 1) {
    pagerRoom.send({ type: "message.send", content: `paged message ${i}` });
  }
  await pagerRoom.waitFor(
    (event) => event.type === "message.new" && event.message.content === "paged message 25",
  );

  const firstPage = await api(
    `/api/conversations/${encodeURIComponent(pagerDm.data.conversation.id)}/messages?limit=10`,
    { token: pager.token },
  );
  ok("first page respects the limit", firstPage.data.messages.length === 10, String(firstPage.data.messages.length));
  ok("first page is the newest slice", firstPage.data.messages.at(-1).content === "paged message 25");
  ok("first page reports more history", firstPage.data.hasMore === true);
  ok("first page returns a cursor", Number.isFinite(firstPage.data.cursor));

  const secondPage = await api(
    `/api/conversations/${encodeURIComponent(pagerDm.data.conversation.id)}/messages?limit=10&before=${firstPage.data.cursor}`,
    { token: pager.token },
  );
  ok("cursor walks backwards", secondPage.data.messages.at(-1).content === "paged message 15", secondPage.data.messages.at(-1)?.content);

  const all = await api(
    `/api/conversations/${encodeURIComponent(pagerDm.data.conversation.id)}/messages?limit=100`,
    { token: pager.token },
  );
  ok("full history is 25 messages", all.data.messages.length === 25, String(all.data.messages.length));
  pagerRoom.close();

  section("cleanup");
  aliceRoom.close();
  bobRoom.close();
  aliceSession.close();
  bobSession.close();
  await wait(800);
  const presenceAfter = await api("/api/presence", { token: carol.data.token });
  ok("users go offline when sockets close", !(presenceAfter.data?.userIds ?? []).includes(aliceId), JSON.stringify(presenceAfter.data));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nsmoke test crashed:", error);
  process.exit(1);
});