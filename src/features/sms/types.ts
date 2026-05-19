export interface SmsRelayTarget {
  id: string;
  phone: string;
  url: string;
}

export interface SmsCodeRecord {
  id: string;
  phone: string;
  code: string;
  message: string;
  receivedAt: number;
}

export interface SmsRelayState {
  rawInput: string;
  history: SmsCodeRecord[];
  updatedAt: number;
}

export interface SmsRelayFetchMessage {
  type: 'opx:fetch-sms-relay';
  url: string;
}

export interface SmsRelayFetchResponse {
  ok: boolean;
  message: string;
  data?: unknown;
  status?: number;
  text?: string;
  raw?: unknown;
}
