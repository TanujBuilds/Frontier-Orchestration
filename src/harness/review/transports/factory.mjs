import {OpenAIChatReviewer} from './openai-chat.mjs';
import {OpenAIResponsesReviewer} from './openai-responses.mjs';
import {AnthropicMessagesReviewer} from './anthropic-messages.mjs';
import {fail} from './common.mjs';
const factories={'openai-chat':OpenAIChatReviewer,'openai-responses':OpenAIResponsesReviewer,'anthropic-messages':AnthropicMessagesReviewer};
export function createReviewTransport(options){const factory=factories[options?.profile?.transport];if(!factory)throw fail('Unsupported reviewer transport','not_dispatched');return factory(options);}
