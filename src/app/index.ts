import { createRegisterController } from '../features/register/controller';
import { createPanel } from './panel';

const ROOT_ID = 'opx-assistant-root';
const ROOT_Z_INDEX = '2147483647';

export function mountAssistant(): void {
  if (document.getElementById(ROOT_ID)) {
    return;
  }

  const host = document.createElement('div');
  host.id = ROOT_ID;
  applyHostStyle(host);
  document.documentElement.append(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const registerController = createRegisterController();
  createPanel(shadow, registerController);
  window.setInterval(() => applyHostStyle(host), 1000);
  void registerController.autoRunForCurrentPage();
}

function applyHostStyle(host: HTMLElement): void {
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('inset', '0', 'important');
  host.style.setProperty('width', '0', 'important');
  host.style.setProperty('height', '0', 'important');
  host.style.setProperty('z-index', ROOT_Z_INDEX, 'important');
  host.style.setProperty('pointer-events', 'none', 'important');
  host.style.setProperty('isolation', 'isolate', 'important');
  host.style.setProperty('display', 'block', 'important');
}
