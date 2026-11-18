import type { AIExecutedToolTrace, AIPendingToolAction } from './ai';

export type AIRoomType = 'multi_ai' | 'bridge';
export type AIRoomRoutingMode = 'mention' | 'round_table' | 'moderator';
export type AIRoomTriggerMode = 'all_internal' | 'all_messages' | 'mention_only' | 'manual';
export type AIBridgeChannel = 'zalo' | 'facebook' | 'telegram_user' | 'telegram_bot';
export type AIBridgeDirection = 'both' | 'inbound_only' | 'outbound_only';
export type AIBridgeOutboundMode = 'approval' | 'auto_relay';

export interface AIRoomMember {
    id?: number;
    roomId: string;
    assistantId: string;
    alias: string;
    roleInstruction: string;
    sortOrder: number;
    assistantName?: string;
    platform?: string;
    model?: string;
}

export interface AIRoomBridge {
    id?: number;
    roomId: string;
    accountId: string;
    channel: AIBridgeChannel;
    threadId: string;
    threadType: number;
    threadName: string;
    relayDirection: AIBridgeDirection;
    outboundMode: AIBridgeOutboundMode;
    includeAiReplies: boolean;
    enabled: boolean;
    createdAt?: number;
}

export interface AIRoom {
    id: string;
    name: string;
    description: string;
    roomType: AIRoomType;
    routingMode: AIRoomRoutingMode;
    moderatorAiId: string | null;
    aiTriggerMode: AIRoomTriggerMode;
    contextFilterJson: string | null;
    maxTurnsPerMsg: number;
    enabled: boolean;
    lastMessageAt: number;
    createdAt: number;
    updatedAt: number;
    members: AIRoomMember[];
    bridges: AIRoomBridge[];
    messageCount?: number;
}

export interface AIRoomRelayDelivery {
    bridgeKey: string;
    accountId: string;
    channel: string;
    threadId: string;
    threadName: string;
    status: 'sent' | 'failed';
    error?: string;
    sentAt: number;
}

export interface AIRoomMessageMeta {
    assistantName?: string;
    assistantAlias?: string;
    platform?: string;
    executedTools?: AIExecutedToolTrace[];
    pendingActions?: AIPendingToolAction[];
    totalTokens?: number;
    relayDeliveries?: AIRoomRelayDelivery[];
    isSelfExternal?: boolean;
    contextSummary?: string;
}

export interface AIRoomMessage {
    id: number;
    roomId: string;
    senderType: 'user' | 'assistant' | 'external' | 'system';
    senderId: string;
    senderName: string;
    sourceChannel?: string | null;
    sourceAccountId?: string | null;
    sourceThreadId?: string | null;
    sourceThreadName?: string | null;
    originMsgId?: string | null;
    content: string;
    metadataJson?: string | null;
    meta?: AIRoomMessageMeta;
    createdAt: number;
}
