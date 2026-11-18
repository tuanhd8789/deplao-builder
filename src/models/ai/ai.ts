export type AIPlatform = 'openai' | 'gemini' | 'claude' | 'deepseek' | 'grok' | 'mistral' | '9router' | 'openrouter';

export type AIToolModule =
    | 'messaging'
    | 'crm'
    | 'hrm'
    | 'tasks'
    | 'calendar_notes'
    | 'reports'
    | 'pos';

/** 'off' = disabled, 'read' = read-only, 'write' = create + read + update (NEVER delete) */
export type AIToolAccessLevel = 'off' | 'read' | 'write';

export type AIToolPermissions = Record<AIToolModule, AIToolAccessLevel>;

export const AI_TOOL_MODULES: readonly AIToolModule[] = [
    'messaging',
    'crm',
    'hrm',
    'tasks',
    'calendar_notes',
    'reports',
    'pos',
];

export const READ_ONLY_AI_TOOL_MODULES: readonly AIToolModule[] = [
    'reports',
    'pos',
];

export const DEFAULT_AI_TOOL_PERMISSIONS: AIToolPermissions = {
    messaging: 'write',
    crm: 'write',
    hrm: 'write',
    tasks: 'write',
    calendar_notes: 'write',
    reports: 'read',
    pos: 'read',
};

export function normalizeAIToolPermissions(raw?: string | Partial<Record<string, any>> | null): AIToolPermissions {
    let parsed: Record<string, any> = {};
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed) {
            try {
                const obj = JSON.parse(trimmed);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    parsed = obj;
                }
            } catch {
                parsed = {};
            }
        }
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsed = raw;
    }

    const result: AIToolPermissions = { ...DEFAULT_AI_TOOL_PERMISSIONS };
    const readOnlySet = new Set<AIToolModule>(READ_ONLY_AI_TOOL_MODULES);

    for (const mod of AI_TOOL_MODULES) {
        const val = parsed[mod];
        if (val === 'off' || val === 'read' || val === 'write') {
            result[mod] = readOnlySet.has(mod) && val === 'write' ? 'read' : val;
        }
    }
    return result;
}

export interface AIAssistant {
    id: string;
    name: string;
    platform: AIPlatform;
    apiKey: string;
    model: string;
    systemPrompt: string;
    baseUrl: string | null;
    posIntegrationId: string | null;
    pinnedProductsJson: string;
    maxTokens: number;
    temperature: number;
    contextMessageCount: number;
    enabled: boolean;
    isDefault: boolean;
    toolPermissionsJson?: string;
    toolPermissions?: AIToolPermissions;
    createdAt: number;
    updatedAt: number;
}

export interface AIAssistantFile {
    id: number;
    assistantId: string;
    fileName: string;
    filePath: string;
    fileSize: number;
    contentText: string;
    createdAt: number;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface AIUsageLog {
    id?: number;
    assistant_id: string;
    assistant_name: string;
    platform: string;
    model: string;
    prompt_text: string;
    response_text: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    created_at: number;
}

export interface AIAccountAssistant {
    id?: number;
    zalo_id: string;
    role: 'suggestion' | 'panel';
    assistant_id: string;
}

export interface ZaloCachedLabel {
    accountId: string;
    id: number;
    text: string;
    color: string;
    emoji?: string;
    conversations: string[];
}

export interface AIContextFilter {
    enabled?: boolean;
    mode?: 'current_thread' | 'custom_filter' | 'off';
    timePreset?: 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom';
    fromTs?: number | null;
    toTs?: number | null;
    accountIds?: string[];
    channels?: string[];
    threadKeys?: Array<{ accountId: string; threadId: string }>;
    threadType?: 'all' | 'direct' | 'group';
    localLabelIds?: number[];
    crmTagIds?: number[];
    /** Zalo cloud label keys formatted as `${accountId}:${labelId}` */
    zaloLabelKeys?: string[];
    /** Label filter match mode: 'any' (OR, default) or 'all' (AND) */
    labelMatchMode?: 'any' | 'all';
    /** '__self__' represents outgoing messages (is_sent = 1). */
    senderIds?: string[];
    keyword?: string;
    /** 1..1000 */
    limit?: number;
}

export interface AIToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, any>;
    kind?: 'read' | 'write';
    module?: AIToolModule;
}

export interface AIToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
}

export interface AIExecutedToolTrace {
    id: string;
    name: string;
    label: string;
    args: Record<string, any>;
    summary: string;
}

export interface AIPendingToolAction {
    id: string;
    toolName: string;
    title: string;
    description: string;
    args: Record<string, any>;
    status: 'pending' | 'approved' | 'rejected' | 'error';
    resultSummary?: string;
    /** True when the renderer performs the action (e.g. send_chat_message). */
    clientSideExecution?: boolean;
    assistantId?: string;
}

export interface AIChatMessageMetadata {
    executedTools?: AIExecutedToolTrace[];
    pendingActions?: AIPendingToolAction[];
    totalTokens?: number;
    assistantId?: string;
    assistantName?: string;
    contextSummary?: string;
}
