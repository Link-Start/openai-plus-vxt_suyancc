import { loadAddressAutofillSettings, saveAddressAutofillSettings } from '../settings/state';
import type { AddressAutofillSettings } from '../settings/types';
import type { AddressProfile, RandomAddressResponse } from './types';

const LOG_PREFIX = '[OPX Pay Autofill]';
const PAYPAL_SELECTORS = [
  '[data-testid="paypal-accordion-item"]',
  '#payment-method-accordion-item-title-paypal',
  'button[data-testid="paypal-accordion-item-button"]',
  'button[aria-label*="PayPal"]',
  'button[aria-label*="paypal" i]',
];
const OPENAI_RANDOM_BUTTON_ID = 'opx-openai-pay-random-fill';
const AUTOCOMPLETE_DROPDOWN_SELECTOR = '.AutocompleteInput-dropdown-container';
const AUTOCOMPLETE_HIDE_STYLE_ID = 'opx-openai-pay-autocomplete-hide-style';
const MAX_AUTO_AUTOFILL_ATTEMPTS = 4;

interface StorageChangeValue {
  oldValue?: unknown;
  newValue?: unknown;
}

let initialized = false;
let running = false;
let scheduledTimer: number | null = null;
let pageAddress: AddressProfile | null = null;
let pageAddressScope = '';
let fillInFlight = false;
let filledAddressKey = '';
let autoAttemptCount = 0;
let autoAutofillFinished = false;

export function initPayOpenAiAddressAutofill(): void {
  if (initialized || location.hostname !== 'pay.openai.com') {
    return;
  }

  initialized = true;
  installStorageListener();
  installObserver();
  installAutocompleteHideStyle();
  installRandomFillButton();
  hideAutocompleteDropdowns();
  scheduleAutofill(800);
}

async function runAutofill(): Promise<void> {
  if (running || autoAutofillFinished || autoAttemptCount >= MAX_AUTO_AUTOFILL_ATTEMPTS) {
    return;
  }

  running = true;
  autoAttemptCount += 1;
  try {
    const settings = await loadAddressAutofillSettings();
    if (!settings.payOpenAiEnabled) {
      console.info(`${LOG_PREFIX} disabled`);
      return;
    }

    const address = await getPageAddress(settings);
    if (!address) {
      console.info(`${LOG_PREFIX} no address available`);
      return;
    }

    const result = await fillPayOpenAiAddressNow(address, { force: false });
    if (result.ok || filledAddressKey === createAddressKey(address)) {
      autoAutofillFinished = true;
      cancelScheduledAutofill();
    } else if (autoAttemptCount >= MAX_AUTO_AUTOFILL_ATTEMPTS) {
      autoAutofillFinished = true;
    }

    console.info(`${LOG_PREFIX} ${result.message}`, {
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      country: address.countryCode,
      source: address.source,
    });
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed`, error);
  } finally {
    running = false;
  }
}

export async function fillPayOpenAiAddressNow(
  address: AddressProfile,
  options: { force?: boolean } = { force: true },
): Promise<{ ok: boolean; filled: number; message: string }> {
  if (location.hostname !== 'pay.openai.com') {
    return { ok: false, filled: 0, message: '当前不是 pay.openai.com 页面' };
  }

  const addressKey = createAddressKey(address);
  if (!options.force && filledAddressKey === addressKey) {
    return { ok: true, filled: 0, message: 'OpenAI 支付页已填写过当前地址' };
  }

  if (fillInFlight) {
    return { ok: false, filled: 0, message: 'OpenAI 支付页正在填写，已跳过重复触发' };
  }

  fillInFlight = true;
  try {
    selectPaypalIfPresent();
    await delay(450);
    const filled = await fillCheckoutFields(address);
    if (filled > 0 || checkoutContainsAddressValues(address)) {
      filledAddressKey = addressKey;
    }
    hideAutocompleteDropdowns();
    return {
      ok: filled > 0 || filledAddressKey === addressKey,
      filled,
      message: filled > 0
        ? `已填写 OpenAI 支付页 ${filled} 项`
        : filledAddressKey === addressKey
          ? 'OpenAI 支付页已存在当前地址'
          : '未找到可填写的 OpenAI 支付字段',
    };
  } finally {
    fillInFlight = false;
  }
}

async function getPageAddress(settings: AddressAutofillSettings): Promise<AddressProfile | null> {
  const scope = `${settings.countryCode}|${settings.city}`;
  if (pageAddress && pageAddressScope === scope) {
    return pageAddress;
  }

  if (settings.lastAddress && addressMatchesScope(settings.lastAddress, settings)) {
    pageAddress = settings.lastAddress;
    pageAddressScope = scope;
    return pageAddress;
  }

  pageAddress = await fetchAndStoreAddress(settings);
  pageAddressScope = scope;
  return pageAddress;
}

async function fetchAndStoreAddress(settings: AddressAutofillSettings): Promise<AddressProfile | null> {
  const response = await browser.runtime.sendMessage({
    type: 'opx:fetch-random-address',
    countryCode: settings.countryCode,
    city: settings.city,
  });

  if (!isRandomAddressResponse(response) || !response.ok || !response.address) {
    console.warn(`${LOG_PREFIX} address fetch failed`, response);
    return null;
  }

  await saveAddressAutofillSettings({ lastAddress: response.address });
  return response.address;
}

async function fetchFreshAddressAndFill(button: HTMLButtonElement, status: HTMLElement): Promise<void> {
  cancelScheduledAutofill();
  autoAutofillFinished = true;
  button.disabled = true;
  button.textContent = '获取中...';
  Object.assign(button.style, {
    cursor: 'wait',
    opacity: '0.72',
  });
  status.textContent = '正在获取随机地址';

  try {
    const settings = await loadAddressAutofillSettings();
    const response = await browser.runtime.sendMessage({
      type: 'opx:fetch-random-address',
      countryCode: settings.countryCode,
      city: settings.city,
    });

    if (!isRandomAddressResponse(response) || !response.ok || !response.address) {
      status.textContent = response?.message || '获取失败';
      return;
    }

    pageAddress = response.address;
    pageAddressScope = `${settings.countryCode}|${settings.city}`;
    await saveAddressAutofillSettings({ lastAddress: response.address });
    const result = await fillPayOpenAiAddressNow(response.address, { force: true });
    status.textContent = result.ok ? `已输入 ${result.filled} 项` : result.message;
  } catch (error) {
    status.textContent = `失败：${errorMessage(error)}`;
  } finally {
    button.disabled = false;
    button.textContent = '随机地址';
    Object.assign(button.style, {
      cursor: 'pointer',
      opacity: '1',
    });
  }
}

async function fillCheckoutFields(address: AddressProfile): Promise<number> {
  let filled = 0;

  filled += fillInput('#billingName', address.fullName, true);
  filled += fillSelect('#billingCountry', address.countryCode, [address.countryLabel, address.countryCode]);

  if (document.querySelector('#billingCountry')) {
    await delay(550);
  }

  filled += fillInput('#billingAddressLine1', address.line1, true);
  filled += fillInput('#billingAddressLine2', address.line2, true);
  filled += fillInput('#billingLocality', address.city, true);
  filled += fillSelectOrInput('#billingAdministrativeArea', address.state, [address.stateFull, address.state]);
  filled += fillInput('#billingPostalCode', address.postalCode, true);
  filled += fillInput('#phoneNumber', address.phone, false);

  filled += fillByAutocomplete('billing address-line1', address.line1);
  filled += fillByAutocomplete('billing address-line2', address.line2);
  filled += fillByAutocomplete('billing address-level2', address.city);
  filled += fillByAutocomplete('billing postal-code', address.postalCode);
  filled += fillSelectOrInputByAutocomplete('billing address-level1', address.state, [address.stateFull, address.state]);
  filled += fillSelectByAutocomplete('billing country', address.countryCode, [address.countryLabel, address.countryCode]);
  filled += checkVisibleTermsCheckboxes();
  hideAutocompleteDropdowns();

  return filled;
}

function selectPaypalIfPresent(): boolean {
  const paypalRadio = document.querySelector<HTMLInputElement>('#payment-method-accordion-item-title-paypal');
  if (paypalRadio?.checked) {
    return true;
  }

  for (const selector of PAYPAL_SELECTORS) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element || !isVisible(element)) {
      continue;
    }
    clickElement(element);
    return true;
  }

  const textMatch = Array.from(document.querySelectorAll<HTMLElement>('button, label, [role="button"], [role="radio"], [data-testid], div'))
    .filter(isVisible)
    .find((element) => normalizedText(element.innerText || element.textContent).includes('paypal'));

  if (textMatch) {
    clickElement(textMatch);
    return true;
  }

  return false;
}

function fillInput(selector: string, value: string, overwrite: boolean): number {
  if (!value) {
    return 0;
  }
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!isTextControl(input) || !isVisible(input) || isSensitivePaymentField(input)) {
    return 0;
  }
  if (!overwrite && input.value.trim()) {
    return 0;
  }
  if (input.value === value) {
    return 0;
  }
  setNativeValue(input, value);
  return 1;
}

function fillByAutocomplete(autocomplete: string, value: string): number {
  const selector = `input[autocomplete="${cssEscape(autocomplete)}"], textarea[autocomplete="${cssEscape(autocomplete)}"]`;
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!isTextControl(input) || !isVisible(input) || input.value === value || isSensitivePaymentField(input)) {
    return 0;
  }
  setNativeValue(input, value);
  return 1;
}

function fillSelect(selector: string, preferredValue: string, preferredLabels: string[]): number {
  const select = document.querySelector<HTMLSelectElement>(selector);
  if (!isSelectControl(select) || !isVisible(select)) {
    return 0;
  }
  return setSelectOption(select, preferredValue, preferredLabels);
}

function fillSelectByAutocomplete(autocomplete: string, preferredValue: string, preferredLabels: string[]): number {
  const select = document.querySelector<HTMLSelectElement>(`select[autocomplete="${cssEscape(autocomplete)}"]`);
  if (!isSelectControl(select) || !isVisible(select)) {
    return 0;
  }
  return setSelectOption(select, preferredValue, preferredLabels);
}

function fillSelectOrInput(selector: string, preferredValue: string, preferredLabels: string[]): number {
  const element = document.querySelector(selector);
  if (isSelectControl(element)) {
    return isVisible(element) ? setSelectOption(element, preferredValue, preferredLabels) : 0;
  }
  if (isTextControl(element)) {
    return fillInput(selector, preferredValue, true);
  }
  return 0;
}

function fillSelectOrInputByAutocomplete(autocomplete: string, preferredValue: string, preferredLabels: string[]): number {
  const select = document.querySelector(`select[autocomplete="${cssEscape(autocomplete)}"]`);
  if (isSelectControl(select)) {
    return isVisible(select) ? setSelectOption(select, preferredValue, preferredLabels) : 0;
  }
  return fillByAutocomplete(autocomplete, preferredValue || preferredLabels[0] || '');
}

function setSelectOption(select: HTMLSelectElement, preferredValue: string, preferredLabels: string[]): number {
  const options = Array.from(select.options).filter((option) => !option.disabled && option.value);
  const normalizedPreferred = normalizedText(preferredValue);
  const labelNeedles = preferredLabels.map((label) => normalizedText(label)).filter(Boolean);
  const option = options.find((item) => normalizedText(item.value) === normalizedPreferred) ||
    options.find((item) => labelNeedles.some((needle) => normalizedText(`${item.text} ${item.value}`).includes(needle)));

  if (!option || select.value === option.value) {
    return 0;
  }

  select.value = option.value;
  emitChange(select);
  return 1;
}

function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  emitChange(input);
}

function checkoutContainsAddressValues(address: AddressProfile): boolean {
  const expectedValues = [
    address.fullName,
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postalCode,
  ].filter(Boolean);
  if (expectedValues.length === 0) {
    return false;
  }

  const values = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))
    .filter(isTextControl)
    .map((input) => normalizedText(input.value))
    .filter(Boolean);
  const matched = expectedValues.filter((value) => values.includes(normalizedText(value))).length;
  return matched >= Math.min(3, expectedValues.length);
}

function checkVisibleTermsCheckboxes(): number {
  let checked = 0;
  const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .filter(isVisible)
    .filter((checkbox) => !checkbox.checked)
    .filter((checkbox) => {
      const text = normalizedText([
        checkbox.id,
        checkbox.name,
        checkbox.getAttribute('aria-label'),
        checkbox.closest('label')?.textContent,
        checkbox.parentElement?.textContent,
      ].join(' '));
      return text.includes('terms') ||
        text.includes('consent') ||
        text.includes('使用条款') ||
        text.includes('隐私政策') ||
        text.includes('取消') ||
        checkbox.id === 'termsOfServiceConsentCheckbox';
    });

  for (const checkbox of checkboxes) {
    checkbox.click();
    checked += 1;
  }

  return checked;
}

function emitChange(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new Event('blur', { bubbles: true }));
}

function clickElement(element: HTMLElement): void {
  element.scrollIntoView({ block: 'center', inline: 'center' });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const EventCtor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    element.dispatchEvent(new EventCtor(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: type.endsWith('down') ? 1 : 0,
      pointerId: 1,
      pointerType: 'mouse',
    }));
  }
  element.click();
}

function installObserver(): void {
  const observer = new MutationObserver(() => {
    installRandomFillButton();
    hideAutocompleteDropdowns();
    if (!autoAutofillFinished && autoAttemptCount < MAX_AUTO_AUTOFILL_ATTEMPTS) {
      scheduleAutofill(250);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function installAutocompleteHideStyle(): void {
  if (document.getElementById(AUTOCOMPLETE_HIDE_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = AUTOCOMPLETE_HIDE_STYLE_ID;
  style.textContent = `
${AUTOCOMPLETE_DROPDOWN_SELECTOR} {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;
  document.documentElement.append(style);
}

function hideAutocompleteDropdowns(): void {
  for (const element of document.querySelectorAll<HTMLElement>(AUTOCOMPLETE_DROPDOWN_SELECTOR)) {
    element.style.setProperty('display', 'none', 'important');
    element.style.setProperty('visibility', 'hidden', 'important');
    element.style.setProperty('pointer-events', 'none', 'important');
  }
}

function installRandomFillButton(): void {
  if (document.getElementById(OPENAI_RANDOM_BUTTON_ID)) {
    return;
  }

  const heading = findPaymentMethodHeading();
  if (!heading?.parentElement) {
    return;
  }

  const target = findPaymentMethodButtonTarget(heading);
  const wrapper = document.createElement('span');
  wrapper.id = OPENAI_RANDOM_BUTTON_ID;
  wrapper.setAttribute('data-opx-openai-random-fill', '1');
  Object.assign(wrapper.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    marginLeft: '10px',
    verticalAlign: 'middle',
  });

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '随机地址';
  Object.assign(button.style, {
    appearance: 'none',
    border: '0',
    borderRadius: '6px',
    background: '#10b981',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: '700',
    lineHeight: '1',
    minHeight: '28px',
    padding: '0 12px',
    whiteSpace: 'nowrap',
  });

  const status = document.createElement('span');
  Object.assign(status.style, {
    color: '#64748b',
    fontSize: '12px',
    lineHeight: '16px',
    minWidth: '0',
    whiteSpace: 'nowrap',
  });

  button.addEventListener('click', () => {
    void fetchFreshAddressAndFill(button, status);
  });

  wrapper.append(button, status);
  target.append(wrapper);
}

function findPaymentMethodHeading(): HTMLElement | null {
  const exact = document.querySelector<HTMLElement>('.PaymentMethod-Heading');
  if (exact && isVisible(exact)) {
    return exact;
  }

  return Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, div, span'))
    .filter(isVisible)
    .find((element) => {
      const text = normalizedText(element.textContent);
      return text === '支付方式' || text === 'payment method' || text === 'payment methods';
    }) || null;
}

function findPaymentMethodButtonTarget(heading: HTMLElement): HTMLElement {
  const container = heading.closest<HTMLElement>('.flex-item.width-12') ||
    heading.parentElement ||
    heading;
  Object.assign(container.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '0',
    flexWrap: 'wrap',
  });
  Object.assign(heading.style, {
    marginRight: '0',
  });
  return container;
}

function createAddressKey(address: AddressProfile): string {
  return [
    address.id,
    address.fullName,
    address.countryCode,
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postalCode,
    address.phone,
  ].join('|');
}

function installStorageListener(): void {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }

    if (hasAddressScopeChange(changes)) {
      resetAutofillStateForScopeChange();
      scheduleAutofill(100);
    }
  });
}

function hasAddressScopeChange(changes: Record<string, StorageChangeValue>): boolean {
  for (const change of Object.values(changes)) {
    const oldSettings = normalizeAddressSettingsChangeValue(change.oldValue);
    const newSettings = normalizeAddressSettingsChangeValue(change.newValue);
    if (!oldSettings || !newSettings) {
      continue;
    }

    if (
      oldSettings.payOpenAiEnabled !== newSettings.payOpenAiEnabled ||
      oldSettings.countryCode !== newSettings.countryCode ||
      oldSettings.city !== newSettings.city
    ) {
      return true;
    }
  }
  return false;
}

function resetAutofillStateForScopeChange(): void {
  pageAddress = null;
  pageAddressScope = '';
  filledAddressKey = '';
  autoAttemptCount = 0;
  autoAutofillFinished = false;
}

function normalizeAddressSettingsChangeValue(value: unknown): Pick<AddressAutofillSettings, 'payOpenAiEnabled' | 'countryCode' | 'city'> | null {
  if (!isRecord(value)) {
    return null;
  }
  const source = isRecord(value.addressAutofill) ? value.addressAutofill : value;
  if (!('payOpenAiEnabled' in source) && !('countryCode' in source) && !('city' in source)) {
    return null;
  }
  return {
    payOpenAiEnabled: Boolean(source.payOpenAiEnabled),
    countryCode: String(source.countryCode || '').trim(),
    city: String(source.city || '').trim(),
  };
}

function addressMatchesScope(address: AddressProfile, settings: AddressAutofillSettings): boolean {
  const countryMatches = settings.countryCode === 'RANDOM' || address.countryCode === settings.countryCode;
  const city = settings.city.trim().toLowerCase();
  const cityMatches = !city || address.city.toLowerCase() === city;
  return countryMatches && cityMatches;
}

function scheduleAutofill(delayMs: number): void {
  if (scheduledTimer) {
    window.clearTimeout(scheduledTimer);
  }
  scheduledTimer = window.setTimeout(() => {
    scheduledTimer = null;
    void runAutofill();
  }, delayMs);
}

function cancelScheduledAutofill(): void {
  if (scheduledTimer) {
    window.clearTimeout(scheduledTimer);
    scheduledTimer = null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function isVisible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  if ('disabled' in htmlElement && Boolean((htmlElement as HTMLInputElement).disabled)) {
    return false;
  }
  const style = window.getComputedStyle(htmlElement);
  const rect = htmlElement.getBoundingClientRect();
  return style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    rect.width > 0 &&
    rect.height > 0;
}

function isSensitivePaymentField(element: Element): boolean {
  const haystack = normalizedText([
    element.getAttribute('aria-label'),
    element.getAttribute('placeholder'),
    element.getAttribute('autocomplete'),
    element.getAttribute('name'),
    element.getAttribute('id'),
  ].join(' '));

  return [
    'cc-number',
    'card number',
    'credit card',
    'security code',
    'cvc',
    'cvv',
    'expiry',
    'expiration',
  ].some((needle) => haystack.includes(needle));
}

function isTextControl(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  return Boolean(element && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement));
}

function isSelectControl(element: Element | null): element is HTMLSelectElement {
  return Boolean(element && element instanceof HTMLSelectElement);
}

function normalizedText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRandomAddressResponse(value: unknown): value is RandomAddressResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as RandomAddressResponse).ok === 'boolean' &&
      typeof (value as RandomAddressResponse).message === 'string',
  );
}
