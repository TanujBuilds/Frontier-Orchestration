import { DeepSeekHttpAdapter, validModelId } from '../adapters/deepseek-http.mjs';
import { normalizeProviderCapabilities } from './provider-capabilities.mjs';
import { streamCompletion, redactStream, validCompletionMetadata } from './stream.mjs';

function failure(message, outcome, status) {
  const error = new Error(message);
  error.requestOutcome = outcome;
  if (status !== undefined) error.httpStatus = status;
  return error;
}

export class LocalProvider extends DeepSeekHttpAdapter {
  constructor({ streaming = false, capabilities, ...options } = {}) {
    super(options);
    if (typeof streaming !== 'boolean') throw failure(this.label + ' streaming must be boolean', 'not_dispatched');
    this.streaming = streaming;
    try {
      this.capabilities = normalizeProviderCapabilities(capabilities, streaming);
    } catch (error) {
      throw failure(this.redact(error.message), 'not_dispatched');
    }
  }

  async availability(signal) {
    const configured = this.resolvedModel ?? this.model;
    const ids = await this.listModels(signal, { strict: this.capabilities?.modelDiscovery === 'advertised' });
    if (configured && !ids.includes(configured)) throw Error('Configured provider model is unavailable');
    return true;
  }

  async complete(messages, { signal, maxTokens = 12000, onContent, expectedModel, onModel, streaming = this.streaming } = {}) {
    let model, payload;
    try {
      if (typeof streaming !== 'boolean') throw Error(this.label + ' streaming must be boolean');
      if (this.capabilities && !this.capabilities.transports.includes(streaming ? 'sse' : 'json')) {
        throw Error('Requested response mode is unsupported by API worker capabilities');
      }
      model = this.capabilities ? this.model : await this.resolveModel(signal);
      if (!validModelId(model) || this.containsCredential(model)) {
        throw Error('Invalid configured provider model identity');
      }
      if (expectedModel != null && model !== expectedModel) {
        throw Error('Resolved ' + this.label + ' model differs from pinned task model');
      }
      // A successful prior call does not prove the endpoint still advertises this model.
      if (this.capabilities?.modelDiscovery === 'advertised') {
        const ids = await this.listModels(signal, { strict: true });
        if (!ids.includes(model)) throw Error('Configured provider model is not advertised by /models');
      }
      payload = JSON.stringify({
        model, stream: streaming, max_tokens: maxTokens,
        ...(this.openAICompatible ? {} : { chat_template_kwargs: { enable_thinking: false } }),
        messages: this.redactData(messages),
      });
      onModel?.(model);
    } catch (error) {
      throw failure(this.redact(error?.message ?? 'Provider request could not be prepared'), 'not_dispatched', error?.httpStatus);
    }

    const capture = streaming && this.apiKey && onContent ? redactStream(this.apiKey, onContent) : null;
    let result;
    if (streaming) {
      result = await streamCompletion(this.chatUrl, payload, {
        signal, timeoutMs: this.timeoutMs, onContent: capture?.push ?? onContent,
        model, authHeaders: this.authHeaders, label: this.label,
      });
      capture?.finish();
    } else {
      const body = await this.request(this.chatUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
      }, signal);
      const choice = body?.choices?.[0];
      if (typeof choice?.message?.content !== 'string') {
        throw failure(this.label + ' returned no content', 'unknown');
      }
      result = {
        content: choice.message.content,
        model: body.model ?? model,
        usage: body.usage ?? null,
        finishReason: choice.finish_reason ?? null,
      };
      if (!validCompletionMetadata(result)) throw failure(this.label + ' returned invalid completion metadata', 'unknown');
    }

    try {
      if (this.apiKey) {
        result.content = this.redact(result.content);
        result.model = this.redact(result.model);
        result.usage = this.redactData(result.usage);
        result.finishReason = this.redactData(result.finishReason);
      }
      // A provider can report a dated model behind the selected alias.
      if (this.openAICompatible || this.capabilities) result.requestedModel = model;
      if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw Error('Provider result exceeds bound');
      return result;
    } catch (error) {
      throw failure(this.redact(error.message), 'unknown');
    }
  }
}
