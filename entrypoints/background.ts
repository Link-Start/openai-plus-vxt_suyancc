import { fetchRandomAddress } from '../src/features/address-autofill/address-source';
import type { RandomAddressMessage } from '../src/features/address-autofill/types';
import { createCheckoutLink } from '../src/features/link-extractor/checkout';
import { fetchChatGptSession } from '../src/features/link-extractor/session';
import type { ChatGptSessionMessage, CheckoutLinkMessage } from '../src/features/link-extractor/types';
import type {
  OutlookApiCheckMessage,
  OutlookOtpCancelMessage,
  OutlookOtpMessage,
  OutlookOtpResponse,
} from '../src/features/register/types';
import type { SmsRelayFetchMessage, SmsRelayFetchResponse } from '../src/features/sms/types';

const DEFAULT_OUTLOOK_API_BASE = 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_INTERVAL_MS = 5_000;
const ASSISTANT_SCRIPT_FILE = '/content-scripts/content.js';
const ASSISTANT_URL_PREFIXES = [
  'https://chatgpt.com/',
  'https://auth.openai.com/',
  'https://pay.openai.com/',
  'https://www.paypal.com/',
  'https://paypal.com/',
];
const outlookOtpAborters = new Map<string, AbortController>();

export default defineBackground(() => {
  installAssistantInjector();

  browser.runtime.onMessage.addListener((message: unknown) => {
    if (isOutlookOtpMessage(message)) {
      return waitForOutlookOtp(message);
    }
    if (isOutlookOtpCancelMessage(message)) {
      return cancelOutlookOtp(message);
    }
    if (isOutlookApiCheckMessage(message)) {
      return checkOutlookApi(message);
    }

    if (isCheckoutLinkMessage(message)) {
      return createCheckoutLink(message.raw, message.options);
    }
    if (isChatGptSessionMessage(message)) {
      return fetchChatGptSession();
    }
    if (isRandomAddressMessage(message)) {
      return fetchRandomAddress(message.countryCode, message.city);
    }
    if (isSmsRelayFetchMessage(message)) {
      return fetchSmsRelay(message.url);
    }
    return undefined;
  });
});

function installAssistantInjector(): void {
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !isAssistantUrl(tab.url)) {
      return;
    }
    setTimeout(() => void injectAssistant(tabId), 300);
  });

  void browser.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id === 'number' && isAssistantUrl(tab.url)) {
        void injectAssistant(tab.id);
      }
    }
  }).catch((error) => {
    console.debug('[OPX] initial assistant injection skipped', error);
  });
}

async function injectAssistant(tabId: number): Promise<void> {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: [ASSISTANT_SCRIPT_FILE],
    });
  } catch (error) {
    console.debug('[OPX] assistant injection skipped', { tabId, error });
  }
}

function isAssistantUrl(url: string | undefined): boolean {
  return ASSISTANT_URL_PREFIXES.some((prefix) => url?.startsWith(prefix));
}

async function waitForOutlookOtp(message: OutlookOtpMessage): Promise<OutlookOtpResponse> {
  const jobId = message.jobId || makeOutlookJobId();
  const startedAt = message.since ?? Date.now();
  const deadline = Date.now() + (message.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const intervalMs = message.intervalMs ?? DEFAULT_INTERVAL_MS;
  const apiBase = normalizeApiBase(message.apiBase || DEFAULT_OUTLOOK_API_BASE);
  const aborter = new AbortController();
  outlookOtpAborters.set(jobId, aborter);

  try {
    while (Date.now() <= deadline) {
      if (aborter.signal.aborted) {
        return {
          ok: false,
          canceled: true,
          message: '已停止 Outlook 验证码接收',
        };
      }
      const result = await fetchLatestOtp(apiBase, message.accountLine, startedAt, aborter.signal);
      if (result.ok && result.code) {
        return result;
      }
      if (!result.ok && result.fatal) {
        return result;
      }
      await delay(intervalMs, aborter.signal);
    }

    return {
      ok: false,
      message: '等待 Outlook 验证码超时',
    };
  } finally {
    if (outlookOtpAborters.get(jobId) === aborter) {
      outlookOtpAborters.delete(jobId);
    }
  }
}

function cancelOutlookOtp(message: OutlookOtpCancelMessage): OutlookOtpResponse {
  let canceled = false;
  if (message.jobId) {
    const aborter = outlookOtpAborters.get(message.jobId);
    if (aborter) {
      aborter.abort();
      outlookOtpAborters.delete(message.jobId);
      canceled = true;
    }
  } else {
    for (const aborter of outlookOtpAborters.values()) {
      aborter.abort();
      canceled = true;
    }
    outlookOtpAborters.clear();
  }
  return {
    ok: true,
    canceled,
    message: canceled ? '已发送停止接收验证码指令' : '当前没有正在接收的 Outlook 验证码任务',
  };
}

async function checkOutlookApi(message: OutlookApiCheckMessage): Promise<OutlookOtpResponse> {
  const apiBase = normalizeApiBase(message.apiBase || DEFAULT_OUTLOOK_API_BASE);
  let response: Response;
  try {
    response = await fetch(`${apiBase}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(1800),
    });
  } catch (error) {
    return {
      ok: false,
      message: `本地 Outlook 服务未连接：${String(error)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `本地 Outlook 服务异常：HTTP ${response.status}`,
    };
  }
  return {
    ok: true,
    message: '本地 Outlook 服务已启动',
  };
}

async function fetchLatestOtp(
  apiBase: string,
  accountLine: string,
  startedAt: number,
  signal?: AbortSignal,
): Promise<OutlookOtpResponse & { fatal?: boolean }> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/outlook/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_line: accountLine,
        limit: 10,
        mailbox: 'default',
        query: 'OpenAI',
        unseen_only: false,
        mark_seen: false,
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      return {
        ok: false,
        fatal: true,
        canceled: true,
        message: '已停止 Outlook 验证码接收',
      };
    }
    return {
      ok: false,
      fatal: true,
      message: `无法连接 Outlook 本地 API：${String(error)}`,
    };
  }

  if (!response.ok) {
    const detail = await readResponseDetail(response);
    return {
      ok: false,
      fatal: true,
      message: `Outlook API 返回 ${response.status}：${detail}`,
    };
  }

  const payload = await response.json() as OutlookFetchPayload;
  const startedAtSeconds = startedAt / 1000;
  const messages = [...(payload.messages || [])].sort(
    (a, b) => Number(b.received_at || 0) - Number(a.received_at || 0),
  );

  const fresh = messages.find((item) => {
    if (!item.otp) {
      return false;
    }
    const receivedAt = Number(item.received_at || 0);
    return !receivedAt || receivedAt >= startedAtSeconds - 15;
  });

  if (!fresh?.otp) {
    return {
      ok: false,
      message: '暂未收到新的 Outlook 验证码',
    };
  }

  return {
    ok: true,
    code: fresh.otp,
    message: `收到验证码：${fresh.otp}`,
  };
}

function isOutlookOtpMessage(message: unknown): message is OutlookOtpMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as OutlookOtpMessage).type === 'opx:wait-outlook-otp' &&
      typeof (message as OutlookOtpMessage).accountLine === 'string',
  );
}

function isOutlookOtpCancelMessage(message: unknown): message is OutlookOtpCancelMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as OutlookOtpCancelMessage).type === 'opx:cancel-outlook-otp',
  );
}

function isOutlookApiCheckMessage(message: unknown): message is OutlookApiCheckMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as OutlookApiCheckMessage).type === 'opx:check-outlook-api',
  );
}

function isCheckoutLinkMessage(message: unknown): message is CheckoutLinkMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as CheckoutLinkMessage).type === 'opx:create-checkout-link' &&
      typeof (message as CheckoutLinkMessage).raw === 'string' &&
      typeof (message as CheckoutLinkMessage).options === 'object',
  );
}

function isChatGptSessionMessage(message: unknown): message is ChatGptSessionMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as ChatGptSessionMessage).type === 'opx:fetch-chatgpt-session',
  );
}

function isRandomAddressMessage(message: unknown): message is RandomAddressMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (
        (message as RandomAddressMessage).type === 'opx:fetch-random-address' ||
        (message as RandomAddressMessage).type === 'opx:fetch-random-us-address'
      ),
  );
}

function isSmsRelayFetchMessage(message: unknown): message is SmsRelayFetchMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as SmsRelayFetchMessage).type === 'opx:fetch-sms-relay' &&
      typeof (message as SmsRelayFetchMessage).url === 'string',
  );
}

async function fetchSmsRelay(url: string): Promise<SmsRelayFetchResponse> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        ok: false,
        message: '接码 API 只支持 http/https 链接',
      };
    }
  } catch {
    return {
      ok: false,
      message: '接码 API 链接格式无效',
    };
  }

  let response: Response;
  try {
    response = await fetch(parsedUrl.toString(), {
      method: 'GET',
      cache: 'no-store',
    });
  } catch (error) {
    return {
      ok: false,
      message: `接码 API 请求失败：${String(error)}`,
    };
  }

  const status = response.status;
  const { parsed: detail, text } = await readSmsRelayResponse(response);
  if (!response.ok) {
    return {
      ok: false,
      status,
      message: `接码 API 返回 ${status}：${text || response.statusText}`,
      text,
      raw: detail,
    };
  }

  if (isRecord(detail)) {
    const data = detail.data;
    const message = String(detail.msg || detail.message || 'OK');
    return {
      ok: isSmsRelaySuccessPayload(detail),
      status,
      message,
      data,
      text,
      raw: detail,
    };
  }

  return {
    ok: true,
    status,
    message: 'OK',
    data: String(detail || '').trim(),
    text,
    raw: detail,
  };
}

async function readSmsRelayResponse(response: Response): Promise<{ parsed: unknown; text: string }> {
  const text = await response.text();
  if (!text) {
    return { parsed: '', text: '' };
  }
  try {
    return { parsed: JSON.parse(text), text };
  } catch {
    return { parsed: text, text };
  }
}

function normalizeApiBase(value: string): string {
  return value.replace(/\/+$/, '');
}

async function readResponseDetail(response: Response): Promise<string> {
  try {
    const data = await response.json() as { detail?: string };
    return data.detail || response.statusText;
  } catch {
    return response.statusText;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function makeOutlookJobId(): string {
  return `outlook-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function isSmsRelaySuccessPayload(value: Record<string, unknown>): boolean {
  if (typeof value.success === 'boolean') {
    return value.success;
  }
  if (typeof value.ok === 'boolean') {
    return value.ok;
  }

  const codeValue = value.code ?? value.status ?? value.statusCode;
  if (codeValue === undefined || codeValue === null || codeValue === '') {
    return true;
  }

  const code = Number(codeValue);
  if (Number.isNaN(code)) {
    return true;
  }
  return code === 0 || code === 1 || code === 200;
}

interface OutlookFetchPayload {
  messages?: Array<{
    otp?: string;
    received_at?: number;
  }>;
}
