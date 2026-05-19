import type { ActionResult } from './types';

const NAME_SELECTORS = [
  'input[name="name"]',
  'input[name="fullName"]',
  'input[autocomplete="name"]',
  'input[type="text"]',
];

const AGE_SELECTORS = [
  'input[name="age"]',
  'input[inputmode="numeric"]',
  'input[type="number"]',
  'input[type="text"]',
];

const FIRST_NAMES = [
  'Arlen',
  'Brennan',
  'Calvin',
  'Darian',
  'Elliot',
  'Finley',
  'Gavin',
  'Harlan',
  'Jasper',
  'Kieran',
  'Landon',
  'Morgan',
  'Nolan',
  'Parker',
  'Rowan',
  'Sawyer',
  'Tristan',
  'Warren',
];

export function isAboutYouPage(): boolean {
  return location.hostname === 'auth.openai.com' && location.pathname.startsWith('/about-you');
}

export async function fillAboutYouAndCreate(): Promise<ActionResult> {
  const nameInput = findNameInput();
  const ageInput = findAgeInput(nameInput);

  if (!nameInput) {
    return fail('没有找到全名输入框');
  }
  if (!ageInput) {
    return fail('没有找到年龄输入框');
  }

  const name = randomName();
  const age = String(randomInt(25, 55));

  setNativeValue(nameInput, name);
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  nameInput.dispatchEvent(new Event('change', { bubbles: true }));

  setNativeValue(ageInput, age);
  ageInput.dispatchEvent(new Event('input', { bubbles: true }));
  ageInput.dispatchEvent(new Event('change', { bubbles: true }));

  await waitForUiTick();
  const checkboxResult = await checkVisibleCheckboxes();
  if (!checkboxResult.ok) {
    return fail(checkboxResult.message);
  }
  if (checkboxResult.checked > 0) {
    await waitForUiTick();
  }

  const button = findCreateButton();
  if (!button) {
    return fail('没有找到完成账户创建按钮');
  }

  if (button.disabled) {
    await waitForEnabled(button, 2500);
  }

  if (button.disabled) {
    return fail('完成账户创建按钮仍然不可点击');
  }

  button.click();
  return ok(checkboxResult.checked > 0
    ? `已填写 ${name} / ${age}，已勾选 ${checkboxResult.checked} 个选项并点击创建`
    : `已填写 ${name} / ${age} 并点击创建`);
}

function findNameInput(): HTMLInputElement | null {
  const byLabel = findInputByText(['全名', '名字', 'name', 'full name']);
  if (byLabel) {
    return byLabel;
  }

  for (const selector of NAME_SELECTORS) {
    const input = document.querySelector<HTMLInputElement>(selector);
    if (input && !looksLikeAgeInput(input)) {
      return input;
    }
  }

  return textInputs().find((input) => !looksLikeAgeInput(input)) ?? null;
}

function findAgeInput(nameInput: HTMLInputElement | null): HTMLInputElement | null {
  const byLabel = findInputByText(['年龄', 'age']);
  if (byLabel && byLabel !== nameInput) {
    return byLabel;
  }

  for (const selector of AGE_SELECTORS) {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(selector));
    const input = inputs.find((item) => item !== nameInput && looksLikeAgeInput(item));
    if (input) {
      return input;
    }
  }

  return textInputs().find((input) => input !== nameInput) ?? null;
}

function findInputByText(keys: string[]): HTMLInputElement | null {
  const inputs = textInputs();
  for (const input of inputs) {
    const haystack = [
      input.name,
      input.id,
      input.placeholder,
      input.ariaLabel,
      input.getAttribute('aria-labelledby') ? labelText(input.getAttribute('aria-labelledby') || '') : '',
      input.closest('label')?.textContent || '',
      input.parentElement?.textContent || '',
    ].join(' ').toLowerCase();

    if (keys.some((key) => haystack.includes(key.toLowerCase()))) {
      return input;
    }
  }
  return null;
}

function labelText(ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent || '')
    .join(' ');
}

function textInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter((input) => {
    const type = (input.type || 'text').toLowerCase();
    return ['text', 'number', 'tel', ''].includes(type);
  });
}

function looksLikeAgeInput(input: HTMLInputElement): boolean {
  const text = [
    input.name,
    input.id,
    input.placeholder,
    input.ariaLabel,
    input.inputMode,
    input.type,
    input.parentElement?.textContent || '',
  ].join(' ').toLowerCase();
  return text.includes('age') || text.includes('年龄') || text.includes('numeric') || input.type === 'number';
}

function findCreateButton(): HTMLButtonElement | null {
  const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) {
    return submit;
  }

  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => {
    const text = (button.textContent || '').trim().toLowerCase();
    return (
      text.includes('完成帐户创建') ||
      text.includes('完成账户创建') ||
      text.includes('create account') ||
      text.includes('continue')
    );
  }) ?? null;
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
}

async function checkVisibleCheckboxes(): Promise<{ ok: boolean; checked: number; message: string }> {
  let checked = 0;
  const checkboxes = [
    ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="allCheckboxes"]'),
    ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([name="allCheckboxes"])'),
  ]
    .filter((checkbox) => !checkbox.checked && !checkbox.disabled && isCheckboxReachable(checkbox));

  for (const checkbox of checkboxes) {
    if (await checkCheckbox(checkbox)) {
      checked += 1;
      continue;
    }
    if (checkbox.name === 'allCheckboxes') {
      return { ok: false, checked, message: '没有成功勾选“我同意以下所有各项”' };
    }
  }

  return { ok: true, checked, message: '' };
}

async function checkCheckbox(checkbox: HTMLInputElement): Promise<boolean> {
  const label = findCheckboxLabel(checkbox);
  const targets = [
    label,
    checkbox,
    label?.querySelector<HTMLElement>('span, div'),
  ].filter((target): target is HTMLElement => Boolean(target));

  for (const target of targets) {
    clickElement(target);
    await waitForChecked(checkbox, 350);
    if (checkbox.checked) {
      return true;
    }
  }

  if (!checkbox.checked) {
    setNativeChecked(checkbox, true);
    checkbox.dispatchEvent(new Event('input', { bubbles: true }));
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await waitForChecked(checkbox, 350);
  }

  return checkbox.checked;
}

function setNativeChecked(input: HTMLInputElement, checked: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
  if (descriptor?.set) {
    descriptor.set.call(input, checked);
  } else {
    input.checked = checked;
  }
}

function findCheckboxLabel(checkbox: HTMLInputElement): HTMLLabelElement | null {
  const closestLabel = checkbox.closest<HTMLLabelElement>('label');
  if (closestLabel) {
    return closestLabel;
  }
  if (!checkbox.id) {
    return null;
  }
  return document.querySelector<HTMLLabelElement>(`label[for="${cssEscape(checkbox.id)}"]`);
}

function isCheckboxReachable(checkbox: HTMLInputElement): boolean {
  return isVisible(checkbox) || Boolean(findCheckboxLabel(checkbox) && isVisible(findCheckboxLabel(checkbox) as HTMLElement));
}

function isVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    rect.width > 0 &&
    rect.height > 0;
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

function waitForChecked(checkbox: HTMLInputElement, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (checkbox.checked || Date.now() - started >= timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(check, 40);
    };
    check();
  });
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}

function waitForUiTick(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 80));
}

function waitForEnabled(button: HTMLButtonElement, timeoutMs: number): Promise<void> {
  const started = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      if (!button.disabled || Date.now() - started >= timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(check, 100);
    };
    check();
  });
}

function randomName(): string {
  return FIRST_NAMES[randomInt(0, FIRST_NAMES.length - 1)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function ok(message: string): ActionResult {
  return { ok: true, message };
}

function fail(message: string): ActionResult {
  return { ok: false, message };
}
