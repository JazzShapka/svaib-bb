import { spawn } from 'node:child_process';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { browserContract } from './browser-contract';

// The authorization URL never passes through a model, terminal or saved thread.
export default experimental_defineHostEntry({ contract: browserContract, handlers: {
  async openLogin({ url }) {
    const configured = process.env.BROWSER;
    const executable = configured && !/\s/.test(configured) ? configured
      : process.platform === 'darwin' ? '/usr/bin/open'
      : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' && executable === 'rundll32.exe' ? ['url.dll,FileProtocolHandler', url] : [url];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { detached: true, stdio: 'ignore', shell: false });
      child.once('error', () => reject(new Error('Не удалось открыть браузер для входа.')));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return null;
  },
} });
