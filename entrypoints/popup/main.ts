import './style.css';

const CHATGPT_URL = 'https://chatgpt.com/';

document.querySelector<HTMLButtonElement>('#open-chatgpt')?.addEventListener('click', async () => {
  await browser.tabs.create({ url: CHATGPT_URL });
  window.close();
});
