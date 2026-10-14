/**
 * lcc-chat browser end-to-end test.
 *
 * Three isolated browser contexts join with nothing but a display name, then
 * exchange messages in a DM and a group and run a real WebRTC call with fake
 * devices.
 *
 *   1. terminal A:  pnpm --dir ../server dev          (Worker on :8787)
 *   2. terminal B:  python3 -m http.server 5173 --directory ../client
 *   3. terminal A:  pnpm test:browser
 */
const { chromium } = require("playwright-core");

const CLIENT = process.env.CLIENT_URL ?? "http://127.0.0.1:5173/?worker=http://127.0.0.1:8787";
const SUFFIX = Math.random().toString(36).slice(2, 6);

let passed = 0;
let failed = 0;
const ok = (name, condition, extra = "") => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
};
const section = (title) => console.log(`\n${title}`);
const sleep = (page, ms) => page.waitForTimeout(ms);

/** Sign in with nothing but a display name. */
async function signIn(page, name) {
  await page.goto(CLIENT, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".onboarding", { timeout: 15_000 });
  await page.fill("#display-name", name);
  await page.click(".onboarding button[type=submit]");
  await page.waitForSelector('.app[data-state="ready"]', { timeout: 15_000 });
}

const sidebarTitles = (page) => page.locator(".conversation__title").allTextContents();

/** Open a conversation from the sidebar and wait for the pane + history. */
async function openConversation(page, title) {
  await page.locator(".conversation", { hasText: title }).first().click();
  await page.waitForSelector("#chat-panel:not([hidden])", { timeout: 15_000 });
}

/** Wait until the sidebar shows a conversation whose title contains `title`. */
async function waitForConversation(page, title, timeout = 20_000) {
  await page.waitForFunction(
    (needle) => [...document.querySelectorAll(".conversation__title")].some((node) => node.textContent.includes(needle)),
    title,
    { timeout },
  );
}

/**
 * Use the "new chat" picker to open a DM (one person) or a group (two+).
 * Every wait is explicit so a silently-missed click cannot pass as success.
 */
async function newChatWith(page, names) {
  await page.click("#new-chat");
  await page.waitForSelector(".modal-backdrop--visible .people-list", { timeout: 10_000 });

  for (const name of names) {
    const row = page.locator(".modal-backdrop--visible .person", { hasText: name }).first();
    await row.waitFor({ timeout: 15_000 });
    await row.click();
    await page.waitForFunction(
      (needle) => [...document.querySelectorAll(".chip")].some((chip) => chip.textContent.includes(needle)),
      name,
      { timeout: 10_000 },
    );
  }

  const button = page.locator(".modal-backdrop--visible .modal__actions .button--primary").last();
  const label = (await button.textContent()) ?? "";
  if (names.length > 1 && !label.startsWith("Start group")) {
    throw new Error(`picker selected the wrong people (button says "${label}")`);
  }
  if (names.length === 1 && label !== "Start chat") {
    throw new Error(`picker did not select one person (button says "${label}")`);
  }

  const before = (await sidebarTitles(page)).length;
  await button.click();

  if (names.length > 1) {
    // A group is announced through the hub: wait for a title with every member.
    await page.waitForFunction(
      ({ count, members }) => {
        const titles = [...document.querySelectorAll(".conversation__title")].map((node) => node.textContent);
        return titles.length > count && members.every((member) => titles.some((title) => title.includes(member)));
      },
      { count: before, members: names },
      { timeout: 20_000 },
    );
  } else {
    await page.waitForFunction((count) => document.querySelectorAll(".conversation__title").length > count, before, {
      timeout: 20_000,
    });
  }
}

/** Send a message and wait for it to appear on the other side. */
async function send(page, text) {
  await page.fill("#composer-input", text);
  await page.press("#composer-input", "Enter");
}

const hasText = (page, text) =>
  page.waitForFunction((needle) => document.querySelector("#message-list")?.textContent?.includes(needle), text, {
    timeout: 15_000,
  });

/** Record call signalling on a page so failures can be explained. */
async function traceCalls(page, label) {
  await page.evaluate((name) => {
    const app = window.lccChat;
    window.__callLog = [];
    const media = app.media;
    const handle = media.handleSignal.bind(media);
    media.handleSignal = async (from, payload) => {
      const before = media.mesh.get(from);
      window.__callLog.push(`${name} <- ${payload.kind} ${from.slice(-4)} pc=${before ? before.signalingState : "none"}`);
      const result = await handle(from, payload);
      const after = media.mesh.get(from);
      window.__callLog.push(`${name}    ${payload.kind} pc=${after ? after.signalingState : "gone"}`);
      return result;
    };
    const send = app.sendCallSignal.bind(app);
    app.sendCallSignal = (to, payload) => {
      window.__callLog.push(`${name} -> ${payload.kind} ${to.slice(-4)}`);
      return send(to, payload);
    };
  }, label);
}

const callLog = (page) => page.evaluate(() => window.__callLog ?? []);

async function main() {
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--no-sandbox"],
  });
  const makeContext = () => browser.newContext({ permissions: ["microphone", "camera"] });
  const alice = await makeContext().then((c) => c.newPage());
  const bob = await makeContext().then((c) => c.newPage());
  const carol = await makeContext().then((c) => c.newPage());

  const errors = [];
  for (const [label, page] of [["alice", alice], ["bob", bob], ["carol", carol]]) {
    page.on("pageerror", (error) => errors.push(`[${label}] ${error.message}`));
    page.on("console", (message) => {
      const text = message.text();
      // Ignore noise we cannot control: missing favicon, PeerJS internals,
      // and the blocked CORS probe of a Worker URL that is not reachable
      // (lcc-chat falls back to the local Worker in that case).
      const expected =
        /favicon|PeerJS|ERR_|Failed to load resource|Access to fetch at .*\/health.*CORS/i.test(text);
      if (message.type() === "error" && !expected) errors.push(`[${label}] ${text}`);
    });
  }

  const nameA = `Alice ${SUFFIX}`;
  const nameB = `Bob ${SUFFIX}`;
  const nameC = `Cara ${SUFFIX}`;

  section("no sign-up: a display name is the whole registration");
  await signIn(alice, nameA);
  ok("app shell renders", await alice.isVisible("#conversation-list"));
  ok("identity shows in the sidebar", (await alice.textContent("#me-name")).includes(nameA));
  await signIn(bob, nameB);
  await signIn(carol, nameC);
  ok(
    "every visitor lands straight in the app",
    (await bob.isVisible("#new-chat")) && (await carol.isVisible("#new-chat")),
  );

  section("presence");
  await alice.waitForFunction(() => window.lccChat?.hubSocket?.state === "connected", null, { timeout: 20_000 });
  ok("hub socket connected", (await alice.textContent("#connection-status")).includes("online"));

  section("direct messages");
  await newChatWith(alice, [nameB]);
  await waitForConversation(bob, nameA);
  ok("the other side sees the new conversation", true);
  await openConversation(bob, nameA);
  await openConversation(alice, nameB);

  await send(alice, "Hi Bob, this is lcc-chat");
  await hasText(bob, "Hi Bob");
  ok("message arrives live", true);
  ok("it renders as an incoming message", (await bob.locator(".message:not(.message--mine)").count()) > 0);
  await alice.locator(".message__receipt--read").first().waitFor({ timeout: 20_000 });
  ok("sender sees the read receipt", true);

  await send(bob, "Got it, loud and clear!");
  await hasText(alice, "Got it");
  ok("reply arrives", true);

  section("typing indicator");
  await bob.click("#composer-input");
  await bob.type("#composer-input", "composing…", { delay: 25 });
  await alice.waitForFunction(() => (document.querySelector("#typing")?.textContent ?? "").includes("typing"), null, { timeout: 10_000 });
  ok("typing is relayed", true);
  await bob.fill("#composer-input", "");
  await alice.waitForFunction(() => (document.querySelector("#typing")?.textContent ?? "").trim() === "", null, { timeout: 12_000 });
  ok("typing indicator clears on idle", true);

  section("history and session survive a reload");
  await alice.reload({ waitUntil: "domcontentloaded" });
  await alice.waitForSelector('.app[data-state="ready"]', { timeout: 20_000 });
  ok("no re-registration after reload", (await alice.textContent("#me-name")).includes(nameA));
  await openConversation(alice, nameB);
  await hasText(alice, "Got it");
  ok("history is restored from the Durable Object", true);

  section("edit and delete");
  const own = alice.locator(".message--mine").last();
  await own.locator(".message__actions button").first().click();
  await alice.fill(".message__editor", "Edited: got it, loud and crystal clear!");
  await alice.press(".message__editor", "Enter");
  await hasText(bob, "crystal clear");
  ok("edit propagates", true);
  ok("edit is marked as edited", (await alice.textContent("#message-list")).includes("edited"));

  await own.locator(".message__actions button").nth(1).click();
  await alice.waitForSelector(".modal-backdrop--visible", { timeout: 10_000 });
  await alice.click(".modal-backdrop--visible .button--danger");
  await hasText(bob, "This message was deleted");
  ok("delete propagates", true);

  section("group chat");
  await newChatWith(alice, [nameB, nameC]);
  const titles = await sidebarTitles(alice);
  const groupTitle = titles.find((title) => title.includes(nameB) && title.includes(nameC));
  ok("group is created and listed", Boolean(groupTitle), JSON.stringify(titles));
  ok("group title lists the members", Boolean(groupTitle), String(groupTitle));

  await openConversation(alice, groupTitle);
  for (const page of [bob, carol]) {
    await waitForConversation(page, groupTitle);
    await openConversation(page, groupTitle);
  }

  await send(alice, "Group message hello");
  await hasText(bob, "Group message hello");
  await hasText(carol, "Group message hello");
  ok("group messages reach every member", true);

  section("group call (WebRTC mesh over the Worker relay)");
  await alice.click("#start-video");
  await alice.waitForSelector(".call", { timeout: 15_000 });
  ok("caller sees the call overlay", true);

  // Only Bob joins: Cara stays out, so the hang-up must close both overlays.
  const join = bob.locator(".toast", { hasText: /started a/i }).locator(".toast__action").last();
  await join.waitFor({ timeout: 30_000 }).catch(() => undefined);
  ok("callee is invited to join", await join.isVisible().catch(() => false));
  if (await join.isVisible().catch(() => false)) await join.click();
  await bob.waitForSelector(".call", { timeout: 20_000 }).catch(() => undefined);
  ok("callee call overlay opens", await bob.isVisible(".call"));

  await alice.locator(".call__tile[data-remote]").first().waitFor({ timeout: 40_000 }).catch(() => undefined);
  await sleep(alice, 6000);
  const tiles = await alice.locator(".call__tile[data-remote]").count();
  ok("caller receives remote media tiles", tiles >= 1, `tiles=${tiles}`);
  const video = await alice.evaluate(() =>
    [...document.querySelectorAll(".call__tile[data-remote] video")].map((v) => ({ w: v.videoWidth, playing: !v.paused })),
  );
  ok("remote video is actually playing", video.some((v) => v.w > 0 && v.playing), JSON.stringify(video));

  section("screen sharing");
  await alice.click("#call-screen");
  await sleep(alice, 3000);
  ok("screen share track acquired", await alice.evaluate(() => Boolean(window.lccChat.media.screenTrack)));
  await alice.click("#call-screen");
  await sleep(alice, 2000);
  ok("screen share stops cleanly", await alice.evaluate(() => window.lccChat.media.screenTrack === null));

  section("hang up");
  await alice.click("#call-hangup");
  await sleep(alice, 1500);
  ok("caller overlay closes", (await alice.locator(".call").count()) === 0);
  await sleep(bob, 4000);
  ok("callee overlay closes too", (await bob.locator(".call").count()) === 0);

  section("offline: messages queue instead of failing");
  const contextA = alice.context();
  // Kill the room socket the way a dropped tunnel / sleeping laptop would.
  await alice.evaluate(() => window.lccChat.roomSocket.socket.close(4000, "test drop"));
  await alice.waitForFunction(() => window.lccChat.roomSocket?.isOpen === false, null, { timeout: 15_000 });
  await contextA.setOffline(true);

  await send(alice, "queued message one");
  await send(alice, "queued message two");
  await alice.waitForFunction(
    () => document.querySelector("#chat-banner") && !document.querySelector("#chat-banner").hidden,
    null,
    { timeout: 15_000 },
  );
  ok("a reconnect banner is shown", (await alice.textContent("#chat-banner")).includes("Reconnecting"));
  ok("no message is marked as failed", (await alice.locator(".message--failed").count()) === 0);
  ok("queued messages are marked queued", (await alice.locator(".message__edited").allTextContents()).includes("queued"));
  ok("no 'not sent' toast spam", (await alice.locator(".toast", { hasText: /not sent/i }).count()) === 0);

  await contextA.setOffline(false);
  await alice.evaluate(() => window.lccChat.roomSocket.retryNow());
  await bob.waitForFunction(
    () => document.querySelector("#message-list")?.textContent?.includes("queued message two"),
    null,
    { timeout: 60_000 },
  );
  ok("queued messages flush automatically after reconnect", true);
  await alice.waitForFunction(
    () => document.querySelectorAll(".message--failed").length === 0 && document.querySelector("#chat-banner").hidden,
    null,
    { timeout: 30_000 },
  );
  ok("the banner clears once back online", true);

  section("calls still work when PeerJS signalling is blocked");
  const carolContext = carol.context();
  await carolContext.route("**/peerjs*", (route) => route.abort());
  await carol.reload({ waitUntil: "domcontentloaded" });
  await carol.waitForSelector('.app[data-state="ready"]', { timeout: 20_000 });
  await waitForConversation(carol, groupTitle);
  await openConversation(carol, groupTitle);
  await carol.evaluate(() => {
    window.lccChat.media.signalling = null; // force a fresh attempt
  });

  await carol.click("#start-video");
  await carol.waitForSelector(".call", { timeout: 15_000 });
  await traceCalls(carol, "carol");
  await traceCalls(bob, "bob");
  await traceCalls(alice, "alice");
  await carol.evaluate(() => {
    window.lccChat.media.signalling = null; // force a fresh attempt
  });
  const relayInvite = bob.locator(".toast", { hasText: /started a/i }).locator(".toast__action").last();
  await relayInvite.waitFor({ timeout: 30_000 }).catch(() => undefined);
  ok("invite still arrives without PeerJS", await relayInvite.isVisible().catch(() => false));
  if (await relayInvite.isVisible().catch(() => false)) await relayInvite.click();
  await bob.waitForSelector(".call", { timeout: 20_000 }).catch(() => undefined);
  await bob.locator(".call__tile[data-remote]").first().waitFor({ timeout: 40_000 }).catch(() => undefined);
  const relayState = await bob.evaluate(() => {
    const [id, connection] = [...(window.lccChat.media.mesh ?? new Map())][0] ?? [];
    return {
      state: window.lccChat.media.state,
      usesRelay: window.lccChat.media.usesRelay,
      mesh: window.lccChat.media.mesh.size,
      peer: connection ? `${id}:${connection.connectionState}/${connection.iceConnectionState}` : "none",
    };
  });
  const carolState = await carol.evaluate(() => {
    const [id, connection] = [...(window.lccChat.media.mesh ?? new Map())][0] ?? [];
    return {
      state: window.lccChat.media.state,
      usesRelay: window.lccChat.media.usesRelay,
      mesh: window.lccChat.media.mesh.size,
      peer: connection ? `${id}:${connection.connectionState}/${connection.iceConnectionState}` : "none",
    };
  });
  ok(
    "media flows over lcc-chat's own relay",
    (await bob.locator(".call__tile[data-remote]").count()) > 0,
    `bob=${JSON.stringify(relayState)} carol=${JSON.stringify(carolState)}\n      bob log: ${(await callLog(bob)).join(" | ")}\n      carol log: ${(await callLog(carol)).join(" | ")}\n      alice log: ${(await callLog(alice)).join(" | ")}`,
  );
  await bob.click("#call-hangup");
  await sleep(bob, 1500);

  section("console health");
  ok("no unexpected console errors", errors.length === 0, errors.slice(0, 4).join(" | "));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("browser test crashed:", error);
  process.exit(1);
});