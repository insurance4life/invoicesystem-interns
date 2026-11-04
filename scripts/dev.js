// Runs the Django API (runserver with auto-reload, port 4000) and the Vite dev server (port 5173) together.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const python = process.env.PYTHON || (isWin ? 'python' : 'python3');
const npm = isWin ? 'npm.cmd' : 'npm';
const procs = [
  spawn(python, ['manage.py', 'runserver', '127.0.0.1:4000'], { cwd: path.join(root, 'backend'), stdio: 'inherit', shell: isWin }),
  spawn(npm, ['run', 'dev'], { cwd: path.join(root, 'client'), stdio: 'inherit', shell: isWin }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) stop(); });
