import { extractSmsPayload } from './parser';
import type { SmsRelayFetchResponse, SmsRelayTarget } from './types';
import { isExtensionContextInvalidated } from '../../app/extension-context';

export type SmsPollResult =
  | {
      kind: 'code';
      target: SmsRelayTarget;
      code: string;
      message: string;
    }
  | {
      kind: 'empty';
      target: SmsRelayTarget;
      message: string;
    }
  | {
      kind: 'error';
      target: SmsRelayTarget;
      message: string;
    };

export async function fetchSmsRelayCode(target: SmsRelayTarget): Promise<SmsPollResult> {
  let response: SmsRelayFetchResponse;
  try {
    response = await browser.runtime.sendMessage({
      type: 'opx:fetch-sms-relay',
      url: target.url,
    });
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      return {
        kind: 'error',
        target,
        message: '插件已重新加载，请刷新当前页面',
      };
    }
    return {
      kind: 'error',
      target,
      message: `请求失败：${errorMessage(error)}`,
    };
  }

  if (!isSmsRelayFetchResponse(response) || !response.ok) {
    return {
      kind: 'error',
      target,
      message: response?.message || 'API 返回结果无效',
    };
  }

  const extracted = extractSmsPayload({
    raw: response.raw,
    data: response.data,
    text: response.text,
    message: response.message,
  });
  const message = extracted.message;
  const code = extracted.code;
  if (!code) {
    return {
      kind: 'empty',
      target,
      message: message || stringifyMessage(response.data) || response.message || '暂无短信',
    };
  }

  return {
    kind: 'code',
    target,
    code,
    message,
  };
}

function isSmsRelayFetchResponse(value: unknown): value is SmsRelayFetchResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as SmsRelayFetchResponse).ok === 'boolean' &&
      typeof (value as SmsRelayFetchResponse).message === 'string',
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringifyMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
