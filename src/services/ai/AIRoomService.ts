/**
 * AIRoomService.ts
 *
 * Orchestrates Phase 2 (Multi-AI Group Rooms) and Phase 3 (Cross-Channel Virtual Bridged Rooms):
 * - Inbound channel listener via EventBroadcaster.onBeforeSend('event:message' & 'fb:onMessage')
 * - Anti-loop / Echo Guard (outbound msgId cache + pre-send fingerprint cache + origin_msg_id DB check)
 * - Outbound multi-channel relay paced through AccountSendQueue (Zalo, Facebook, Telegram User, Telegram Bot)
 * - Multi-AI orchestration in 3 modes: @mention, round_table, and moderator (with delegation)
 */

import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import AIAssistantService from './AIAssistantService';
import ConnectionManager from '../../utils/connection/ConnectionManager';
import AccountSendQueue from '../workflow/AccountSendQueue';
import { FacebookSendService } from '../facebook/send/FacebookSendService';
import * as TelegramUser from '../telegram/TelegramUserListener';
import * as TelegramBot from '../telegram/bot/TelegramBotChannelService';
import Logger from '../../utils/Logger';
import type {
  AIRoom,
  AIRoomBridge,
  AIRoomMember,
  AIRoomMessage,
  AIRoomMessageMeta,
  AIRoomRelayDelivery,
} from '../../models/ai/aiRoom';

const OUTBOUND_ID_TTL_MS = 10 * 60_000;
const OUTBOUND_FP_TTL_MS = 45_000;

interface NormalizedInboundEvent {
  channel: 'zalo' | 'facebook' | 'telegram_user' | 'telegram_bot';
  accountId: string;
  threadId: string;
  threadType: number;
  senderId: string;
  senderName: string;
  content: string;
  msgId: string;
  isSelf: boolean;
}

function normalizeFpText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
}

function bridgeKeyOf(b: { accountId: string; threadId: string }): string {
  return `${b.accountId}::${b.threadId}`;
}

function channelBadgeLabel(ch?: string | null): string {
  if (ch === 'facebook') return 'FB';
  if (ch === 'telegram_user') return 'Telegram';
  if (ch === 'telegram_bot') return 'TG Bot';
  return 'Zalo';
}

function formatBridgeOutboundText(prefixSender: string | undefined, content: string): string {
  const clean = String(content || '').trim();
  if (!prefixSender) return clean;
  return `[${prefixSender}]: ${clean}`;
}

class AIRoomService {
  private static instance: AIRoomService;

  public static getInstance(): AIRoomService {
    if (!AIRoomService.instance) {
      AIRoomService.instance = new AIRoomService();
    }
    return AIRoomService.instance;
  }

  private unsubscribers: Array<() => void> = [];
  private outboundMsgIds = new Map<string, number>();
  private outboundFingerprints = new Map<string, number>();
  private initialized = false;

  private constructor() {}

  public initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.rehookEvents();
    Logger.info('[AIRoomService] Initialized multi-AI & cross-channel room service');
  }

  public rehookEvents(): void {
    for (const unsub of this.unsubscribers) {
      try { unsub(); } catch {}
    }
    this.unsubscribers = [];

    this.unsubscribers.push(
      EventBroadcaster.onBeforeSend('event:message', (data: any) => {
        const parsed = this.extractUnifiedEventMessage(data);
        if (parsed) {
          void this.handleInboundExternalMessage(parsed).catch(err =>
            Logger.warn(`[AIRoomService] inbound event:message error: ${err?.message || err}`),
          );
        }
      }),
    );

    this.unsubscribers.push(
      EventBroadcaster.onBeforeSend('fb:onMessage', (data: any) => {
        const parsed = this.extractFacebookMessage(data);
        if (parsed) {
          void this.handleInboundExternalMessage(parsed).catch(err =>
            Logger.warn(`[AIRoomService] inbound fb:onMessage error: ${err?.message || err}`),
          );
        }
      }),
    );
  }

  // ─── Room CRUD Wrappers ───────────────────────────────────────────────────

  public listRooms(): AIRoom[] {
    return DatabaseService.getInstance().listAIRooms();
  }

  public getRoom(roomId: string): AIRoom | null {
    return DatabaseService.getInstance().getAIRoom(roomId);
  }

  public saveRoom(input: Partial<AIRoom> & { name: string }): AIRoom {
    const saved = DatabaseService.getInstance().saveAIRoom(input);
    EventBroadcaster.emit('ai:roomUpdated', { roomId: saved.id, room: saved });
    return saved;
  }

  public deleteRoom(roomId: string): void {
    DatabaseService.getInstance().deleteAIRoom(roomId);
    EventBroadcaster.emit('ai:roomUpdated', { roomId, deleted: true });
  }

  public getMessages(roomId: string, limit = 200): AIRoomMessage[] {
    return DatabaseService.getInstance().getAIRoomMessages(roomId, limit);
  }

  // ─── Echo / Loop Guard ────────────────────────────────────────────────────

  private pruneGuardMaps(now: number): void {
    if (this.outboundMsgIds.size > 500) {
      for (const [k, exp] of this.outboundMsgIds) {
        if (exp <= now) this.outboundMsgIds.delete(k);
      }
    }
    if (this.outboundFingerprints.size > 500) {
      for (const [k, exp] of this.outboundFingerprints) {
        if (exp <= now) this.outboundFingerprints.delete(k);
      }
    }
  }

  private rememberOutboundFingerprint(accountId: string, threadId: string, text: string): string {
    const now = Date.now();
    this.pruneGuardMaps(now);
    const key = `${accountId}|${threadId}|${normalizeFpText(text)}`;
    this.outboundFingerprints.set(key, now + OUTBOUND_FP_TTL_MS);
    return key;
  }

  private rememberOutboundMsgId(accountId: string, msgId?: string): void {
    if (!msgId) return;
    const now = Date.now();
    this.pruneGuardMaps(now);
    this.outboundMsgIds.set(`${accountId}:${String(msgId)}`, now + OUTBOUND_ID_TTL_MS);
  }

  private isOutboundEcho(accountId: string, threadId: string, msgId: string, content: string): boolean {
    const now = Date.now();
    if (msgId) {
      const exp = this.outboundMsgIds.get(`${accountId}:${msgId}`);
      if (exp && exp > now) return true;
    }
    const fpKey = `${accountId}|${threadId}|${normalizeFpText(content)}`;
    const fpExp = this.outboundFingerprints.get(fpKey);
    if (fpExp && fpExp > now) return true;
    return false;
  }

  // ─── Inbound Extraction ───────────────────────────────────────────────────

  private extractTextFromRaw(rawContent: any, fallbackType?: string): string {
    if (rawContent === null || rawContent === undefined) return '';
    if (typeof rawContent === 'string') {
      const trimmed = rawContent.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const obj = JSON.parse(trimmed);
          // Skip undo control packets
          if (obj && typeof obj === 'object' && (obj.deleteMsg || obj.globalMsgId)) return '';
          return String(obj?.msg || obj?.text || obj?.title || obj?.caption || obj?.href || '');
        } catch {
          return trimmed;
        }
      }
      return trimmed;
    }
    if (typeof rawContent === 'object') {
      if ((rawContent as any).deleteMsg || (rawContent as any).globalMsgId) return '';
      return String((rawContent as any).msg || (rawContent as any).text || (rawContent as any).title || (rawContent as any).caption || '');
    }
    return String(rawContent || (fallbackType ? `[${fallbackType}]` : ''));
  }

  private resolveSenderDisplayName(db: DatabaseService, accountId: string, threadId: string, senderId: string, rawName?: string): string {
    const clean = String(rawName || '').trim();
    if (clean) return clean;
    if (!senderId) return 'Khách';
    try {
      const c = db.queryOne<any>(
        `SELECT COALESCE(NULLIF(alias, ''), NULLIF(display_name, ''), '') AS name FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
        [accountId, senderId],
      );
      if (c?.name) return String(c.name);
      if (threadId && threadId !== senderId) {
        const gm = db.queryOne<any>(
          `SELECT display_name FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
          [accountId, threadId, senderId],
        );
        if (gm?.display_name) return String(gm.display_name);
      }
    } catch {}
    return senderId;
  }

  private extractUnifiedEventMessage(data: any): NormalizedInboundEvent | null {
    if (!data) return null;
    const db = DatabaseService.getInstance();
    const envelope = data.message || data.data || data;
    const msgData = (envelope as any).data || data.data || {};
    const ch = String(data.channel || (envelope as any).channel || msgData.channel || '').trim();

    if (ch === 'telegram_bot') {
      const accountId = String(data.accountId || data.zaloId || '').trim();
      const threadId = String(data.chatId || (envelope as any).threadId || data.threadId || msgData.idTo || '').trim();
      const msgType = String(msgData.msgType || (envelope as any).msgType || 'text');
      const content = this.extractTextFromRaw(msgData.content ?? (envelope as any).content ?? data.content, msgType);
      if (!accountId || !threadId || !content.trim()) return null;
      const senderId = String(data.fromId || msgData.uidFrom || '').trim();
      const isSelf = !!(data.isSelf || (envelope as any).isSelf || msgData.isSelf);
      const rawName = String(data.fromName || msgData.dName || '').trim();
      return {
        channel: 'telegram_bot',
        accountId,
        threadId,
        threadType: (data.chatType === 'group' || data.chatType === 'supergroup') ? 1 : 0,
        senderId,
        senderName: isSelf ? 'Bot (Tôi)' : this.resolveSenderDisplayName(db, accountId, threadId, senderId, rawName),
        content,
        msgId: String(data.messageId || msgData.msgId || ''),
        isSelf,
      };
    }

    if (ch === 'telegram_user') {
      const accountId = String(data.zaloId || data.accountId || '').trim();
      const threadId = String(data.threadId || (envelope as any).threadId || msgData.threadId || msgData.chatId || '').trim();
      const msgType = String(msgData.msgType || (envelope as any).msgType || 'text');
      const rawBody = msgData.preview ?? msgData.content ?? msgData.text ?? data.content;
      const content = this.extractTextFromRaw(rawBody, msgType);
      if (!accountId || !threadId || !content.trim()) return null;
      const senderId = String(msgData.fromId || msgData.senderId || msgData.uidFrom || data.fromId || '').trim();
      const isSelf = !!(msgData.isSelf || (envelope as any).isSelf || data.isSelf);
      const rawName = String(msgData.fromName || msgData.senderName || msgData.dName || data.fromName || '').trim();
      return {
        channel: 'telegram_user',
        accountId,
        threadId,
        threadType: (msgData.isGroup || (envelope as any).type === 1 || data.isGroup) ? 1 : 0,
        senderId,
        senderName: isSelf ? 'Tôi' : this.resolveSenderDisplayName(db, accountId, threadId, senderId, rawName),
        content,
        msgId: String(msgData.msgId || msgData.messageId || data.msgId || ''),
        isSelf,
      };
    }

    // Default: Zalo
    const accountId = String(data.zaloId || '').trim();
    const threadId = String((envelope as any).threadId || data.threadId || msgData.idTo || '').trim();
    const msgType = String(msgData.msgType || (envelope as any).msgType || 'text');
    const content = this.extractTextFromRaw(msgData.content ?? (envelope as any).content ?? data.content, msgType);
    if (!accountId || !threadId || !content.trim()) return null;
    const isGroup = (envelope as any).type === 1 || !!(envelope as any).isGroup || !!data.isGroup || data.threadType === 1;
    const senderId = String(msgData.uidFrom || (envelope as any).uidFrom || data.fromId || '').trim();
    const isSelf = !!((envelope as any).isSelf || data.isSelf);
    const rawName = String(
      data.fromName || msgData.dName || msgData.senderInfo?.displayName || msgData.senderInfo?.zaloName || '',
    ).trim();

    return {
      channel: 'zalo',
      accountId,
      threadId,
      threadType: isGroup ? 1 : 0,
      senderId,
      senderName: isSelf ? 'Tôi' : this.resolveSenderDisplayName(db, accountId, threadId, senderId, rawName),
      content,
      msgId: String(msgData.msgId || (envelope as any).msgId || data.msgId || ''),
      isSelf,
    };
  }

  private extractFacebookMessage(data: any): NormalizedInboundEvent | null {
    if (!data?.message || data.message.repeat === true) return null;
    const db = DatabaseService.getInstance();
    const msg = data.message;
    const rawFbAcc = String(data.fbAccountId || '').trim();
    let accountId = rawFbAcc;
    if (rawFbAcc.includes('-')) {
      const fbAcc = db.getFBAccount(rawFbAcc);
      if (fbAcc?.facebook_id) accountId = String(fbAcc.facebook_id);
    }
    const threadId = String(data.threadId || msg.threadId || msg.replyToID || '').trim();
    if (!accountId || !threadId || threadId === '0') return null;

    let content = String(msg.body || '').trim();
    if (!content && msg.attachments?.attachmentType) {
      content = `[${msg.attachments.attachmentType}${msg.attachments.name ? `: ${msg.attachments.name}` : ''}]`;
    }
    if (!content) return null;

    const senderId = String(msg.userID || data.userId || data.fromId || '').trim();
    const isSelf = !!(msg.isSelf || data.isSelf);
    const rawName = String(data.contactName || data.fromName || msg.senderName || '').trim();

    return {
      channel: 'facebook',
      accountId,
      threadId,
      threadType: msg.type === 'group' ? 1 : 0,
      senderId,
      senderName: isSelf ? 'Tôi' : this.resolveSenderDisplayName(db, accountId, threadId, senderId, rawName),
      content,
      msgId: String(data.messageId || msg.messageID || msg.messageId || ''),
      isSelf,
    };
  }

  // ─── Inbound Processing ───────────────────────────────────────────────────

  private async handleInboundExternalMessage(ev: NormalizedInboundEvent): Promise<void> {
    const db = DatabaseService.getInstance();
    const matchingBridges = db.findActiveInboundBridges(ev.accountId, ev.threadId);
    if (!matchingBridges.length) return;

    if (this.isOutboundEcho(ev.accountId, ev.threadId, ev.msgId, ev.content)) {
      return;
    }

    const handledRooms = new Set<string>();
    for (const sourceBridge of matchingBridges) {
      if (handledRooms.has(sourceBridge.roomId)) continue;
      handledRooms.add(sourceBridge.roomId);

      if (ev.msgId && db.hasAIRoomOriginMessage(sourceBridge.roomId, ev.msgId)) {
        continue;
      }

      const room = db.getAIRoom(sourceBridge.roomId);
      if (!room || !room.enabled) continue;

      const meta: AIRoomMessageMeta = ev.isSelf ? { isSelfExternal: true } : {};
      const saved = db.addAIRoomMessage({
        roomId: room.id,
        senderType: 'external',
        senderId: ev.senderId,
        senderName: ev.senderName || 'Khách',
        sourceChannel: sourceBridge.channel || ev.channel,
        sourceAccountId: ev.accountId,
        sourceThreadId: ev.threadId,
        sourceThreadName: sourceBridge.threadName || ev.threadId,
        originMsgId: ev.msgId || null,
        content: ev.content,
        meta,
      });
      db.save();

      EventBroadcaster.emit('ai:roomMessage', { roomId: room.id, message: saved });
      EventBroadcaster.emit('ai:roomUpdated', { roomId: room.id });

      if (ev.isSelf) continue;

      // Auto-Relay inbound message to other outbound auto_relay bridges in this room
      const siblingBridges = room.bridges.filter(
        b => b.enabled &&
          b.outboundMode === 'auto_relay' &&
          b.relayDirection !== 'inbound_only' &&
          !(b.accountId === ev.accountId && b.threadId === ev.threadId),
      );
      if (siblingBridges.length > 0) {
        const prefix = `${channelBadgeLabel(sourceBridge.channel)} · ${ev.senderName}`;
        const deliveries = await this.deliverToBridges(
          siblingBridges,
          formatBridgeOutboundText(prefix, ev.content),
        );
        const nextMeta: AIRoomMessageMeta = { ...(saved.meta || {}), relayDeliveries: deliveries };
        db.updateAIRoomMessageMeta(saved.id, JSON.stringify(nextMeta));
        db.save();
        EventBroadcaster.emit('ai:roomMessage', {
          roomId: room.id,
          message: { ...saved, metadataJson: JSON.stringify(nextMeta), meta: nextMeta },
        });
      }

      // Check AI auto-trigger policy for inbound external messages
      if (room.members.length > 0 && this.shouldTriggerAIForExternal(room, ev.content)) {
        void this.orchestrateAIReply(room.id, { enableTools: true }).catch(err =>
          Logger.warn(`[AIRoomService] auto AI reply failed for room ${room.id}: ${err?.message || err}`),
        );
      }
    }
  }

  private shouldTriggerAIForExternal(room: AIRoom, text: string): boolean {
    if (room.aiTriggerMode === 'all_messages') return true;
    if (room.aiTriggerMode === 'manual' || room.aiTriggerMode === 'all_internal') return false;
    // mention_only
    return this.extractMentions(text, room.members).length > 0 || /@ai\b/i.test(text);
  }

  // ─── Outbound Channel Sending (Queued via AccountSendQueue) ───────────────

  private async sendOutboundText(bridge: AIRoomBridge, text: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const clean = String(text || '').trim();
    if (!clean) return { success: false, error: 'Nội dung rỗng' };

    const accountId = bridge.accountId;
    const threadId = bridge.threadId;
    const threadType = bridge.threadType === 1 ? 1 : 0;

    // Record fingerprint BEFORE network send so synchronous/MQTT echoes are filtered reliably
    this.rememberOutboundFingerprint(accountId, threadId, clean);

    const queue = AccountSendQueue.getInstance();
    return await queue.enqueue(`${bridge.channel}:${accountId}`, async () => {
      try {
        if (bridge.channel === 'zalo') {
          const conn = ConnectionManager.getConnection(accountId);
          if (!conn?.api) return { success: false, error: `Tài khoản Zalo ${accountId} chưa kết nối` };
          const res = await conn.api.sendMessage({ msg: clean, attachments: [] }, threadId, threadType);
          const msgId = String((res as any)?.message?.msgId || (res as any)?.msgId || (res as any)?.messageId || '');
          this.rememberOutboundMsgId(accountId, msgId);
          return { success: true, messageId: msgId };
        }

        if (bridge.channel === 'facebook') {
          const db = DatabaseService.getInstance();
          const fbUuid = accountId.includes('-')
            ? accountId
            : (db.getFBAccountByFacebookId(accountId)?.id || accountId);
          const res = await FacebookSendService.sendTextMessage({
            accountId: fbUuid,
            threadId,
            body: clean,
            typeChat: threadType === 0 ? 'user' : null,
          });
          if (!res?.success) return { success: false, error: res?.error || 'Gửi Facebook thất bại' };
          this.rememberOutboundMsgId(accountId, res.messageId);
          return { success: true, messageId: res.messageId };
        }

        if (bridge.channel === 'telegram_user') {
          const res = await TelegramUser.sendMessage(accountId, threadId, clean);
          if (!res?.success) return { success: false, error: res?.error || 'Gửi Telegram thất bại' };
          this.rememberOutboundMsgId(accountId, res.messageId);
          return { success: true, messageId: res.messageId };
        }

        if (bridge.channel === 'telegram_bot') {
          const res = await TelegramBot.sendMessage({ accountId, chatId: threadId, text: clean });
          if (!res?.success) return { success: false, error: res?.error || 'Gửi Telegram Bot thất bại' };
          this.rememberOutboundMsgId(accountId, res.messageId);
          return { success: true, messageId: res.messageId };
        }

        return { success: false, error: `Kênh không hỗ trợ: ${bridge.channel}` };
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    }, 550, 1300);
  }

  private async deliverToBridges(bridges: AIRoomBridge[], text: string): Promise<AIRoomRelayDelivery[]> {
    const deliveries: AIRoomRelayDelivery[] = [];
    for (const b of bridges) {
      const res = await this.sendOutboundText(b, text);
      deliveries.push({
        bridgeKey: bridgeKeyOf(b),
        accountId: b.accountId,
        channel: b.channel,
        threadId: b.threadId,
        threadName: b.threadName,
        status: res.success ? 'sent' : 'failed',
        error: res.error,
        sentAt: Date.now(),
      });
    }
    return deliveries;
  }

  // ─── Human Messaging & Broadcast ──────────────────────────────────────────

  public async sendUserMessage(params: {
    roomId: string;
    content: string;
    targetBridgeKeys?: string[];
    triggerAI?: boolean;
    contextBlock?: string;
    contextSummary?: string;
    enableTools?: boolean;
  }): Promise<{ success: boolean; userMessage: AIRoomMessage; aiMessages: AIRoomMessage[]; error?: string }> {
    const db = DatabaseService.getInstance();
    const room = db.getAIRoom(params.roomId);
    if (!room) throw new Error('Phòng AI không tồn tại');

    const clean = String(params.content || '').trim();
    if (!clean) throw new Error('Nội dung tin nhắn không được để trống');

    const initMeta: AIRoomMessageMeta | undefined = params.contextSummary
      ? { contextSummary: params.contextSummary }
      : undefined;

    const userMessage = db.addAIRoomMessage({
      roomId: room.id,
      senderType: 'user',
      senderId: 'boss',
      senderName: 'Bạn',
      content: clean,
      meta: initMeta,
    });
    db.save();
    EventBroadcaster.emit('ai:roomMessage', { roomId: room.id, message: userMessage });
    EventBroadcaster.emit('ai:roomUpdated', { roomId: room.id });

    // Optional immediate outbound send to selected bridges
    if (Array.isArray(params.targetBridgeKeys) && params.targetBridgeKeys.length > 0) {
      const targetSet = new Set(params.targetBridgeKeys);
      const targets = room.bridges.filter(
        b => b.enabled && b.relayDirection !== 'inbound_only' && targetSet.has(bridgeKeyOf(b)),
      );
      if (targets.length > 0) {
        const deliveries = await this.deliverToBridges(targets, clean);
        const updatedMeta: AIRoomMessageMeta = { ...(userMessage.meta || {}), relayDeliveries: deliveries };
        db.updateAIRoomMessageMeta(userMessage.id, JSON.stringify(updatedMeta));
        db.save();
        userMessage.meta = updatedMeta;
        userMessage.metadataJson = JSON.stringify(updatedMeta);
        EventBroadcaster.emit('ai:roomMessage', { roomId: room.id, message: userMessage });
      }
    }

    const shouldRunAI = params.triggerAI !== false &&
      room.members.length > 0 &&
      (room.aiTriggerMode !== 'manual' || this.extractMentions(clean, room.members).length > 0 || /@ai|@all|@tatca/i.test(clean));

    const aiMessages: AIRoomMessage[] = shouldRunAI
      ? await this.orchestrateAIReply(room.id, {
          promptText: clean,
          contextBlock: params.contextBlock,
          enableTools: params.enableTools !== false,
        })
      : [];

    return { success: true, userMessage, aiMessages };
  }

  public async triggerManualAI(params: {
    roomId: string;
    assistantId?: string;
    promptText?: string;
    contextBlock?: string;
    enableTools?: boolean;
  }): Promise<{ success: boolean; aiMessages: AIRoomMessage[] }> {
    const aiMessages = await this.orchestrateAIReply(params.roomId, {
      forcedAssistantId: params.assistantId,
      promptText: params.promptText,
      contextBlock: params.contextBlock,
      enableTools: params.enableTools !== false,
    });
    return { success: true, aiMessages };
  }

  public async broadcastToBridges(params: {
    roomId: string;
    messageId?: number;
    content: string;
    prefixSender?: string;
    targetBridgeKeys?: string[];
  }): Promise<{ success: boolean; deliveries: AIRoomRelayDelivery[] }> {
    const db = DatabaseService.getInstance();
    const room = db.getAIRoom(params.roomId);
    if (!room) throw new Error('Phòng AI không tồn tại');

    const targetSet = Array.isArray(params.targetBridgeKeys) && params.targetBridgeKeys.length > 0
      ? new Set(params.targetBridgeKeys)
      : null;

    const targets = room.bridges.filter(
      b => b.enabled &&
        b.relayDirection !== 'inbound_only' &&
        (!targetSet || targetSet.has(bridgeKeyOf(b))),
    );
    if (!targets.length) {
      throw new Error('Không có cầu nối kênh nào được bật cho chiều gửi ra');
    }

    const formatted = formatBridgeOutboundText(params.prefixSender, params.content);
    const deliveries = await this.deliverToBridges(targets, formatted);

    if (params.messageId) {
      const row = db.queryOne<any>(`SELECT metadata_json FROM ai_room_messages WHERE id = ?`, [params.messageId]);
      let meta: AIRoomMessageMeta = {};
      if (row?.metadata_json) {
        try { meta = JSON.parse(row.metadata_json); } catch {}
      }
      meta.relayDeliveries = [...(meta.relayDeliveries || []), ...deliveries];
      const metaJson = JSON.stringify(meta);
      db.updateAIRoomMessageMeta(params.messageId, metaJson);
      db.save();
      const updatedMsg = db.getAIRoomMessages(params.roomId, 200).find(m => m.id === params.messageId);
      if (updatedMsg) {
        EventBroadcaster.emit('ai:roomMessage', { roomId: params.roomId, message: updatedMsg });
      }
    }

    return { success: true, deliveries };
  }

  // ─── Multi-AI Orchestration (Phase 2) ─────────────────────────────────────

  private effectiveAlias(m: AIRoomMember): string {
    return (m.alias || m.assistantName || 'AI').trim().replace(/\s+/g, '');
  }

  private extractMentions(text: string, members: AIRoomMember[]): AIRoomMember[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    if (/(^|\s)@(all|tatca|moinguoi)(\b|$)/i.test(lower)) {
      return [...members];
    }
    const matched: AIRoomMember[] = [];
    for (const m of members) {
      const alias = this.effectiveAlias(m).toLowerCase();
      const fullName = String(m.assistantName || '').trim().toLowerCase();
      if ((alias && lower.includes(`@${alias}`)) || (fullName && lower.includes(`@${fullName}`))) {
        matched.push(m);
      }
    }
    return matched;
  }

  private formatRoomTranscriptForAI(room: AIRoom, currentMember: AIRoomMember, history: AIRoomMessage[]): string {
    const recent = history.slice(-40);
    const lines = recent.map(m => {
      const time = m.createdAt ? new Date(m.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
      if (m.senderType === 'assistant') {
        const isMe = m.senderId === currentMember.assistantId;
        const tag = isMe ? `AI · ${m.senderName} [BẠN]` : `AI · ${m.senderName}`;
        return `[${tag}${time ? ` | ${time}` : ''}]: ${m.content}`;
      }
      if (m.senderType === 'external') {
        const ch = channelBadgeLabel(m.sourceChannel);
        return `[${ch} · ${m.sourceThreadName || ''} | ${m.senderName}${time ? ` | ${time}` : ''}]: ${m.content}`;
      }
      if (m.senderType === 'system') {
        return `[HỆ THỐNG]: ${m.content}`;
      }
      return `[Nhân viên (${m.senderName || 'Bạn'})${time ? ` | ${time}` : ''}]: ${m.content}`;
    });
    return [
      `=== PHÒNG CHAT: "${room.name}" ===`,
      lines.join('\n') || '(Chưa có lịch sử tin nhắn)',
    ].join('\n\n');
  }

  private async runSingleMemberTurn(
    room: AIRoom,
    member: AIRoomMember,
    opts: {
      enableTools: boolean;
      contextBlock?: string;
      moderatorDelegateMode?: boolean;
      moderatorSynthesisNote?: string;
    },
  ): Promise<AIRoomMessage | null> {
    const db = DatabaseService.getInstance();
    const aiSvc = AIAssistantService.getInstance();
    const history = db.getAIRoomMessages(room.id, 60);

    const rosterText = room.members
      .map(m => `  - @${this.effectiveAlias(m)} (${m.assistantName || m.assistantId}): ${m.roleInstruction || 'Hỗ trợ chuyên môn'}`)
      .join('\n');

    const extraParts = [
      `[VAI TRÒ TRONG PHÒNG CHAT NHÓM "${room.name}"]`,
      `- Danh tính của bạn: ${member.assistantName || member.alias} (mention: @${this.effectiveAlias(member)})`,
      member.roleInstruction ? `- Nhiệm vụ chuyên môn của bạn: ${member.roleInstruction}` : '',
      `- Các thành viên AI trong phòng:\n${rosterText}`,
      `- Hãy trả lời đúng chuyên môn của bạn, ngắn gọn, đi thẳng vào vấn đề và KHÔNG lặp lại nguyên văn ý AI khác đã nói ngay trước đó.`,
    ];

    if (opts.moderatorDelegateMode) {
      extraParts.push(
        `- Bạn đang là TRƯỞNG NHÓM ĐIỀU PHỐI (Moderator).`,
        `- Nếu câu hỏi cần nhiều chuyên gia AI trong nhóm cùng góp ý/kiểm tra trước khi chốt, hãy viết dòng đầu tiên đúng cú pháp: \`[DELEGATE: @alias1, @alias2]\` kèm câu hỏi ngắn giao từng chuyên gia. Nếu bạn có thể tự giải quyết trọn vẹn ngay (hoặc dùng tool của mình), hãy trả lời trực tiếp luôn không cần dòng DELEGATE.`,
      );
    }
    if (opts.moderatorSynthesisNote) {
      extraParts.push(`- ${opts.moderatorSynthesisNote}`);
    }

    const transcript = this.formatRoomTranscriptForAI(room, member, history);
    const messagesToSend = [
      { role: 'user', content: transcript },
    ];

    const res = await aiSvc.chatWithTools({
      assistantId: member.assistantId,
      messages: messagesToSend,
      enableTools: opts.enableTools,
      contextBlock: opts.contextBlock,
      extraSystemPrompt: extraParts.filter(Boolean).join('\n'),
    });

    let cleanContent = String(res.result || '').trim();
    if (!cleanContent && (!res.pendingActions || res.pendingActions.length === 0)) {
      return null;
    }

    const aiMeta: AIRoomMessageMeta = {
      assistantName: member.assistantName || member.alias,
      assistantAlias: this.effectiveAlias(member),
      platform: member.platform,
      executedTools: res.executedTools || [],
      pendingActions: res.pendingActions || [],
      totalTokens: res.totalTokens || 0,
    };

    const savedAiMsg = db.addAIRoomMessage({
      roomId: room.id,
      senderType: 'assistant',
      senderId: member.assistantId,
      senderName: member.assistantName || member.alias || 'AI',
      content: cleanContent,
      meta: aiMeta,
    });
    db.save();

    // Auto-relay AI reply to bridges configured with outboundMode === 'auto_relay' & includeAiReplies
    if (cleanContent) {
      const autoRelayTargets = room.bridges.filter(
        b => b.enabled &&
          b.relayDirection !== 'inbound_only' &&
          b.outboundMode === 'auto_relay' &&
          b.includeAiReplies,
      );
      if (autoRelayTargets.length > 0) {
        const deliveries = await this.deliverToBridges(
          autoRelayTargets,
          formatBridgeOutboundText(`🤖 ${member.assistantName || member.alias}`, cleanContent),
        );
        aiMeta.relayDeliveries = deliveries;
        db.updateAIRoomMessageMeta(savedAiMsg.id, JSON.stringify(aiMeta));
        db.save();
        savedAiMsg.meta = aiMeta;
        savedAiMsg.metadataJson = JSON.stringify(aiMeta);
      }
    }

    EventBroadcaster.emit('ai:roomMessage', { roomId: room.id, message: savedAiMsg });
    EventBroadcaster.emit('ai:roomUpdated', { roomId: room.id });
    return savedAiMsg;
  }

  public async orchestrateAIReply(
    roomId: string,
    opts: {
      promptText?: string;
      forcedAssistantId?: string;
      contextBlock?: string;
      enableTools?: boolean;
    } = {},
  ): Promise<AIRoomMessage[]> {
    const db = DatabaseService.getInstance();
    const room = db.getAIRoom(roomId);
    if (!room || !room.members.length) return [];

    const maxTurns = Math.min(8, Math.max(1, room.maxTurnsPerMsg || 3));
    const enableTools = opts.enableTools !== false;
    const created: AIRoomMessage[] = [];

    // 1. Single forced AI button click on a message
    if (opts.forcedAssistantId) {
      const member = room.members.find(m => m.assistantId === opts.forcedAssistantId);
      if (member) {
        const msg = await this.runSingleMemberTurn(room, member, {
          enableTools,
          contextBlock: opts.contextBlock,
        });
        if (msg) created.push(msg);
        return created;
      }
    }

    const latestPrompt = opts.promptText || '';
    const mentioned = this.extractMentions(latestPrompt, room.members);
    const moderator = (room.moderatorAiId && room.members.find(m => m.assistantId === room.moderatorAiId)) || room.members[0];

    // 2. Round-Table mode: mentioned members (or all members) answer sequentially
    if (room.routingMode === 'round_table') {
      const queue = (mentioned.length > 0 ? mentioned : room.members).slice(0, maxTurns);
      for (const m of queue) {
        try {
          const msg = await this.runSingleMemberTurn(room, m, {
            enableTools,
            contextBlock: opts.contextBlock,
          });
          if (msg) created.push(msg);
        } catch (err: any) {
          Logger.warn(`[AIRoomService] round_table turn (${m.assistantName}) failed: ${err?.message || err}`);
        }
      }
      return created;
    }

    // 3. Moderator mode: if multiple members and no explicit specialist @mentioned
    if (room.routingMode === 'moderator' && mentioned.length === 0 && room.members.length > 1) {
      const modFirst = await this.runSingleMemberTurn(room, moderator, {
        enableTools,
        contextBlock: opts.contextBlock,
        moderatorDelegateMode: maxTurns >= 2,
      });
      if (modFirst) created.push(modFirst);

      const delegateMatch = modFirst?.content?.match(/\[DELEGATE:\s*([^\]]+)\]/i);
      if (delegateMatch && created.length < maxTurns) {
        const delegatedRaw = delegateMatch[1] || '';
        const specialists = this.extractMentions(delegatedRaw, room.members)
          .filter(m => m.assistantId !== moderator.assistantId)
          .slice(0, Math.max(1, maxTurns - 2));

        for (const spec of specialists) {
          if (created.length >= maxTurns) break;
          try {
            const msg = await this.runSingleMemberTurn(room, spec, {
              enableTools,
              contextBlock: opts.contextBlock,
            });
            if (msg) created.push(msg);
          } catch (err: any) {
            Logger.warn(`[AIRoomService] delegated turn (${spec.assistantName}) failed: ${err?.message || err}`);
          }
        }

        if (specialists.length > 0 && created.length < maxTurns) {
          try {
            const synth = await this.runSingleMemberTurn(room, moderator, {
              enableTools,
              contextBlock: opts.contextBlock,
              moderatorSynthesisNote: 'Các chuyên gia AI vừa phản hồi ở trên. Hãy tổng hợp ngắn gọn kết luận cuối cùng và phương án hành động rõ ràng cho người dùng (không dùng DELEGATE nữa).',
            });
            if (synth) created.push(synth);
          } catch (err: any) {
            Logger.warn(`[AIRoomService] moderator synthesis failed: ${err?.message || err}`);
          }
        }
      }
      return created;
    }

    // 4. Default @mention routing (fallback to moderator / first member)
    const queue = (mentioned.length > 0 ? mentioned : [moderator]).slice(0, maxTurns);
    for (const m of queue) {
      try {
        const msg = await this.runSingleMemberTurn(room, m, {
          enableTools,
          contextBlock: opts.contextBlock,
        });
        if (msg) created.push(msg);
      } catch (err: any) {
        Logger.warn(`[AIRoomService] mention turn (${m.assistantName}) failed: ${err?.message || err}`);
      }
    }
    return created;
  }
}

export default AIRoomService;
