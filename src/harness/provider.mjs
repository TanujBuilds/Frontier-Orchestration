import { DeepSeekHttpAdapter, validModelId } from '../adapters/deepseek-http.mjs';
import { normalizeProviderCapabilities } from './provider-capabilities.mjs';
import { streamCompletion, redactStream, validCompletionMetadata } from './stream.mjs';
import { providedRetryHint } from '../adapters/retry-after.mjs';

function failure(message, outcome, status, details = {}) {
  const error = new Error(message);
  error.requestOutcome = outcome;
  if (Number.isInteger(status) && status >= 300 && status <= 599) error.httpStatus = status;
  const observed = details.observedHttpStatus ?? status;
  if (Number.isInteger(observed) && observed >= 200 && observed < 300) error.observedHttpStatus = observed;
  if (['model_not_found','context_length_exceeded'].includes(details.providerErrorCode)) error.providerErrorCode = details.providerErrorCode;
  if (['address','tls','connection','timeout','cancelled','protocol','model_not_advertised'].includes(details.diagnosticCategory)) error.diagnosticCategory = details.diagnosticCategory;
  if (['model_discovery','inference'].includes(details.requestOperation)) error.requestOperation = details.requestOperation;
  const retryHint = providedRetryHint(details);
  if (retryHint) error.retryHint = retryHint;
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
    if (this.capabilities?.modelDiscovery === 'manual') {
      if (!validModelId(this.model) || this.containsCredential(this.model)) throw failure('Invalid configured provider model identity', 'not_dispatched');
      // Eligibility for the next authorized attempt, never a health claim.
      return true;
    }
    const ids = await this.listModels(signal, { strict: this.capabilities?.modelDiscovery === 'advertised' });
    if (configured && !ids.includes(configured)) throw Error('Configured provider model is unavailable');
    return true;
  }

  async complete(messages, { signal, maxTokens = 12000, onContent, expectedModel, onModel, beforeRequest, streaming = this.streaming } = {}) {
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
        if (!ids.includes(model)) throw failure('Configured provider model is not advertised by /models','not_dispatched',undefined,{diagnosticCategory:'model_not_advertised',requestOperation:'model_discovery'});
      }
      const tokenLimitField=this.openAICompatible&&this.chatUrl.href==='https://api.openai.com/v1/chat/completions'
        ? 'max_completion_tokens' : 'max_tokens';
      payload = JSON.stringify({
        model, stream: streaming, [tokenLimitField]: maxTokens,
        ...(this.openAICompatible ? {} : { chat_template_kwargs: { enable_thinking: false } }),
        messages: this.redactData(messages),
      });
      // Setup's snapshot guard must run after the asynchronous advertised-model
      // preflight. The final runtime ownership check must remain uninterrupted
      // from onModel through dispatch, including when no setup guard is present.
      if(beforeRequest)await beforeRequest();
      onModel?.(model);
    } catch (error) {
      throw failure(this.redact(error?.message ?? 'Provider request could not be prepared'), 'not_dispatched', error?.httpStatus, error);
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
        throw failure(this.label + ' returned no content', 'unknown',undefined,{diagnosticCategory:'protocol',requestOperation:'inference'});
      }
      result = {
        content: choice.message.content,
        model: body.model ?? model,
        usage: body.usage ?? null,
        finishReason: choice.finish_reason ?? null,
      };
      if (!validCompletionMetadata(result)) throw failure(this.label + ' returned invalid completion metadata', 'unknown',undefined,{diagnosticCategory:'protocol',requestOperation:'inference'});
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
