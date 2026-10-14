/**
 * Shared types for the lcc-chat Worker.
 *
 * Everything that crosses the HTTP/WebSocket boundary is described here so
 * `/client` and `/server` can never drift apart silently.
 */

/* ------------------------------------------------------------------ env */

/** Environment bindings. See `wrangler.toml`. */
export interface Env {
  /** One Durable Object instance per conversation. */
  CHAT_ROOM: DurableObjectNamespace;
  /** One Durable Object instance per signed-in user (notification hub). */
  USER_SESSION: DurableObjectNamespace;
  /** Single global instance tracking who is online. */
  PRESENCE: DurableObjectNamespace;
  /** KV: profiles, conversation lists, cached media config. */
  PROFILES: KVNamespace;

  /** HMAC secret used to sign session tokens. Set with `wrangler secret put`. */
  TOKEN_SECRET?: string;
  /** Comma separated STUN URLs handed to the browser. */
  STUN_URLS?: string;
  /** Self-hosted PeerServer config (optional; empty = PeerJS Cloud for dev). */
  PEER_HOST?: string;
  PEER_PORT?: string;
  PEER_PATH?: string;
  PEER_SECURE?: string;

  MAX_MESSAGE_LENGTH?: string;
  MESSAGES_PER_MINUTE?: string;
}

/* -------------------------------------------------------------- domain */

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  color: string;
  createdAt: string;
}

export type ConversationType = "dm" | "group";

export interface Conversation {
  id: string;
  type: ConversationType;
  title: string;
  participantIds: string[];
  createdAt: string;
  lastMessageAt?: string;
  /** Server-side unread count for the requesting user. */
  unread?: number;
  lastMessage?: Message | null;
  /** Base64 thumbnail (data URL) or `undefined`. */
  avatarUrl?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
}

/* ------------------------------------------------------- websocket wire */

/** Client -> Worker (Durable Object) events. */
export type ClientEvent =
  | { type: "message.send"; conversationId: string; content: string; clientMessageId?: string }
  | { type: "message.edit"; conversationId: string; messageId: string; content: string }
  | { type: "message.delete"; conversationId: string; messageId: string }
  | { type: "typing.start"; conversationId: string }
  | { type: "typing.stop"; conversationId: string }
  | { type: "message.read"; conversationId: string; messageIds: string[] }
  | { type: "call.signal"; conversationId: string; to: string; payload: CallSignal }
  | { type: "ping" };

/** Worker -> Client events. */
export type ServerEvent =
  | { type: "message.new"; message: Message; clientMessageId?: string }
  | { type: "message.updated"; message: Message }
  | { type: "message.deleted"; conversationId: string; messageId: string; senderId: string }
  | { type: "presence.update"; userId: string; online: boolean }
  | { type: "typing.update"; conversationId: string; userId: string; typing: boolean }
  | { type: "message.read"; conversationId: string; userId: string; messageIds: string[]; readAt: string }
  | { type: "conversation.created"; conversation: Conversation }
  | { type: "call.signal"; from: string; payload: CallSignal }
  | { type: "call.participants"; conversationId: string; participants: string[] }
  | { type: "ready"; conversationId?: string; userId: string; serverTime: string }
  | { type: "pong"; serverTime: string }
  | { type: "error"; code: string; message: string };

/** WebRTC signalling payload relayed between two participants. */
export interface CallSignal {
  kind: "offer" | "answer" | "ice" | "bye" | "state";
  sdp?: string;
  candidate?: IceCandidateInit;
  media?: "audio" | "video" | "screen" | null;
  state?: "connecting" | "connected" | "reconnecting" | "failed" | "closed";
}

/** Minimal ICE candidate shape (workers-types does not ship the DOM lib). */
export interface IceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** Envelope actually written to a WebSocket. */
export type WireMessage = ServerEvent & { seq?: number };

/* ----------------------------------------------------------- http shapes */

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface SessionResponse {
  token: string;
  user: User;
}

export interface MediaConfig {
  /** PeerJS signalling endpoint configuration (null = PeerJS Cloud). */
  peer: {
    host: string | null;
    port: number | null;
    path: string;
    secure: boolean;
    debug: 1 | 0 | 2 | 3;
  };
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  /** Server clock, used to correct client drift. */
  serverTime: string;
}