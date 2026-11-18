import axios from 'axios';
import { normalizeAIModel } from '../../shared/ai/aiModelCatalog';
import type { AIToolCall, AIToolDefinition } from '../../models/ai/ai';

export interface AIProviderMessage {
  role: string;
  content: string;
  toolCalls?: AIToolCall[];
  toolCallId?: string;
  toolName?: string;
}
export interface AICompletionRequest {
  platform: string;
  model?: string;
  apiKey: string;
  messages: AIProviderMessage[];
  maxTokens: number;
  temperature?: number;
  baseUrl?: string | null;
  tools?: AIToolDefinition[];
}
export interface AICompletionResponse {
  result: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls?: AIToolCall[];
}

function endpoint(platform: string, model: string, apiKey: string, baseUrl?: string | null): string {
  const base = baseUrl?.replace(/\/+$/, '');
  if (base) {
    if (base.includes(':generateContent') || base.endsWith('/chat/completions') || base.endsWith('/messages')) return base;
    if (platform === 'gemini') return `${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    if (platform === 'claude') return `${base}/v1/messages`;
    return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }
  if (platform === 'gemini') return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  if (platform === 'claude') return 'https://api.anthropic.com/v1/messages';
  switch (platform) {
    case 'deepseek': return 'https://api.deepseek.com/v1/chat/completions';
    case 'grok': return 'https://api.x.ai/v1/chat/completions';
    case 'mistral': return 'https://api.mistral.ai/v1/chat/completions';
    case '9router': return 'http://localhost:20128/v1/chat/completions';
    case 'openrouter': return 'https://openrouter.ai/api/v1/chat/completions';
    default: return 'https://api.openai.com/v1/chat/completions';
  }
}

function responsesEndpoint(baseUrl?: string | null): string {
  const base = baseUrl?.replace(/\/+$/, '');
  if (!base) return 'https://api.openai.com/v1/responses';
  if (base.endsWith('/responses')) return base;
  const root = base.replace(/\/chat\/completions$/, '');
  return root.endsWith('/v1') ? `${root}/responses` : `${root}/v1/responses`;
}

function safeParseToolArgs(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function systemAndConversation(messages: AIProviderMessage[]) {
  const system = messages.filter(message => message.role === 'system').map(message => message.content.trim()).filter(Boolean).join('\n\n');
  const conversation = messages
    .filter(message => message.role !== 'system' && (message.content?.trim() || message.toolCalls?.length || message.role === 'tool'))
    .map(message => ({
      ...message,
      role: message.role === 'tool'
        ? 'tool'
        : (message.role === 'assistant' || message.role === 'model' ? 'assistant' : 'user'),
    }));
  return { system, conversation };
}

function asText(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => asText(item?.text ?? item?.content ?? item)).join('');
  if (value && typeof value === 'object') return asText(value.text ?? value.content ?? value.value ?? '');
  return '';
}

function usesGPT6Responses(platform: string, model: string): boolean {
  return platform === 'openai' && /^gpt-6(?:[.-]|$)/.test(model);
}

function responsesInput(messages: AIProviderMessage[]) {
  const items: any[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: message.toolCallId || `call_${items.length}`,
        output: message.content || '',
      });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      if (message.content?.trim()) {
        items.push({ role: 'assistant', content: message.content });
      }
      for (const tc of message.toolCalls) {
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments || {}),
        });
      }
      continue;
    }
    if (!message.content?.trim()) continue;
    items.push({
      // Responses uses developer messages for application-level instructions.
      role: message.role === 'system'
        ? 'developer'
        : (message.role === 'assistant' || message.role === 'model' ? 'assistant' : 'user'),
      content: message.content,
    });
  }
  return items;
}

function responsesText(response: any): string {
  if (typeof response?.output_text === 'string' && response.output_text) return response.output_text;
  return (response?.output || [])
    .filter((item: any) => item?.type === 'message')
    .flatMap((item: any) => item.content || [])
    .filter((part: any) => part?.type === 'output_text' || typeof part?.text === 'string')
    .map((part: any) => asText(part?.text))
    .join('');
}

function responsesToolCalls(response: any): AIToolCall[] {
  return (response?.output || [])
    .filter((item: any) => item?.type === 'function_call' && item?.name)
    .map((item: any, idx: number) => ({
      id: String(item.call_id || item.id || `fc_${Date.now()}_${idx}`),
      name: String(item.name),
      arguments: safeParseToolArgs(item.arguments),
    }));
}

function geminiPayload(messages: AIProviderMessage[], model: string, maxTokens: number, temperature: number, tools?: AIToolDefinition[]) {
  const { system, conversation } = systemAndConversation(messages);
  const contents: any[] = [];
  for (let i = 0; i < conversation.length; i++) {
    const message = conversation[i];
    if (message.role === 'tool') {
      const parts: any[] = [];
      let j = i;
      while (j < conversation.length && conversation[j].role === 'tool') {
        const tm = conversation[j];
        parts.push({
          functionResponse: {
            name: tm.toolName || 'tool',
            response: { result: tm.content },
          },
        });
        j++;
      }
      i = j - 1;
      contents.push({ role: 'user', parts });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const parts: any[] = [];
      if (message.content?.trim()) parts.push({ text: message.content });
      for (const tc of message.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments || {} } });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    });
  }
  // Gemini requires at least one user turn even for malformed/empty input.
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Xin chào' }] });
  const generationConfig: Record<string, any> = {
    maxOutputTokens: model.startsWith('gemini-3.') ? Math.max(1024, maxTokens) : maxTokens,
    temperature,
  };
  if (model.startsWith('gemini-3.')) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  const payload: Record<string, any> = {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig,
  };
  if (tools?.length) {
    payload.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }];
  }
  return payload;
}

function claudeMessages(conversation: AIProviderMessage[]): any[] {
  const out: any[] = [];
  for (let i = 0; i < conversation.length; i++) {
    const message = conversation[i];
    if (message.role === 'tool') {
      const blocks: any[] = [];
      let j = i;
      while (j < conversation.length && conversation[j].role === 'tool') {
        const tm = conversation[j];
        blocks.push({
          type: 'tool_result',
          tool_use_id: tm.toolCallId || `tool_${j}`,
          content: tm.content || '',
        });
        j++;
      }
      i = j - 1;
      out.push({ role: 'user', content: blocks });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const blocks: any[] = [];
      if (message.content?.trim()) blocks.push({ type: 'text', text: message.content });
      for (const tc of message.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments || {},
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content });
  }
  return out;
}

function openAIMessages(messages: AIProviderMessage[]): any[] {
  const out: any[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId || `call_${out.length}`,
        content: message.content || '',
      });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: message.content?.trim() ? message.content : null,
        tool_calls: message.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments || {}),
          },
        })),
      });
      continue;
    }
    if (!message.content?.trim()) continue;
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

async function executeCompletionRequest(request: AICompletionRequest, useTools: boolean): Promise<AICompletionResponse> {
  const platform = String(request.platform || 'openai').toLowerCase();
  const model = normalizeAIModel(platform, request.model);
  const maxTokens = Math.max(1, Math.floor(Number(request.maxTokens) || 500));
  const temperature = Number.isFinite(Number(request.temperature)) ? Number(request.temperature) : 0.7;
  const url = endpoint(platform, model, request.apiKey, request.baseUrl);
  const tools = useTools && request.tools?.length ? request.tools : undefined;

  if (platform === 'gemini') {
    const response = await axios.post(url, geminiPayload(request.messages, model, maxTokens, temperature, tools), {
      headers: { 'Content-Type': 'application/json' }, timeout: 90000,
    });
    const parts = response.data?.candidates?.[0]?.content?.parts || [];
    const result = parts.filter((part: any) => typeof part?.text === 'string').map((part: any) => asText(part?.text)).join('').trim();
    const toolCalls: AIToolCall[] = parts
      .filter((part: any) => part?.functionCall?.name)
      .map((part: any, idx: number) => ({
        id: `gemini_fc_${Date.now()}_${idx}`,
        name: String(part.functionCall.name),
        arguments: safeParseToolArgs(part.functionCall.args),
      }));
    const promptTokens = response.data?.usageMetadata?.promptTokenCount || 0;
    const completionTokens = response.data?.usageMetadata?.candidatesTokenCount || 0;
    return {
      result, model, promptTokens, completionTokens,
      totalTokens: response.data?.usageMetadata?.totalTokenCount || promptTokens + completionTokens,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }

  if (platform === 'claude') {
    const { system, conversation } = systemAndConversation(request.messages);
    const claude5 = /^(claude-(?:fable|opus|sonnet)-5)/.test(model);
    const body: Record<string, any> = {
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: claudeMessages(conversation),
      // Claude 5 rejects non-default sampling parameters.
      ...(!claude5 ? { temperature } : {}),
    };
    if (tools?.length) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    const response = await axios.post(url, body, {
      headers: { 'x-api-key': request.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      timeout: 90000,
    });
    const contentBlocks = response.data?.content || [];
    const result = contentBlocks.filter((part: any) => part?.type === 'text' || part?.text).map((part: any) => asText(part.text)).join('').trim();
    const toolCalls: AIToolCall[] = contentBlocks
      .filter((part: any) => part?.type === 'tool_use' && part?.name)
      .map((part: any, idx: number) => ({
        id: String(part.id || `claude_tu_${Date.now()}_${idx}`),
        name: String(part.name),
        arguments: safeParseToolArgs(part.input),
      }));
    const promptTokens = response.data?.usage?.input_tokens || 0;
    const completionTokens = response.data?.usage?.output_tokens || 0;
    return {
      result, model, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }

  if (usesGPT6Responses(platform, model)) {
    const body: Record<string, any> = {
      model,
      input: responsesInput(request.messages),
      // Responses requires at least 16 output tokens, even when a legacy
      // workflow saved a smaller maxTokens value.
      max_output_tokens: Math.max(16, maxTokens),
      // GPT-6 reasoning rejects sampling controls such as temperature. Omit
      // reasoning as well so the provider's documented model default applies.
    };
    if (tools?.length) {
      body.tools = tools.map(t => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    }
    const response = await axios.post(responsesEndpoint(request.baseUrl), body, {
      headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' }, timeout: 90000,
    });
    const promptTokens = response.data?.usage?.input_tokens || 0;
    const completionTokens = response.data?.usage?.output_tokens || 0;
    const toolCalls = responsesToolCalls(response.data);
    return {
      result: responsesText(response.data).trim(), model: response.data?.model || model,
      promptTokens, completionTokens, totalTokens: response.data?.usage?.total_tokens || promptTokens + completionTokens,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }

  const openAIRequest: Record<string, any> = {
    model,
    messages: openAIMessages(request.messages),
    ...(platform === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    // GPT-5.6 only accepts its default temperature.
    temperature: platform === 'openai' && model.startsWith('gpt-5.6-') ? 1 : temperature,
  };
  if (tools?.length) {
    openAIRequest.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    openAIRequest.tool_choice = 'auto';
  }
  // DeepSeek V4 uses the standard OpenAI-compatible request. Do not send its
  // obsolete thinking_mode field; its API rejects that legacy field.
  const response = await axios.post(url, openAIRequest, {
    headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' }, timeout: 90000,
  });
  const msg = response.data?.choices?.[0]?.message;
  const raw = msg?.content ?? response.data?.choices?.[0]?.text ?? response.data?.content ?? response.data?.response;
  const toolCalls: AIToolCall[] = Array.isArray(msg?.tool_calls)
    ? msg.tool_calls
        .filter((tc: any) => tc?.function?.name)
        .map((tc: any, idx: number) => ({
          id: String(tc.id || `oai_tc_${Date.now()}_${idx}`),
          name: String(tc.function.name),
          arguments: safeParseToolArgs(tc.function.arguments),
        }))
    : [];
  const promptTokens = response.data?.usage?.prompt_tokens || 0;
  const completionTokens = response.data?.usage?.completion_tokens || 0;
  return {
    result: asText(raw).trim(), model: response.data?.model || model, promptTokens, completionTokens,
    totalTokens: response.data?.usage?.total_tokens || promptTokens + completionTokens,
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

/** Provider-specific request and response adaptation shared by Assistants and Workflow. */
export async function requestAICompletion(request: AICompletionRequest): Promise<AICompletionResponse> {
  const hasTools = !!(request.tools && request.tools.length > 0);
  const hasToolMessages = request.messages.some(m => m.role === 'tool' || (m.toolCalls && m.toolCalls.length > 0));
  try {
    return await executeCompletionRequest(request, hasTools);
  } catch (err: any) {
    const status = err?.response?.status;
    // Fallback cleanly if a custom/proxy model rejects native `tools` on the first turn
    if (hasTools && !hasToolMessages && (status === 400 || status === 404 || status === 422)) {
      return await executeCompletionRequest({ ...request, tools: undefined }, false);
    }
    throw err;
  }
}
