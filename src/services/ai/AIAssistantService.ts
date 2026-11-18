/**
 * AIAssistantService.ts
 *
 * Main-process singleton service for AI Assistants.
 * Manages CRUD, API calls to LLM providers, chat suggestions, and direct chat.
 * Reuses the same OpenAI/Gemini/Deepseek/Grok patterns from WorkflowEngineService.
 */

import { safeStorage } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import DatabaseService from '../database/DatabaseService';
import IntegrationRegistry from '../integrations/IntegrationRegistry';
import Logger from '../../utils/Logger';
import { requestAICompletion, type AIProviderMessage } from './AIProviderAdapter';
import AIToolService from './AIToolService';
import { normalizeAIModel } from '../../shared/ai/aiModelCatalog';
import { normalizeSuggestionCount, parseSuggestionResult, suggestionSystemPrompt } from '../../shared/ai/replySuggestions';
import {
  normalizeAIToolPermissions,
  type AIAssistant,
  type AIAssistantFile,
  type ChatMessage,
  type AIPlatform,
  type AIExecutedToolTrace,
  type AIPendingToolAction,
  type AIToolDefinition,
  type AIToolModule,
} from '../../models';
import { tr } from '../../shared/i18n';

// ─── Encryption helpers ───────────────────────────────────────────────────────

function encryptApiKey(key: string): string {
  if (!key) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(key).toString('base64');
    }
  } catch {}
  return key;
}

function decryptApiKey(raw: string): string {
  if (!raw) return '';
  if (raw.startsWith('enc:')) {
    try {
      const buf = Buffer.from(raw.slice(4), 'base64');
      return safeStorage.decryptString(buf);
    } catch {}
  }
  return raw;
}

// ─── Platform URL helpers ─────────────────────────────────────────────────────

function getOpenAICompatibleUrl(platform: string): string {
  switch (platform) {
    case 'deepseek':   return 'https://api.deepseek.com/v1/chat/completions';
    case 'grok':       return 'https://api.x.ai/v1/chat/completions';
    case 'mistral':    return 'https://api.mistral.ai/v1/chat/completions';
    case '9router':    return 'http://localhost:20128/v1/chat/completions';
    case 'openrouter': return 'https://openrouter.ai/api/v1/chat/completions';
    case 'openai':
    default:           return 'https://api.openai.com/v1/chat/completions';
  }
}

/** Resolve API URL - uses baseUrl override if set, otherwise falls back to default */
function resolveApiUrl(platform: string, model: string, apiKey: string, baseUrl: string | null): string {
  if (baseUrl) {
    const base = baseUrl.replace(/\/+$/, '');
    // If baseUrl already points to a full endpoint path, use it as-is
    if (base.endsWith('/chat/completions') || base.match(/\/v\d+\/chat\/completions$/)) {
      return base;
    }
    if (platform === 'gemini') {
      return `${base}/v1beta/models/${model}:generateContent?key=${apiKey}`;
    } else if (platform === 'claude') {
      return `${base}/v1/messages`;
    }
    // If baseUrl already has a version prefix (e.g. /v1), add /chat/completions directly
    if (base.match(/\/v\d+$/)) {
      return `${base}/chat/completions`;
    }
    return `${base}/v1/chat/completions`;
  }
  if (platform === 'gemini') {
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  } else if (platform === 'claude') {
    return 'https://api.anthropic.com/v1/messages';
  }
  return getOpenAICompatibleUrl(platform);
}

function openaiMessagesToGemini(messages: ChatMessage[]): any[] {
  const contents: any[] = [];
  let systemText = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += (systemText ? '\n' : '') + msg.content;
      continue;
    }
    const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
    contents.push({ role: geminiRole, parts: [{ text: msg.content }] });
  }
  if (systemText) {
    contents.unshift(
      { role: 'user', parts: [{ text: `System instruction: ${systemText}` }] },
      { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
    );
  }
  return contents;
}

// ─── Service ──────────────────────────────────────────────────────────────────

class AIAssistantService {
  private static instance: AIAssistantService;

  public static getInstance(): AIAssistantService {
    if (!AIAssistantService.instance) AIAssistantService.instance = new AIAssistantService();
    return AIAssistantService.instance;
  }

  private constructor() {}

  // ─── CRUD ────────────────────────────────────────────────────────────────

  public listAssistants(): AIAssistant[] {
    const db = DatabaseService.getInstance();
    const rows = db.query(`SELECT * FROM ai_assistants ORDER BY is_default DESC, updated_at DESC`);
    return rows.map(this.rowToAssistant);
  }

  public getAssistant(id: string): AIAssistant | null {
    const db = DatabaseService.getInstance();
    const rows = db.query(`SELECT * FROM ai_assistants WHERE id = ?`, [id]);
    if (!rows.length) return null;
    const assistant = this.rowToAssistant(rows[0]);
    Logger.info(`[AIAssistant] getAssistant id=${id}, pinnedProductsJson.length=${assistant.pinnedProductsJson?.length || 0}, posIntegrationId=${assistant.posIntegrationId}`);
    return assistant;
  }

  public getDefaultAssistant(): AIAssistant | null {
    const db = DatabaseService.getInstance();
    const rows = db.query(`SELECT * FROM ai_assistants WHERE is_default = 1 AND enabled = 1 LIMIT 1`);
    if (rows.length) return this.rowToAssistant(rows[0]);
    // Fallback: first enabled assistant
    const fallback = db.query(`SELECT * FROM ai_assistants WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 1`);
    return fallback.length ? this.rowToAssistant(fallback[0]) : null;
  }

  public saveAssistant(data: Partial<AIAssistant> & { name: string; platform: AIPlatform; apiKey: string; model: string }): string {
    const db = DatabaseService.getInstance();
    const id = data.id || uuidv4();
    const now = Date.now();
    // If apiKey is the masked placeholder '***', pass it through as-is
    // so the SQL CASE can detect it and preserve the existing key.
    const encrypted = data.apiKey === '***' ? '***' : encryptApiKey(data.apiKey);
    const model = normalizeAIModel(data.platform, data.model);

    const pinnedJson = data.pinnedProductsJson || '[]';
    const perms = normalizeAIToolPermissions(data.toolPermissions ?? data.toolPermissionsJson);
    const toolPermissionsJson = JSON.stringify(perms);
    Logger.info(`[AIAssistant] saveAssistant id=${id}, posIntegrationId=${data.posIntegrationId || 'null'}, pinnedProductsJson.length=${pinnedJson.length}, toolPerms=${toolPermissionsJson}`);

    // If setting as default, unset others
    if (data.isDefault) {
      db.run(`UPDATE ai_assistants SET is_default = 0`);
    }

    db.run(`INSERT INTO ai_assistants (id, name, platform, api_key_encrypted, model, system_prompt, base_url, pos_integration_id, pinned_products_json, tool_permissions_json, max_tokens, temperature, context_message_count, enabled, is_default, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name, platform = excluded.platform,
              api_key_encrypted = CASE WHEN excluded.api_key_encrypted = '***' THEN ai_assistants.api_key_encrypted ELSE excluded.api_key_encrypted END,
              model = excluded.model, system_prompt = excluded.system_prompt,
              base_url = excluded.base_url,
              pos_integration_id = excluded.pos_integration_id,
              pinned_products_json = excluded.pinned_products_json,
              tool_permissions_json = excluded.tool_permissions_json,
              max_tokens = excluded.max_tokens, temperature = excluded.temperature,
              context_message_count = excluded.context_message_count,
              enabled = excluded.enabled, is_default = excluded.is_default,
              updated_at = excluded.updated_at`,
      [
        id, data.name, data.platform, encrypted, model,
        data.systemPrompt || '', data.baseUrl || null,
        data.posIntegrationId || null,
        pinnedJson,
        toolPermissionsJson,
        data.maxTokens || 1000, data.temperature ?? 0.7,
        data.contextMessageCount || 30,
        data.enabled !== false ? 1 : 0, data.isDefault ? 1 : 0,
        data.id ? now : now, now,
      ]);
    db.save();

    // Verify save: read back and check pinned_products_json
    try {
      const verify = db.query<any>(`SELECT pinned_products_json FROM ai_assistants WHERE id = ?`, [id]);
      const saved = verify[0]?.pinned_products_json || '[]';
      Logger.info(`[AIAssistant] saveAssistant VERIFY: id=${id}, savedPinnedLen=${saved.length}, match=${saved === pinnedJson}`);
    } catch (e: any) {
      Logger.warn(`[AIAssistant] saveAssistant VERIFY failed: ${e.message}`);
    }

    return id;
  }

  public deleteAssistant(id: string): void {
    const db = DatabaseService.getInstance();
    db.run(`DELETE FROM ai_assistant_files WHERE assistant_id = ?`, [id]);
    db.run(`DELETE FROM ai_assistants WHERE id = ?`, [id]);
  }

  // ─── Files ──────────────────────────────────────────────────────────────

  public getFiles(assistantId: string): AIAssistantFile[] {
    const db = DatabaseService.getInstance();
    const rows = db.query(`SELECT * FROM ai_assistant_files WHERE assistant_id = ? ORDER BY created_at DESC`, [assistantId]);
    return rows.map((r: any) => ({
      id: r.id,
      assistantId: r.assistant_id,
      fileName: r.file_name,
      filePath: r.file_path,
      fileSize: r.file_size,
      contentText: r.content_text || '',
      createdAt: r.created_at,
    }));
  }

  public addFile(assistantId: string, fileName: string, filePath: string, fileSize: number, contentText: string): number {
    const db = DatabaseService.getInstance();
    db.run(
      `INSERT INTO ai_assistant_files (assistant_id, file_name, file_path, file_size, content_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [assistantId, fileName, filePath, fileSize, contentText, Date.now()]
    );
    const rows = db.query<any>(`SELECT last_insert_rowid() as id`);
    return rows[0]?.id || 0;
  }

  public removeFile(fileId: number): void {
    DatabaseService.getInstance().run(`DELETE FROM ai_assistant_files WHERE id = ?`, [fileId]);
  }

  // ─── AI API Calls ────────────────────────────────────────────────────────

  /**
   * Build full system prompt with knowledge base + POS products
   * @param forWorkflow - If true, append structured JSON output instructions for workflow auto-reply
   */
  private async buildSystemPrompt(assistant: AIAssistant, forWorkflow: boolean = false): Promise<string> {
    const parts: string[] = [];

    // 1. Custom system prompt
    if (assistant.systemPrompt) parts.push(assistant.systemPrompt);

    // 2. Knowledge base files
    const files = this.getFiles(assistant.id);
    if (files.length > 0) {
      const kbText = files
        .filter(f => f.contentText.trim())
        .map(f => `--- ${f.fileName} ---\n${f.contentText}`)
        .join('\n\n');
      if (kbText) {
        parts.push(`\n\n[Kiến thức tham khảo]\n${kbText}`);
      }
    }

    // 3. POS product data - prefer pinned products, fallback to live fetch
    let pinnedProducts: any[] = [];
    try { pinnedProducts = JSON.parse(assistant.pinnedProductsJson || '[]'); } catch {}

    Logger.info(`[AIAssistant] buildSystemPrompt: pinnedProducts=${pinnedProducts.length}, posIntegrationId=${assistant.posIntegrationId}, forWorkflow=${forWorkflow}`);

    if (pinnedProducts.length > 0) {
      // Use user-curated pinned products
      const productList = pinnedProducts.map((p: any) => {
        const name = p.name || p._name || '';
        const price = p.price || p._price || 'N/A';
        const sku = p.code || p._code || 'N/A';
        const imgUrl = p.image || p._image || '';
        return `- ${name} | Giá: ${price} | SKU: ${sku}${imgUrl ? ` | Ảnh: ${imgUrl}` : ''}`;
      }).join('\n');
      parts.push(`\n\n[Danh sách sản phẩm (${pinnedProducts.length} SP đã chọn)]\n${productList}`);
    } else if (assistant.posIntegrationId) {
      // Fallback: live fetch from POS (legacy behavior)
      try {
        const result = await IntegrationRegistry.executeAction(
          assistant.posIntegrationId, 'lookupProduct', { keyword: '', limit: 50 }
        );
        if (result && Array.isArray(result.products) && result.products.length > 0) {
          const productList = result.products.slice(0, 50).map((p: any) => {
            const name = p.name || p.productName || '';
            const price = p.price || p.basePrice || 'N/A';
            const sku = p.code || p.sku || 'N/A';
            const imgUrl = p.imageUrl || p.image?.src || p.images?.[0]?.src || p.images?.[0]?.url
              || p.image_url || p.image || p.smallImage || p.thumbnail || '';
            return `- ${name} | Giá: ${price} | SKU: ${sku}${imgUrl ? ` | Ảnh: ${imgUrl}` : ''}`;
          }).join('\n');
          parts.push(`\n\n[Danh sách sản phẩm]\n${productList}`);
        }
      } catch (e: any) {
        Logger.warn(`[AIAssistant] Failed to load POS products: ${e.message}`);
      }
    }

    // 4. Workflow auto-reply: structured JSON output + natural conversational tone
    if (forWorkflow) {
      parts.push(`

[QUY TẮC TRẢ LỜI - BẮT BUỘC TUÂN THỦ 100%]

1. PHONG CÁCH: Trả lời tự nhiên như người thật đang chat. Ngắn gọn, thân thiện, KHÔNG dùng markdown, KHÔNG dùng bullet/numbering, KHÔNG dùng emoji quá nhiều.

2. CHIA CÂU: Mỗi ý tách riêng thành 1 câu ngắn gọn (mỗi câu là 1 tin nhắn chat riêng). KHÔNG dồn hết mọi thứ vào 1 đoạn dài. Tưởng tượng bạn đang nhắn tin trên điện thoại - mỗi lần gửi 1-2 câu ngắn.

3. HÌNH ẢNH: Nếu trong dữ liệu kiến thức/sản phẩm có link ảnh (URL bắt đầu bằng http:// hoặc https:// và kết thúc bằng .jpg, .jpeg, .png, .gif, .webp hoặc chứa /image), hãy trả về dạng image. Chỉ gửi ảnh khi thực sự liên quan đến câu hỏi.

4. ĐỊNH DẠNG ĐẦU RA: BẮT BUỘC trả về JSON array, KHÔNG trả về text thuần. Mỗi phần tử có dạng:
   - Tin nhắn text: {"type": "text", "content": "Nội dung tin nhắn"}
   - Hình ảnh: {"type": "image", "content": ["url_ảnh_1", "url_ảnh_2"]}

VÍ DỤ ĐẦU RA ĐÚNG:
[
  {"type": "text", "content": "Chào bạn!"},
  {"type": "text", "content": "Sản phẩm A giá 240.000đ nha"},
  {"type": "image", "content": ["https://example.com/product-a.jpg"]},
  {"type": "text", "content": "Bạn cần tư vấn thêm gì không?"}
]

5. KHÔNG BAO GIỜ trả về text thường. LUÔN LUÔN trả về JSON array như trên.`);
    } else {
      const nowStr = new Date().toLocaleString('vi-VN', { hour12: false });
      const perms = normalizeAIToolPermissions(assistant.toolPermissions ?? assistant.toolPermissionsJson);
      const moduleLabels: Record<AIToolModule, string> = {
        messaging: 'Tin nhắn & Hội thoại',
        crm: 'CRM (Khách hàng, Nhãn, Ghi chú, Chiến dịch)',
        hrm: 'Phòng ban, Chức vụ & Nhân sự (HRM)',
        tasks: 'Dự án & Công việc (Tasks, Checklist, Bình luận)',
        calendar_notes: 'Lịch hẹn & Ghi chú ERP',
        reports: 'Tóm tắt & Báo cáo công việc',
        pos: 'Tra cứu POS / Đơn hàng',
      };
      const accessLabel = (lvl: 'off' | 'read' | 'write') =>
        lvl === 'write' ? 'Tạo, Đọc & Sửa' : lvl === 'read' ? 'Chỉ đọc' : 'Đã tắt';
      const permSummary = (Object.keys(moduleLabels) as AIToolModule[])
        .map(m => `  + ${moduleLabels[m]}: ${accessLabel(perms[m])}`)
        .join('\n');

      parts.push(`

[HƯỚNG DẪN TRỢ LÝ NỘI BỘ DEPLAO]
- Thời gian hiện tại trên máy người dùng: ${nowStr}.
- Bạn đang trò chuyện trực tiếp với nhân viên/chủ shop bên trong ứng dụng Deplao (KHÔNG gửi trực tiếp cho khách trừ khi người dùng duyệt thẻ xác nhận).
- Hãy trình bày rõ ràng, chuyên nghiệp bằng Markdown chuẩn (tiêu đề, danh sách, **in đậm** ý chính, bảng Markdown khi so sánh hoặc tổng hợp nhiều mục, code block khi đưa mẫu câu hoặc dữ liệu).
- QUY TẮC BẢO VỆ DỮ LIỆU (BẮT BUỘC): Hệ thống CHẶN TUYỆT ĐỐI quyền XÓA đối với AI. Bạn CHỈ được phép Tạo mới (Create), Đọc (Read), Sửa/Cập nhật (Update) trong đúng phạm vi phân hệ được cấp quyền dưới đây — KHÔNG BAO GIỜ xóa phòng ban, chức vụ, nhân sự, dự án, công việc, lịch hẹn, ghi chú, khách hàng, nhãn hay chiến dịch. Nếu người dùng yêu cầu xóa dữ liệu, hãy từ chối lịch sự theo chính sách an toàn dữ liệu và hướng dẫn họ tự xóa thủ công trên giao diện Deplao.
- Phân quyền tính năng hiện tại của bạn:
${permSummary}
- Cách dùng công cụ:
  + Chủ động gọi các tool Đọc (\`list_org_structure\`, \`list_projects_and_tasks\`, \`generate_work_report\`, \`lookup_crm_contacts\`, \`list_crm_tags_and_campaigns\`, \`list_calendar_and_notes\`, \`query_messages\`, v.v.) để lấy dữ liệu và ID thật trước khi tổng hợp báo cáo hoặc đề xuất cập nhật.
  + Khi người dùng yêu cầu tạo nhiều phòng ban, nhiều chức vụ hoặc nhiều công việc cùng lúc, ưu tiên gộp vào tham số mảng \`items\` (hoặc gọi các tool Tạo/Sửa tương ứng) để hệ thống hiển thị thẻ xác nhận cho người dùng bấm duyệt một lần.`);
    }

    return parts.join('\n');
  }

  /**
   * Call LLM API with messages
   */
  private async callLLM(
    assistant: AIAssistant,
    messages: AIProviderMessage[],
    maxTokensOverride?: number,
    temperatureOverride?: number,
    tools?: AIToolDefinition[],
  ): Promise<{ result: string; totalTokens: number; promptTokens: number; completionTokens: number; toolCalls?: any[] }> {
    const maxTokens = maxTokensOverride || assistant.maxTokens || 1000;
    const temperature = typeof temperatureOverride === 'number' && Number.isFinite(temperatureOverride)
      ? temperatureOverride
      : (assistant.temperature ?? 0.7);
    const model = assistant.model;

    // Debug: log request info
    const keyPreview = assistant.apiKey ? `${assistant.apiKey.substring(0, 8)}...${assistant.apiKey.substring(assistant.apiKey.length - 4)}` : '(empty)';
    Logger.info(`[AIAssistant] callLLM → platform=${assistant.platform}, model=${model}${model !== assistant.model ? ` (normalized from ${assistant.model})` : ''}, keyPreview=${keyPreview}, maxTokens=${maxTokens}, tools=${tools?.length || 0}`);

    let result = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let toolCalls: any[] | undefined;

    try {
      const response = await requestAICompletion({
        platform: assistant.platform,
        model,
        apiKey: assistant.apiKey,
        messages,
        maxTokens,
        temperature,
        baseUrl: assistant.baseUrl,
        tools,
      });
      result = response.result;
      promptTokens = response.promptTokens;
      completionTokens = response.completionTokens;
      totalTokens = response.totalTokens;
      toolCalls = response.toolCalls;
    } catch (err: any) {
      // Enhanced error logging
      const status = err.response?.status;
      const errData = err.response?.data;
      const errMsg = errData?.error?.message || errData?.error || errData?.message || err.message;
      Logger.error(`[AIAssistant] callLLM FAILED → status=${status}, platform=${assistant.platform}, model=${assistant.model}, error=${JSON.stringify(errMsg)}, fullResponse=${JSON.stringify(errData)?.substring(0, 1000)}`);
      throw err;
    }

    // Log usage to DB
    try {
      this.logUsage(assistant.id, assistant.name, assistant.platform, assistant.model,
        messages.map(m => m.content || '').join('\n---\n').substring(0, 5000),
        (result || JSON.stringify(toolCalls || '')).substring(0, 5000),
        promptTokens, completionTokens, totalTokens);
    } catch {}

    return { result, totalTokens, promptTokens, completionTokens, toolCalls };
  }

  // ─── Public AI methods ──────────────────────────────────────────────────

  /**
   * Suggest reply sentences from the conversation history. `count` = number of sentences (1..5; the compose box default is 3, set in the AI suggestions menu);
   * if not passed (API, old employee builds) = 5 as before.
   */
  public async getSuggestions(assistantId: string, chatHistory: Array<{ role: string; content: string }>, count?: number): Promise<string[]> {
    const assistant = this.getAssistant(assistantId);
    if (!assistant || !assistant.enabled) return [];

    const wanted = normalizeSuggestionCount(count);
    const contextCount = assistant.contextMessageCount || 30;
    // Do NOT use buildSystemPrompt() here, because the assistant system prompt may override
    // the suggest instruction (especially with FREE models). Use only the plain instruction.
    const messages: ChatMessage[] = [
      { role: 'system', content: suggestionSystemPrompt(wanted) },
      ...chatHistory.slice(-contextCount).map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    try {
      const { result } = await this.callLLM(assistant, messages, 1000);
      Logger.info(`[AIAssistant] getSuggestions raw result: ${result}`);
      const suggestions = parseSuggestionResult(result, wanted);
      Logger.info(`[AIAssistant] getSuggestions parsed ${suggestions.length}/${wanted} suggestions: ${JSON.stringify(suggestions)}`);
      return suggestions;
    } catch (e: any) {
      Logger.error(`[AIAssistant] getSuggestions error: ${e.message}`);
      return [];
    }
  }

  /**
   * Direct chat with AI assistant
   * @param structured - If true, use structured JSON output rules (text/image segments) same as workflow
   */
  public async chat(assistantId: string, conversationMessages: Array<{ role: string; content: string }>, structured: boolean = false, maxTokensOverride?: number): Promise<{ result: string; totalTokens: number; promptTokens: number; completionTokens: number }> {
    const assistant = this.getAssistant(assistantId);
    if (!assistant) throw new Error(tr('Trợ lý AI không tồn tại'));
    if (!assistant.enabled) throw new Error(tr('Trợ lý AI đã bị tắt'));

    const systemPrompt = await this.buildSystemPrompt(assistant, structured);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversationMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    return await this.callLLM(assistant, messages, maxTokensOverride);
  }

  /**
   * Internal AI chat with rich Markdown formatting + native Tool Calling loop.
   * Auto-executes Read tools (up to 5 rounds) and returns Write tools as `pendingActions` for user confirmation.
   */
  public async chatWithTools(params: {
    assistantId: string;
    messages: Array<{ role: string; content: string }>;
    enableTools?: boolean;
    contextBlock?: string;
    maxTokensOverride?: number;
  }): Promise<{
    result: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    executedTools: AIExecutedToolTrace[];
    pendingActions: AIPendingToolAction[];
  }> {
    const assistant = this.getAssistant(params.assistantId);
    if (!assistant) throw new Error(tr('Trợ lý AI không tồn tại'));
    if (!assistant.enabled) throw new Error(tr('Trợ lý AI đã bị tắt'));

    const systemPrompt = await this.buildSystemPrompt(assistant, false);
    const messages: AIProviderMessage[] = [{ role: 'system', content: systemPrompt }];
    if (params.contextBlock?.trim()) {
      messages.push(
        { role: 'user', content: params.contextBlock.trim() },
        { role: 'assistant', content: 'Đã tiếp nhận ngữ cảnh hội thoại được lọc. Tôi sẵn sàng phân tích và trả lời câu hỏi của bạn.' },
      );
    }
    for (const m of params.messages || []) {
      if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
      messages.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      });
    }

    const assistantPerms = normalizeAIToolPermissions(assistant.toolPermissions ?? assistant.toolPermissionsJson);
    const allowedTools = params.enableTools === false ? [] : AIToolService.getToolDefinitions(assistantPerms);
    const tools = allowedTools.length > 0 ? allowedTools : undefined;
    const maxTokens = params.maxTokensOverride || Math.max(assistant.maxTokens || 1000, 4096);

    const executedTools: AIExecutedToolTrace[] = [];
    const pendingActions: AIPendingToolAction[] = [];
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalAll = 0;
    let finalResult = '';

    for (let round = 0; round < 5; round++) {
      const res = await this.callLLM(assistant, messages, maxTokens, undefined, tools);
      totalPrompt += res.promptTokens || 0;
      totalCompletion += res.completionTokens || 0;
      totalAll += res.totalTokens || 0;

      const calls = res.toolCalls || [];
      if (!calls.length) {
        finalResult = res.result || '';
        break;
      }

      messages.push({
        role: 'assistant',
        content: res.result || '',
        toolCalls: calls,
      });

      let hasWriteCall = false;
      for (const tc of calls) {
        const permCheck = AIToolService.canExecuteTool(tc.name, assistantPerms);
        if (!permCheck.allowed) {
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify({
              status: 'denied',
              error: permCheck.reason || 'Công cụ này không được cấp quyền cho trợ lý AI hiện tại.',
            }),
          });
          continue;
        }
        if (AIToolService.isWriteTool(tc.name)) {
          hasWriteCall = true;
          const pending = AIToolService.buildPendingAction(tc, assistant.id);
          pendingActions.push(pending);
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify({
              status: 'pending_user_confirmation',
              actionTitle: pending.title,
              message: 'Thẻ xác nhận đã được hiển thị trên giao diện. Hãy thông báo ngắn gọn để người dùng bấm Xác nhận thực hiện.',
            }),
          });
        } else {
          const toolRes = await AIToolService.executeReadTool(tc.name, tc.arguments, assistantPerms);
          executedTools.push({
            id: tc.id,
            name: tc.name,
            label: AIToolService.getToolLabel(tc.name),
            args: tc.arguments || {},
            summary: toolRes.summary,
          });
          const payloadStr = JSON.stringify(toolRes.data);
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: payloadStr.length > 30000 ? payloadStr.slice(0, 30000) + '...(truncated)' : payloadStr,
          });
        }
      }

      // On the last loop round or if model already produced text alongside write-only calls, let it summarize once more
      if (round === 4 && !finalResult) {
        const finalRes = await this.callLLM(assistant, messages, maxTokens, undefined, undefined);
        totalPrompt += finalRes.promptTokens || 0;
        totalCompletion += finalRes.completionTokens || 0;
        totalAll += finalRes.totalTokens || 0;
        finalResult = finalRes.result || (hasWriteCall ? 'Đã chuẩn bị các hành động đề xuất bên dưới để bạn xác nhận.' : '');
      }
    }

    if (!finalResult && pendingActions.length > 0) {
      finalResult = 'Mình đã chuẩn bị các đề xuất thao tác bên dưới — bạn kiểm tra và bấm **Xác nhận** để thực hiện nhé.';
    }

    return {
      result: finalResult,
      totalTokens: totalAll,
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      executedTools,
      pendingActions,
    };
  }

  /**
   * Chat with the assistant's model/API key but ONLY the caller's messages (no persona / knowledge
   * system prompt) - for tools that bring their own detailed system prompt (AI Workflow Builder).
   */
  public async chatRaw(
    assistantId: string,
    messages: Array<{ role: string; content: string }>,
    opts: { maxTokens?: number; temperature?: number } = {},
  ): Promise<{ result: string; totalTokens: number; promptTokens: number; completionTokens: number }> {
    const assistant = this.getAssistant(assistantId);
    if (!assistant) throw new Error(tr('Trợ lý AI không tồn tại'));
    if (!assistant.enabled) throw new Error(tr('Trợ lý AI đã bị tắt'));
    const chatMessages: ChatMessage[] = messages
      .filter(m => m && typeof m.content === 'string' && m.content.trim())
      .map(m => ({ role: (m.role === 'system' || m.role === 'assistant' ? m.role : 'user') as ChatMessage['role'], content: m.content }));
    return await this.callLLM(assistant, chatMessages, opts.maxTokens, opts.temperature);
  }

  /**
   * Chat with AI assistant for workflow auto-reply.
   * Uses structured JSON output format (text/image segments) + natural conversational tone.
   */
  public async chatForWorkflow(assistantId: string, conversationMessages: Array<{ role: string; content: string }>): Promise<{ result: string; totalTokens: number; promptTokens: number; completionTokens: number }> {
    const assistant = this.getAssistant(assistantId);
    if (!assistant) throw new Error(tr('Trợ lý AI không tồn tại'));
    if (!assistant.enabled) throw new Error(tr('Trợ lý AI đã bị tắt'));

    const systemPrompt = await this.buildSystemPrompt(assistant, true);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversationMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    return await this.callLLM(assistant, messages);
  }

  /**
   * Test API key / connection
   */
  public async testConnection(assistantId: string): Promise<{ success: boolean; message: string }> {
    const assistant = this.getAssistant(assistantId);
    if (!assistant) return { success: false, message: tr('Không tìm thấy trợ lý') };

    try {
      const { result } = await this.callLLM(assistant, [
        { role: 'user', content: 'Xin chào, đây là tin nhắn test. Trả lời ngắn gọn.' }
      ], 50);
      return { success: true, message: result ? tr('✅ Kết nối thành công! AI trả lời: "{{v1}}"', { v1: result.substring(0, 80) }) : tr('✅ Kết nối OK') };
    } catch (e: any) {
      return { success: false, message: tr('❌ Lỗi: {{v1}}', { v1: e.response?.data?.error?.message || e.message }) };
    }
  }

  // ─── Usage logging & reporting ─────────────────────────────────────────

  private logUsage(
    assistantId: string, assistantName: string, platform: string, model: string,
    promptText: string, responseText: string,
    promptTokens: number, completionTokens: number, totalTokens: number,
  ): void {
    const db = DatabaseService.getInstance();
    db.run(
      `INSERT INTO ai_usage_logs (assistant_id, assistant_name, platform, model, prompt_text, response_text, prompt_tokens, completion_tokens, total_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [assistantId, assistantName, platform, model, promptText, responseText, promptTokens, completionTokens, totalTokens, Date.now()]
    );
  }

  /**
   * Get usage logs with optional filters
   */
  public getUsageLogs(opts?: { assistantId?: string; dateFrom?: number; dateTo?: number; limit?: number }): any[] {
    const db = DatabaseService.getInstance();
    let sql = 'SELECT * FROM ai_usage_logs WHERE 1=1';
    const params: any[] = [];
    if (opts?.assistantId) { sql += ' AND assistant_id = ?'; params.push(opts.assistantId); }
    if (opts?.dateFrom) { sql += ' AND created_at >= ?'; params.push(opts.dateFrom); }
    if (opts?.dateTo) { sql += ' AND created_at <= ?'; params.push(opts.dateTo); }
    sql += ' ORDER BY created_at DESC';
    if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
    return db.query(sql, params);
  }

  /**
   * Get aggregated usage stats grouped by day
   */
  public getUsageStats(opts?: { assistantId?: string; days?: number }): any[] {
    const db = DatabaseService.getInstance();
    const daysBack = opts?.days || 30;
    const since = Date.now() - daysBack * 86400000;
    let sql = `
      SELECT
        date(created_at / 1000, 'unixepoch', 'localtime') as day,
        assistant_name,
        assistant_id,
        platform,
        model,
        COUNT(*) as request_count,
        SUM(prompt_tokens) as total_prompt_tokens,
        SUM(completion_tokens) as total_completion_tokens,
        SUM(total_tokens) as total_tokens
      FROM ai_usage_logs
      WHERE created_at >= ?
    `;
    const params: any[] = [since];
    if (opts?.assistantId) { sql += ' AND assistant_id = ?'; params.push(opts.assistantId); }
    sql += ' GROUP BY day, assistant_id ORDER BY day DESC, request_count DESC';
    return db.query(sql, params);
  }

  // ─── Per-account assistant assignment ─────────────────────────────────

  /**
   * Get assistant assigned for a specific account+role, falling back to global default
   */
  public getAssistantForAccount(zaloId: string, role: 'suggestion' | 'panel'): AIAssistant | null {
    const db = DatabaseService.getInstance();
    const rows = db.query(`SELECT assistant_id FROM ai_account_assistants WHERE zalo_id = ? AND role = ?`, [zaloId, role]);
    if (rows.length > 0) {
      const assistant = this.getAssistant((rows[0] as any).assistant_id);
      if (assistant && assistant.enabled) return assistant;
    }
    // Fallback to global default
    return this.getDefaultAssistant();
  }

  /**
   * Set assistant for a specific account+role
   */
  public setAccountAssistant(zaloId: string, role: 'suggestion' | 'panel', assistantId: string | null): void {
    const db = DatabaseService.getInstance();
    if (!assistantId) {
      db.run(`DELETE FROM ai_account_assistants WHERE zalo_id = ? AND role = ?`, [zaloId, role]);
    } else {
      db.run(`INSERT INTO ai_account_assistants (zalo_id, role, assistant_id) VALUES (?, ?, ?)
              ON CONFLICT(zalo_id, role) DO UPDATE SET assistant_id = excluded.assistant_id`,
        [zaloId, role, assistantId]);
    }
  }

  /**
   * Get all account assistant assignments
   */
  public getAccountAssistants(zaloId: string): { suggestion: string | null; panel: string | null } {
    const db = DatabaseService.getInstance();
    const rows = db.query(`SELECT role, assistant_id FROM ai_account_assistants WHERE zalo_id = ?`, [zaloId]);
    const result: { suggestion: string | null; panel: string | null } = { suggestion: null, panel: null };
    for (const row of rows as any[]) {
      if (row.role === 'suggestion') result.suggestion = row.assistant_id;
      if (row.role === 'panel') result.panel = row.assistant_id;
    }
    return result;
  }

  // ─── Row mapper ─────────────────────────────────────────────────────────

  private rowToAssistant(row: any): AIAssistant {
    const model = normalizeAIModel(row.platform || 'openai', row.model);
    // Persist a known retired ID as soon as the assistant is loaded. This is
    // intentionally limited to catalog aliases; custom proxy model IDs remain
    // untouched by normalizeAIModel.
    if (model && model !== row.model && row.id) {
      try {
        DatabaseService.getInstance().run(
          'UPDATE ai_assistants SET model = ?, updated_at = ? WHERE id = ?',
          [model, Date.now(), row.id],
        );
      } catch {}
    }
    const toolPermissions = normalizeAIToolPermissions(row.tool_permissions_json);
    return {
      id: row.id,
      name: row.name,
      platform: row.platform as AIPlatform,
      apiKey: decryptApiKey(row.api_key_encrypted),
      model,
      systemPrompt: row.system_prompt || '',
      baseUrl: row.base_url || null,
      posIntegrationId: row.pos_integration_id || null,
      pinnedProductsJson: row.pinned_products_json || '[]',
      maxTokens: row.max_tokens || 1000,
      temperature: row.temperature ?? 0.7,
      contextMessageCount: row.context_message_count || 30,
      enabled: row.enabled === 1,
      isDefault: row.is_default === 1,
      toolPermissionsJson: JSON.stringify(toolPermissions),
      toolPermissions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export default AIAssistantService;
